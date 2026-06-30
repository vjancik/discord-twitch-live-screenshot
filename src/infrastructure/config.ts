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
	/**
	 * When true, suppress the native auto-unfurl embed on a user's message after
	 * we successfully post a screenshot for a Twitch channel it links to.
	 * Requires the bot to have "Manage Messages" in the channel.
	 */
	suppressEmbeds: boolean;
	/**
	 * Rate-limit window, in seconds, for the per-(Twitch-channel × Discord-channel)
	 * throttle: at most one capture per channel per room per this many seconds.
	 */
	rateLimitPerChannelSeconds: number;
	/**
	 * Rate-limit window, in seconds, for the per-user throttle: at most one
	 * invocation per user (across all channels) per this many seconds.
	 */
	rateLimitPerUserSeconds: number;
}

function required(name: string): string {
	const value = process.env[name];
	if (value === undefined || value.trim() === "") {
		throw new ConfigError(`Missing required environment variable: ${name}`);
	}
	return value.trim();
}

/**
 * Parse a boolean env var, accepting `true`/`false`/`1`/`0` case-insensitively.
 * An unset/blank value yields {@link fallback}; any other value is rejected.
 *
 * @throws {ConfigError} when the value is present but not a recognized boolean.
 */
function booleanEnv(name: string, fallback: boolean): boolean {
	const raw = process.env[name]?.trim();
	if (raw === undefined || raw === "") return fallback;
	const value = raw.toLowerCase();
	if (value === "true" || value === "1") return true;
	if (value === "false" || value === "0") return false;
	throw new ConfigError(
		`Invalid boolean for ${name}: "${raw}" (expected true/false/1/0)`,
	);
}

/**
 * Parse a positive-integer env var. An unset/blank value yields {@link fallback};
 * any value that is not a whole number greater than zero is rejected.
 *
 * @throws {ConfigError} when the value is present but not a positive integer.
 */
function positiveIntEnv(name: string, fallback: number): number {
	const raw = process.env[name]?.trim();
	if (raw === undefined || raw === "") return fallback;
	const value = Number(raw);
	if (!Number.isInteger(value) || value <= 0) {
		throw new ConfigError(
			`Invalid value for ${name}: "${raw}" (expected a positive integer)`,
		);
	}
	return value;
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
		suppressEmbeds: booleanEnv("SUPPRESS_EMBEDS", false),
		rateLimitPerChannelSeconds: positiveIntEnv("RATE_LIMIT_PER_CHANNEL", 60),
		rateLimitPerUserSeconds: positiveIntEnv("RATE_LIMIT_PER_USER", 60),
	};
}
