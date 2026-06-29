import { InvalidChannelUrlError, UnsupportedTwitchUrlError } from "./errors";

/**
 * Twitch login names: 4-25 chars, alphanumeric + underscore, case-insensitive.
 * Twitch lowercases logins internally, so we normalize on construction.
 */
const LOGIN_PATTERN = /^[a-zA-Z0-9_]{4,25}$/;

/**
 * Twitch hostnames we accept. `clips.twitch.tv` is intentionally excluded here;
 * it is detected separately and rejected as a clip URL.
 */
const CHANNEL_HOSTS = new Set([
	"twitch.tv",
	"www.twitch.tv",
	"go.twitch.tv",
	"m.twitch.tv",
]);

/**
 * Path segments that look like a login in a URL but are reserved routes on
 * twitch.tv, not channels. Keeps the auto-embed from firing on e.g.
 * `twitch.tv/directory` or `twitch.tv/settings`.
 */
const RESERVED_PATH_SEGMENTS = new Set([
	"directory",
	"videos",
	"settings",
	"subscriptions",
	"inventory",
	"wallet",
	"drops",
	"downloads",
	"jobs",
	"turbo",
	"prime",
	"store",
	"p",
	"login",
	"signup",
	"search",
	"friends",
	"u",
	"team",
	"teams",
	"communities",
	"collections",
]);

/**
 * A validated, live-streamable Twitch channel reference.
 *
 * Construction enforces that the input is a channel URL (or bare login) and not
 * a VOD or clip. Use {@link TwitchChannel.parse} for a throwing parse, or
 * {@link TwitchChannel.tryParse} for a non-throwing variant used by the
 * auto-embed scanner where most candidate strings will not be channels.
 */
export class TwitchChannel {
	/** The normalized (lowercased) channel login. */
	readonly login: string;

	private constructor(login: string) {
		this.login = login.toLowerCase();
	}

	/** Canonical channel URL for display. */
	get url(): string {
		return `https://www.twitch.tv/${this.login}`;
	}

	/**
	 * Parse a channel URL or bare login into a {@link TwitchChannel}.
	 *
	 * @throws {InvalidChannelUrlError} if the input is not a recognizable Twitch channel reference.
	 * @throws {UnsupportedTwitchUrlError} if the input is a valid Twitch VOD or clip URL.
	 */
	static parse(input: string): TwitchChannel {
		const trimmed = input.trim();

		// Bare login (no scheme/host) — accept if it matches the login pattern.
		if (!trimmed.includes("/") && !trimmed.includes(".")) {
			if (!LOGIN_PATTERN.test(trimmed)) {
				throw new InvalidChannelUrlError(input, "not a valid channel login");
			}
			return new TwitchChannel(trimmed);
		}

		let parsed: URL;
		try {
			// Tolerate scheme-less URLs like "twitch.tv/foo".
			parsed = new URL(
				trimmed.includes("://") ? trimmed : `https://${trimmed}`,
			);
		} catch {
			throw new InvalidChannelUrlError(input, "not a valid URL");
		}

		const host = parsed.hostname.toLowerCase();

		// Clips live on a dedicated host.
		if (host === "clips.twitch.tv") {
			throw new UnsupportedTwitchUrlError(input, "clip");
		}

		// player.twitch.tv/?channel=foo
		if (host === "player.twitch.tv") {
			const channel = parsed.searchParams.get("channel");
			if (channel && LOGIN_PATTERN.test(channel)) {
				return new TwitchChannel(channel);
			}
			if (parsed.searchParams.has("video")) {
				throw new UnsupportedTwitchUrlError(input, "vod");
			}
			throw new InvalidChannelUrlError(
				input,
				"player URL without a channel parameter",
			);
		}

		if (!CHANNEL_HOSTS.has(host)) {
			throw new InvalidChannelUrlError(input, "not a twitch.tv channel host");
		}

		const segments = parsed.pathname.split("/").filter((s) => s.length > 0);

		if (segments.length === 0) {
			throw new InvalidChannelUrlError(input, "no channel in path");
		}

		const first = segments[0]?.toLowerCase() ?? "";

		// /videos/123456789  → VOD
		if (first === "videos") {
			throw new UnsupportedTwitchUrlError(input, "vod");
		}

		// /{channel}/v/123 or /{channel}/video/123 → VOD
		// /{channel}/clip/{slug} → clip
		if (segments.length >= 2) {
			const second = segments[1]?.toLowerCase() ?? "";
			if (second === "clip") {
				throw new UnsupportedTwitchUrlError(input, "clip");
			}
			if (second === "v" || second === "video") {
				throw new UnsupportedTwitchUrlError(input, "vod");
			}
		}

		if (RESERVED_PATH_SEGMENTS.has(first)) {
			throw new InvalidChannelUrlError(
				input,
				`"${first}" is a reserved route, not a channel`,
			);
		}

		// The login may carry a fragment like `#profile-0`; URL parsing already
		// strips the fragment from pathname, so `first` is clean here.
		if (!LOGIN_PATTERN.test(segments[0] ?? "")) {
			throw new InvalidChannelUrlError(
				input,
				"path is not a valid channel login",
			);
		}

		return new TwitchChannel(segments[0] ?? "");
	}

	/**
	 * Non-throwing parse. Returns the channel, or `null` if the input is not a
	 * supported channel reference (invalid, VOD, or clip). Intended for scanning
	 * arbitrary message text where most matches will not be channels.
	 */
	static tryParse(input: string): TwitchChannel | null {
		try {
			return TwitchChannel.parse(input);
		} catch {
			return null;
		}
	}
}
