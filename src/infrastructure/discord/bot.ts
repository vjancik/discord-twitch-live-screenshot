import {
	AttachmentBuilder,
	type ChatInputCommandInteraction,
	Client,
	DiscordAPIError,
	Events,
	GatewayIntentBits,
	type Message,
	MessageFlags,
	Partials,
} from "discord.js";
import { sanitizeForLog } from "../../application/sanitize-for-log";
import type {
	CaptureResult,
	ScreenshotCapturer,
} from "../../application/screenshot-service";
import {
	InvalidChannelUrlError,
	UnsupportedTwitchUrlError,
} from "../../domain/errors";
import type { Logger } from "../../domain/ports";
import { TwitchChannel } from "../../domain/twitch-channel";
import { COMMAND_NAME, OPTION_CHANNEL_URL } from "./command";
import { extractChannels } from "./url-extractor";

/** Generic, user-facing message shown when retrieval fails for any reason. */
const GENERIC_ERROR =
	"⚠️ Couldn't grab a screenshot for that channel right now.";

/**
 * Reduce a Discord send/reply failure to a compact, log-safe shape. Avoids
 * dumping a DiscordAPIError's `requestBody` (which embeds the PNG bytes) and
 * keeps the actionable bits — e.g. code 50013 = Missing Permissions.
 */
function describeSendError(err: unknown): {
	code?: number | string;
	message: string;
} {
	if (err instanceof DiscordAPIError) {
		return { code: err.code, message: err.message };
	}
	return { message: err instanceof Error ? err.message : String(err) };
}

/** Build a PNG attachment from captured image bytes. */
function toAttachment(channelLogin: string, image: Buffer): AttachmentBuilder {
	return new AttachmentBuilder(image, { name: `${channelLogin}.png` });
}

/**
 * Discord adapter wiring the gateway to the {@link ScreenshotService}.
 *
 * Provides two entry points:
 *  - `/twitch_screenshot` slash command (deferred reply, then edit with image).
 *  - Auto-embed on `messageCreate`: scans messages for live channel URLs and
 *    replies (mentions suppressed) with a screenshot per distinct live channel.
 */
export class DiscordBot {
	private readonly client: Client;

	constructor(
		private readonly service: ScreenshotCapturer,
		private readonly logger: Logger,
	) {
		this.client = new Client({
			intents: [
				GatewayIntentBits.Guilds,
				GatewayIntentBits.GuildMessages,
				GatewayIntentBits.MessageContent,
			],
			// Allow receiving messages in uncached channels.
			partials: [Partials.Channel, Partials.Message],
		});

		this.client.once(Events.ClientReady, (c) =>
			this.logger.info({ user: c.user.tag }, "Discord bot ready"),
		);
		this.client.on(Events.InteractionCreate, this.onInteraction.bind(this));
		this.client.on(Events.MessageCreate, this.onMessage.bind(this));
		// discord.js can attach raw gateway frames to error payloads (e.g. on a
		// disallowed-intents handshake); sanitize before logging so a multi-MB
		// binary buffer can't flood the terminal. Also prevents an unhandled
		// 'error' event from crashing the process.
		this.client.on(Events.Error, (err) =>
			this.logger.error({ err: sanitizeForLog(err) }, "Discord client error"),
		);
		this.client.on(Events.ShardError, (err) =>
			this.logger.error({ err: sanitizeForLog(err) }, "Discord shard error"),
		);
	}

	/** Expose the underlying client so the audit logger can share the connection. */
	get discordClient(): Client {
		return this.client;
	}

	/** Connect to the Discord gateway. */
	async start(token: string): Promise<void> {
		await this.client.login(token);
	}

	/** Disconnect cleanly. */
	async stop(): Promise<void> {
		await this.client.destroy();
	}

	/** Handle the `/twitch_screenshot` slash command. */
	private async onInteraction(
		interaction: import("discord.js").Interaction,
	): Promise<void> {
		if (!interaction.isChatInputCommand()) return;
		if (interaction.commandName !== COMMAND_NAME) return;
		await this.handleScreenshotCommand(interaction);
	}

	private async handleScreenshotCommand(
		interaction: ChatInputCommandInteraction,
	): Promise<void> {
		const input = interaction.options.getString(OPTION_CHANNEL_URL, true);

		let channel: TwitchChannel;
		try {
			channel = TwitchChannel.parse(input);
		} catch (err) {
			const reason =
				err instanceof UnsupportedTwitchUrlError
					? `That's a ${err.kind} URL — only live channel URLs are supported.`
					: err instanceof InvalidChannelUrlError
						? "That doesn't look like a Twitch channel URL."
						: "Invalid input.";
			await interaction.reply({
				content: `❌ ${reason}`,
				flags: MessageFlags.Ephemeral,
			});
			return;
		}

		// Retrieval can take several seconds (GQL + usher + ffmpeg), so defer.
		await interaction.deferReply();
		const result = await this.service.capture(channel);

		switch (result.status) {
			case "ok":
				await interaction.editReply({
					content: `📸 **${channel.login}** — live source screenshot`,
					files: [toAttachment(channel.login, result.image)],
				});
				return;
			case "offline":
				await interaction.editReply(
					`💤 **${channel.login}** isn't live right now.`,
				);
				return;
			default:
				await interaction.editReply(GENERIC_ERROR);
				return;
		}
	}

	/** Auto-embed: detect live Twitch channel URLs in messages and reply with screenshots. */
	private async onMessage(message: Message): Promise<void> {
		if (message.author.bot) return;
		if (message.content.length === 0) return;

		const channels = extractChannels(message.content);
		if (channels.length === 0) return;

		// Capture all channels concurrently; reply only for those that are live.
		const results = await Promise.all(
			channels.map((channel) => this.service.capture(channel)),
		);
		for (const result of results) {
			await this.replyForAutoEmbed(message, result);
		}
	}

	/** Send (or skip) an auto-embed reply for a single capture result. */
	private async replyForAutoEmbed(
		message: Message,
		result: CaptureResult,
	): Promise<void> {
		switch (result.status) {
			case "ok":
				try {
					await message.reply({
						content: `📸 **${result.channel}** is live`,
						files: [toAttachment(result.channel, result.image)],
						allowedMentions: { repliedUser: false, parse: [] },
					});
				} catch (err) {
					this.logger.error(
						{ err: describeSendError(err), channel: result.channel },
						"Failed to send auto-embed reply",
					);
				}
				return;
			case "offline":
				// Channel not live → do nothing, per spec.
				return;
			case "auth_failure":
				// We can't even determine liveness (Twitch contract broke). Stay
				// silent on auto-embed to avoid spamming every message during an
				// outage; the failure is already logged and audited.
				return;
			default:
				// Live but retrieval failed: generic reply, detail already logged/audited.
				try {
					await message.reply({
						content: GENERIC_ERROR,
						allowedMentions: { repliedUser: false, parse: [] },
					});
				} catch (err) {
					this.logger.error(
						{ err: describeSendError(err), channel: result.channel },
						"Failed to send auto-embed error reply",
					);
				}
				return;
		}
	}
}
