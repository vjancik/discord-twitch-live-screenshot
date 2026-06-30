import { sanitizeForLog } from "./application/sanitize-for-log";
import { ScreenshotService } from "./application/screenshot-service";
import { loadConfig } from "./infrastructure/config";
import { DiscordAuditLogger } from "./infrastructure/discord/audit-logger";
import { DiscordBot } from "./infrastructure/discord/bot";
import { FfmpegFrameGrabber } from "./infrastructure/ffmpeg/frame-grabber";
import { createLogger } from "./infrastructure/logger";
import { FixedWindowRateLimiter } from "./infrastructure/rate-limit/fixed-window-rate-limiter";
import { TwitchGqlResolver } from "./infrastructure/twitch/gql-resolver";

/**
 * Composition root: load config, wire adapters into the application service,
 * and start the Discord bot.
 */
async function main(): Promise<void> {
	const config = loadConfig();
	const logger = createLogger(config.logLevel);

	// Guard against discord.js (and others) dumping multi-megabyte binary gateway
	// frames into the logs — e.g. on a disallowed-intents handshake failure.
	process.on("unhandledRejection", (reason) => {
		logger.error(
			{ reason: sanitizeForLog(reason) },
			"Unhandled promise rejection",
		);
	});
	process.on("uncaughtException", (error) => {
		logger.error({ error: sanitizeForLog(error) }, "Uncaught exception");
		process.exit(1);
	});

	const resolver = new TwitchGqlResolver(logger);
	const grabber = new FfmpegFrameGrabber(logger, config.ffmpegPath);

	// The bot owns the Discord client; the audit logger reuses that same
	// connection. Resolve the wiring cycle (bot -> service -> audit -> client)
	// by building the bot with a thin forwarding capturer that delegates to the
	// service once it is constructed.
	let service: ScreenshotService | undefined;
	// Per-invocation throttles (windows configurable, default 60s each): one keyed
	// by user (across all channels), one by Twitch-channel × Discord-channel.
	const userLimiter = new FixedWindowRateLimiter(
		config.rateLimitPerUserSeconds * 1000,
	);
	const channelRoomLimiter = new FixedWindowRateLimiter(
		config.rateLimitPerChannelSeconds * 1000,
	);
	const bot = new DiscordBot(
		{
			capture: (channel) => {
				if (service === undefined)
					throw new Error("ScreenshotService not initialized");
				return service.capture(channel);
			},
		},
		logger,
		userLimiter,
		channelRoomLimiter,
		config.suppressEmbeds,
	);
	const audit = new DiscordAuditLogger(
		bot.discordClient,
		config.auditChannelId,
		logger,
	);
	service = new ScreenshotService(resolver, grabber, audit, logger);

	const shutdown = async (signal: string): Promise<void> => {
		logger.info({ signal }, "Shutting down");
		await bot.stop();
		process.exit(0);
	};
	process.on("SIGINT", () => void shutdown("SIGINT"));
	process.on("SIGTERM", () => void shutdown("SIGTERM"));

	await bot.start(config.discordToken);
}

main().catch((err) => {
	console.error(err);
	process.exit(1);
});
