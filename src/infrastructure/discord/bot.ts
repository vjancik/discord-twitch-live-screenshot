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
import { EmbedSuppressionTracker } from "../../application/embed-suppression-tracker";
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
	/**
	 * Coordinates suppression of the native Twitch auto-embed on a user's message
	 * once we've posted a screenshot for it. Undefined when the feature is off.
	 */
	private readonly suppression?: EmbedSuppressionTracker;

	constructor(
		private readonly service: ScreenshotCapturer,
		private readonly logger: Logger,
		/** When true, suppress the native auto-embed after posting a screenshot. */
		suppressEmbeds = false,
	) {
		if (suppressEmbeds) this.suppression = new EmbedSuppressionTracker();
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
		// Discord attaches the native auto-unfurl embed asynchronously, firing a
		// messageUpdate. Only registered when suppression is enabled.
		if (this.suppression !== undefined) {
			this.client.on(Events.MessageUpdate, this.onMessageUpdate.bind(this));
		}
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

		// Begin tracking before any capture so a fast embed-attach (messageUpdate)
		// that arrives mid-capture is correlated to this message.
		this.suppression?.track(message.id);

		// Capture all channels concurrently; reply only for those that are live.
		const results = await Promise.all(
			channels.map((channel) => this.service.capture(channel)),
		);
		let posted = false;
		for (const result of results) {
			posted = (await this.replyForAutoEmbed(message, result)) || posted;
		}

		// We posted a screenshot for at least one channel in this message → the
		// native auto-embed is now redundant. Suppression is all-or-nothing per
		// message; the embed may already be attached (suppress now) or arrive
		// later via messageUpdate.
		const embedPresent = message.embeds.length > 0;
		if (
			posted &&
			this.suppression?.onScreenshotPosted(message.id, embedPresent) === true
		) {
			await this.suppressMessageEmbeds(message);
		}
	}

	/** Suppress an embed on a tracked message once Discord attaches it. */
	private async onMessageUpdate(
		_oldMessage: unknown,
		newMessage: Message | import("discord.js").PartialMessage,
	): Promise<void> {
		if (this.suppression === undefined) return;

		try {
			// messageUpdate fires for many reasons (edits, pins, embed-attach). We
			// only care about embed-attach, so confirm an embed exists before
			// claiming the one-shot suppress. On a true partial only the id is
			// reliable; fetch to read embeds (the common embed-attach case arrives
			// non-partial). The id is always valid, even on a partial.
			const full = newMessage.partial ? await newMessage.fetch() : newMessage;
			if (full.embeds.length === 0) return;

			// Only suppress messages we decided to suppress (a screenshot was
			// posted) and haven't suppressed yet.
			if (this.suppression.onEmbedAppeared(full.id) !== true) return;
			await this.suppressMessageEmbeds(full);
		} catch (err) {
			this.logger.error(
				{ err: describeSendError(err), messageId: newMessage.id },
				"Failed to suppress embed on messageUpdate",
			);
		}
	}

	/**
	 * Set the SUPPRESS_EMBEDS flag on a message, hiding all of Discord's
	 * auto-unfurl embeds (it is all-or-nothing — a single embed cannot be
	 * targeted). Requires the "Manage Messages" permission; a missing-permission
	 * error (50013) is logged compactly and otherwise ignored so the screenshot
	 * reply is unaffected.
	 */
	private async suppressMessageEmbeds(message: Message): Promise<void> {
		try {
			await message.suppressEmbeds(true);
			this.suppression?.forget(message.id);
		} catch (err) {
			this.logger.error(
				{ err: describeSendError(err), messageId: message.id },
				"Failed to suppress message embeds (need Manage Messages?)",
			);
		}
	}

	/**
	 * Send (or skip) an auto-embed reply for a single capture result.
	 *
	 * @returns true if a screenshot was successfully posted.
	 */
	private async replyForAutoEmbed(
		message: Message,
		result: CaptureResult,
	): Promise<boolean> {
		switch (result.status) {
			case "ok":
				try {
					await message.reply({
						content: `📸 **${result.channel}** is live`,
						files: [toAttachment(result.channel, result.image)],
						allowedMentions: { repliedUser: false, parse: [] },
					});
					return true;
				} catch (err) {
					this.logger.error(
						{ err: describeSendError(err), channel: result.channel },
						"Failed to send auto-embed reply",
					);
					return false;
				}
			case "offline":
				// Channel not live → do nothing, per spec.
				return false;
			case "auth_failure":
				// We can't even determine liveness (Twitch contract broke). Stay
				// silent on auto-embed to avoid spamming every message during an
				// outage; the failure is already logged and audited.
				return false;
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
				return false;
		}
	}
}
