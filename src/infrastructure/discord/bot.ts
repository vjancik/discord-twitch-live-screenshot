import {
	AttachmentBuilder,
	type ChatInputCommandInteraction,
	Client,
	DiscordAPIError,
	Events,
	GatewayIntentBits,
	LabelBuilder,
	type Message,
	type MessageContextMenuCommandInteraction,
	MessageFlags,
	ModalBuilder,
	type ModalSubmitInteraction,
	Partials,
	PermissionFlagsBits,
	TextInputBuilder,
	TextInputStyle,
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
import type { Logger, RateLimiter } from "../../domain/ports";
import { TwitchChannel } from "../../domain/twitch-channel";
import { parseAttachmentSelection } from "./attachment-selection";
import {
	COMMAND_NAME,
	OPTION_CHANNEL_URL,
	OPTION_SPOILER,
	SPOILER_COMMAND_NAME,
} from "./command";
import { formatAdBreakNotice, formatLiveHeadline } from "./live-headline";
import { extractChannels } from "./url-extractor";

/** Generic, user-facing message shown when retrieval fails for any reason. */
const GENERIC_ERROR =
	"⚠️ Couldn't grab a screenshot for that channel right now.";

/** User-facing message shown when an invocation is rate limited. */
const RATE_LIMITED = "🛑 You have hit the rate limit, please try again later.";

/**
 * customId prefix for the (Un)Spoiler selection modal; the target message id
 * is appended so the submit handler can find the message again.
 */
const SPOILER_MODAL_PREFIX = "unspoiler:";

/** customId of the index-selection text input inside the (Un)Spoiler modal. */
const SPOILER_MODAL_INPUT = "unspoiler-selection";

/** Build the per-(channel × Discord-channel) rate-limit key. */
function channelRoomKey(
	channelLogin: string,
	discordChannelId: string,
): string {
	return `${channelLogin}:${discordChannelId}`;
}

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

/** Build a PNG attachment from captured image bytes, optionally spoilered. */
function toAttachment(
	channelLogin: string,
	image: Buffer,
	spoiler = false,
): AttachmentBuilder {
	return new AttachmentBuilder(image, {
		name: `${channelLogin}.png`,
	}).setSpoiler(spoiler);
}

/**
 * True when the message text carries the "spoiler" opt-in keyword: any
 * whitespace-separated token equal to "spoiler" (case-insensitive). Signals
 * that the screenshots replied to this message should be posted spoilered.
 */
function hasSpoilerKeyword(content: string): boolean {
	return content.split(/\s+/).some((t) => t.toLowerCase() === "spoiler");
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
		/**
		 * Per-invocation throttles. `userLimiter` is keyed by the invoking user
		 * (across all channels); `channelRoomLimiter` is keyed by Twitch-channel ×
		 * Discord-channel. An invocation must pass BOTH to capture. Per-invocation
		 * (not per-screenshot): one message linking N channels is a single user
		 * acquisition but N channel-room acquisitions.
		 */
		private readonly userLimiter: RateLimiter,
		private readonly channelRoomLimiter: RateLimiter,
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

	/** Route incoming interactions to the matching command/modal handler. */
	private async onInteraction(
		interaction: import("discord.js").Interaction,
	): Promise<void> {
		if (interaction.isChatInputCommand()) {
			if (interaction.commandName === COMMAND_NAME) {
				await this.handleScreenshotCommand(interaction);
			}
			return;
		}
		if (interaction.isMessageContextMenuCommand()) {
			if (interaction.commandName === SPOILER_COMMAND_NAME) {
				await this.handleSpoilerCommand(interaction);
			}
			return;
		}
		if (
			interaction.isModalSubmit() &&
			interaction.customId.startsWith(SPOILER_MODAL_PREFIX)
		) {
			await this.handleSpoilerModal(interaction);
		}
	}

	private async handleScreenshotCommand(
		interaction: ChatInputCommandInteraction,
	): Promise<void> {
		const input = interaction.options.getString(OPTION_CHANNEL_URL, true);
		const spoiler = interaction.options.getBoolean(OPTION_SPOILER) ?? false;

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

		// Enforce both rate limits BEFORE deferring: a deferred reply can't be made
		// ephemeral after the fact, so the rate-limit notice (which should be
		// ephemeral) has to be the very first response. One invocation consumes one
		// unit of each key only if both pass — otherwise neither is consumed.
		const userKey = interaction.user.id;
		const roomKey = channelRoomKey(channel.login, interaction.channelId);
		if (!this.userLimiter.tryAcquire(userKey)) {
			await interaction.reply({
				content: RATE_LIMITED,
				flags: MessageFlags.Ephemeral,
			});
			return;
		}
		if (!this.channelRoomLimiter.tryAcquire(roomKey)) {
			await interaction.reply({
				content: RATE_LIMITED,
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
					// Slash reply links the slug: the user typed a URL, not a clickable
					// message link, so we provide one. formatLiveHeadline wraps it in
					// <> so Discord doesn't unfurl it into a profile embed.
					content: formatLiveHeadline(
						channel.login,
						result.metadata,
						channel.url,
					),
					files: [toAttachment(channel.login, result.image, spoiler)],
				});
				return;
			case "ad":
				await interaction.editReply(
					formatAdBreakNotice(channel.login, result.metadata, channel.url),
				);
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

	/**
	 * Handle the "(Un)Spoiler" message context menu command (admin-only).
	 *
	 * With a single attachment the spoiler state is toggled immediately; with
	 * several, a modal asks which 1-indexed attachments to flip (`1,3` or `all`).
	 */
	private async handleSpoilerCommand(
		interaction: MessageContextMenuCommandInteraction,
	): Promise<void> {
		// Hard runtime gate on top of the registration-time default permissions:
		// the default can be re-opened to non-admins per guild via Integration
		// settings, and this command is meant to stay admin-only.
		if (
			interaction.memberPermissions?.has(PermissionFlagsBits.Administrator) !==
			true
		) {
			await interaction.reply({
				content: "❌ This command is admin-only.",
				flags: MessageFlags.Ephemeral,
			});
			return;
		}

		const target = interaction.targetMessage;
		// Attachments can only be replaced on our own messages.
		if (target.author.id !== interaction.client.user.id) {
			await interaction.reply({
				content: "❌ I can only (un)spoiler attachments on my own messages.",
				flags: MessageFlags.Ephemeral,
			});
			return;
		}
		const count = target.attachments.size;
		if (count === 0) {
			await interaction.reply({
				content: "❌ That message has no attachments.",
				flags: MessageFlags.Ephemeral,
			});
			return;
		}

		// One attachment → the selection is unambiguous, toggle right away.
		if (count === 1) {
			await interaction.deferReply({ flags: MessageFlags.Ephemeral });
			await this.flipSpoilers(target, new Set([0]));
			await interaction.editReply("✅ Toggled the attachment's spoiler.");
			return;
		}

		// Several attachments → ask which to flip via a modal text input.
		const modal = new ModalBuilder()
			.setCustomId(`${SPOILER_MODAL_PREFIX}${target.id}`)
			.setTitle("(Un)Spoiler attachments")
			.addLabelComponents(
				new LabelBuilder()
					.setLabel(`Which attachments to flip (1-${count})`)
					.setDescription(
						'1-indexed, comma-separated — e.g. "1,3" — or "all" to flip every attachment.',
					)
					.setTextInputComponent(
						new TextInputBuilder()
							.setCustomId(SPOILER_MODAL_INPUT)
							.setPlaceholder('e.g. "1,3" or "all"')
							.setStyle(TextInputStyle.Short)
							.setRequired(true),
					),
			);
		await interaction.showModal(modal);
	}

	/** Handle the (Un)Spoiler modal submit: parse the selection and flip. */
	private async handleSpoilerModal(
		interaction: ModalSubmitInteraction,
	): Promise<void> {
		const messageId = interaction.customId.slice(SPOILER_MODAL_PREFIX.length);
		const input = interaction.fields.getTextInputValue(SPOILER_MODAL_INPUT);
		await interaction.deferReply({ flags: MessageFlags.Ephemeral });

		try {
			const channel = interaction.channel;
			if (channel === null || !channel.isTextBased()) {
				await interaction.editReply("❌ Couldn't access this channel.");
				return;
			}
			// Re-fetch instead of caching the message across the modal round-trip:
			// it may have been edited or deleted while the modal was open.
			const message = await channel.messages.fetch(messageId);
			const selection = parseAttachmentSelection(
				input,
				message.attachments.size,
			);
			if (!selection.ok) {
				await interaction.editReply(`❌ ${selection.reason}`);
				return;
			}
			await this.flipSpoilers(message, new Set(selection.indexes));
			const positions = selection.indexes.map((i) => i + 1).join(", ");
			await interaction.editReply(
				`✅ Toggled spoiler on attachment(s) ${positions}.`,
			);
		} catch (err) {
			this.logger.error(
				{ err: describeSendError(err), messageId },
				"(Un)Spoiler modal handling failed",
			);
			await interaction.editReply(
				"❌ Couldn't update that message (was it deleted?).",
			);
		}
	}

	/**
	 * Toggle the spoiler state of the given 0-based attachment indexes on one of
	 * the bot's own messages.
	 *
	 * Discord has no mutable spoiler flag — it is the `SPOILER_` filename
	 * prefix, fixed at upload time — so flipping means re-uploading. All
	 * attachments are rebuilt in their original array order (rather than keeping
	 * the untouched ones), because an edit appends new uploads after kept
	 * attachments: a partial rebuild would reorder the message's attachment grid
	 * and break 1-indexed selection for subsequent toggles. discord.js downloads
	 * each `attachment.url` itself — a URL string is a valid attachment resource.
	 */
	private async flipSpoilers(
		message: Message,
		indexes: ReadonlySet<number>,
	): Promise<void> {
		const files = [...message.attachments.values()].map((attachment, i) =>
			new AttachmentBuilder(attachment.url, {
				name: attachment.name,
				description: attachment.description ?? undefined,
			}).setSpoiler(indexes.has(i) ? !attachment.spoiler : attachment.spoiler),
		);
		await message.edit({ attachments: [], files });
	}

	/** Auto-embed: detect live Twitch channel URLs in messages and reply with screenshots. */
	private async onMessage(message: Message): Promise<void> {
		if (message.author.bot) return;
		if (message.content.length === 0) return;

		const channels = extractChannels(message.content);
		if (channels.length === 0) return;

		// A bare "spoiler" word anywhere in the message opts every resulting
		// screenshot into being posted spoilered.
		const spoiler = hasSpoilerKeyword(message.content);

		// User limit is per-invocation (per message), checked once regardless of how
		// many channels are linked. Deny → a single notice, capture nothing.
		if (!this.userLimiter.tryAcquire(message.author.id)) {
			await this.sendRateLimitedReply(message);
			return;
		}

		// Each linked channel is throttled independently per Discord channel. A
		// channel that trips its own limit is skipped; the others still capture.
		const allowed = channels.filter((channel) =>
			this.channelRoomLimiter.tryAcquire(
				channelRoomKey(channel.login, message.channelId),
			),
		);
		if (allowed.length < channels.length) {
			await this.sendRateLimitedReply(message);
		}
		if (allowed.length === 0) return;

		// Begin tracking before any capture so a fast embed-attach (messageUpdate)
		// that arrives mid-capture is correlated to this message.
		this.suppression?.track(message.id);

		// Capture all channels concurrently; reply only for those that are live.
		const results = await Promise.all(
			allowed.map((channel) => this.service.capture(channel)),
		);
		let posted = false;
		for (const result of results) {
			posted =
				(await this.replyForAutoEmbed(message, result, spoiler)) || posted;
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

	/** Reply to a message that tripped a rate limit (auto-embed path). */
	private async sendRateLimitedReply(message: Message): Promise<void> {
		try {
			await message.reply({
				content: RATE_LIMITED,
				allowedMentions: { repliedUser: false, parse: [] },
			});
		} catch (err) {
			this.logger.error(
				{ err: describeSendError(err), messageId: message.id },
				"Failed to send rate-limit reply",
			);
		}
	}

	/**
	 * Send (or skip) an auto-embed reply for a single capture result.
	 *
	 * @param spoiler when true, the screenshot attachment is posted spoilered.
	 * @returns true if a screenshot was successfully posted.
	 */
	private async replyForAutoEmbed(
		message: Message,
		result: CaptureResult,
		spoiler: boolean,
	): Promise<boolean> {
		switch (result.status) {
			case "ok":
				try {
					await message.reply({
						// No link here: the user's original message already carries it.
						content: formatLiveHeadline(result.channel, result.metadata),
						files: [toAttachment(result.channel, result.image, spoiler)],
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
			case "ad":
				// Commercial break: report once, no screenshot. Returns false so it
				// does NOT trigger embed suppression (we only suppress on a real shot).
				try {
					await message.reply({
						content: formatAdBreakNotice(result.channel, result.metadata),
						allowedMentions: { repliedUser: false, parse: [] },
					});
				} catch (err) {
					this.logger.error(
						{ err: describeSendError(err), channel: result.channel },
						"Failed to send ad-break notice",
					);
				}
				return false;
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
