import { AppError } from "../domain/errors";

/** Raised when required environment configuration is missing or malformed. */
export class ConfigError extends AppError {}

/** Fully-resolved application configuration, sourced from the environment. */
export interface Config {
	/** Discord bot token. */
	discordToken: string;
	/** Discord application (client) id, used for slash-command registration. */
	discordAppId: string;
	/** Channel id to which auth-failure / recovery events are posted. */
	auditChannelId: string;
	/** Optional guild id for instant (guild-scoped) command registration during dev. */
	devGuildId?: string;
	/** Pino log level. */
	logLevel: string;
	/** ffmpeg binary path/name. */
	ffmpegPath: string;
}

function required(name: string): string {
	const value = process.env[name];
	if (value === undefined || value.trim() === "") {
		throw new ConfigError(`Missing required environment variable: ${name}`);
	}
	return value.trim();
}

/**
 * Load and validate configuration from the environment.
 *
 * Bun loads `.env` automatically, so no dotenv import is needed.
 *
 * @throws {ConfigError} when a required variable is absent.
 */
export function loadConfig(): Config {
	return {
		discordToken: required("DISCORD_TOKEN"),
		discordAppId: required("DISCORD_APP_ID"),
		auditChannelId: required("AUDIT_CHANNEL"),
		devGuildId: process.env.DEV_GUILD_ID?.trim() || undefined,
		logLevel: process.env.LOG_LEVEL?.trim() || "info",
		ffmpegPath: process.env.FFMPEG_PATH?.trim() || "ffmpeg",
	};
}
