import {
	AuthFailureError,
	ChannelOfflineError,
	RetrievalError,
} from "../../domain/errors";
import {
	parseMasterPlaylist,
	selectSourceVariant,
} from "../../domain/playlist";
import type { Logger, StreamResolver } from "../../domain/ports";
import type { TwitchChannel } from "../../domain/twitch-channel";

/**
 * Twitch's public, anonymous web Client-ID. Shared by the website's logged-out
 * player; streamlink and yt-dlp use the same value. No secret/rotation.
 */
const CLIENT_ID = "kimne78kx3ncx6brgo4mv6wki5h1ko";

const GQL_ENDPOINT = "https://gql.twitch.tv/gql";
const USHER_BASE = "https://usher.ttvnw.net/api/channel/hls";

/**
 * A desktop browser UA. Twitch began requiring a non-default UA on the access
 * token request (streamlink#6574); we mirror that here.
 */
const USER_AGENT =
	"Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36";

/**
 * Inline GraphQL query for the stream playback access token.
 *
 * IMPORTANT: this deliberately sends the query *string* rather than a persisted
 * query (`sha256Hash`). yt-dlp does the same. This is what makes the flow robust
 * — there is no rotating hash to keep in sync. If Twitch ever retires inline
 * queries or this Client-ID, cross-check the current approach against:
 *   - external_projects/yt-dlp/yt_dlp/extractor/twitch.py (_download_access_token)
 *   - external_projects/streamlink/src/streamlink/plugins/twitch.py (TwitchAPI.access_token)
 */
const ACCESS_TOKEN_QUERY = `query PlaybackAccessToken_Template($login: String!, $isLive: Boolean!, $vodID: ID!, $isVod: Boolean!, $playerType: String!) {  streamPlaybackAccessToken(channelName: $login, params: {platform: "web", playerBackend: "mediaplayer", playerType: $playerType}) @include(if: $isLive) {    value    signature    __typename  }  videoPlaybackAccessToken(id: $vodID, params: {platform: "web", playerBackend: "mediaplayer", playerType: $playerType}) @include(if: $isVod) {    value    signature    __typename  }}`;

interface PlaybackAccessToken {
	value: string;
	signature: string;
}

interface GqlResponse {
	data?: {
		streamPlaybackAccessToken?: PlaybackAccessToken | null;
	};
	errors?: Array<{ message: string }>;
}

/** Substrings in a usher error body that mean "channel is simply not live". */
const OFFLINE_MARKERS = [
	"transcode does not exist",
	"can not find channel",
	"this channel is offline",
];

/**
 * {@link StreamResolver} implementation using Twitch's anonymous GQL +
 * usher.ttvnw.net negotiation. Pure `fetch`; no third-party SDK.
 */
export class TwitchGqlResolver implements StreamResolver {
	constructor(
		private readonly logger: Logger,
		private readonly fetchImpl: typeof fetch = fetch,
	) {}

	async resolveSourceUrl(channel: TwitchChannel): Promise<string> {
		const token = await this.fetchAccessToken(channel);
		const playlist = await this.fetchPlaylist(channel, token);
		const variant = selectSourceVariant(parseMasterPlaylist(playlist));
		this.logger.debug(
			{
				channel: channel.login,
				variant: variant.name,
				resolution: variant.resolution,
			},
			"Selected source variant",
		);
		return variant.url;
	}

	/** POST the inline GQL query and extract the signed token. */
	private async fetchAccessToken(
		channel: TwitchChannel,
	): Promise<PlaybackAccessToken> {
		const body = {
			operationName: "PlaybackAccessToken_Template",
			query: ACCESS_TOKEN_QUERY,
			variables: {
				isLive: true,
				login: channel.login,
				isVod: false,
				vodID: "",
				playerType: "site",
			},
		};

		let res: Response;
		try {
			res = await this.fetchImpl(GQL_ENDPOINT, {
				method: "POST",
				headers: {
					"Client-ID": CLIENT_ID,
					"Content-Type": "text/plain;charset=UTF-8",
					"User-Agent": USER_AGENT,
				},
				body: JSON.stringify(body),
			});
		} catch (cause) {
			throw new RetrievalError("Network error contacting Twitch GQL", {
				cause,
			});
		}

		// 401/403 (or other non-OK) from GQL itself means the anonymous contract
		// was rejected — audit-worthy.
		if (res.status === 401 || res.status === 403) {
			throw new AuthFailureError("Twitch GQL rejected the anonymous request", {
				stage: "gql",
				status: res.status,
				body: (await safeText(res)).slice(0, 500),
			});
		}
		if (!res.ok) {
			throw new RetrievalError(`Twitch GQL returned HTTP ${res.status}`);
		}

		let json: GqlResponse;
		try {
			json = (await res.json()) as GqlResponse;
		} catch (cause) {
			throw new RetrievalError("Twitch GQL returned non-JSON response", {
				cause,
			});
		}

		if (json.errors && json.errors.length > 0) {
			// GQL-level errors on a 200 typically mean the query shape is no longer
			// accepted (schema change) — treat as an auth-contract failure.
			throw new AuthFailureError(
				`Twitch GQL error: ${json.errors.map((e) => e.message).join("; ")}`,
				{
					stage: "gql",
					status: res.status,
					body: JSON.stringify(json.errors).slice(0, 500),
				},
			);
		}

		const token = json.data?.streamPlaybackAccessToken;
		if (!token?.value || !token.signature) {
			throw new AuthFailureError(
				"Twitch GQL response missing playback access token",
				{
					stage: "gql",
					status: res.status,
					body: JSON.stringify(json).slice(0, 500),
				},
			);
		}
		return token;
	}

	/** Request the usher master playlist; classify offline vs. auth vs. other. */
	private async fetchPlaylist(
		channel: TwitchChannel,
		token: PlaybackAccessToken,
	): Promise<string> {
		const params = new URLSearchParams({
			allow_source: "true",
			allow_audio_only: "true",
			p: String(Math.floor(Math.random() * 9_999_999)),
			platform: "web",
			player: "twitchweb",
			playlist_include_framerate: "true",
			supported_codecs: "h264",
			sig: token.signature,
			token: token.value,
		});
		const url = `${USHER_BASE}/${channel.login}.m3u8?${params.toString()}`;

		let res: Response;
		try {
			res = await this.fetchImpl(url, {
				headers: { "User-Agent": USER_AGENT },
			});
		} catch (cause) {
			throw new RetrievalError("Network error contacting Twitch usher", {
				cause,
			});
		}

		if (res.ok) {
			return await res.text();
		}

		const text = (await safeText(res)).toLowerCase();

		// Offline / nonexistent channels return 404 (or 403) with a recognizable body.
		if (
			(res.status === 404 || res.status === 403) &&
			OFFLINE_MARKERS.some((m) => text.includes(m))
		) {
			throw new ChannelOfflineError(channel.login);
		}

		// A 403 that is NOT an offline marker suggests the token/contract was
		// rejected — e.g. integrity enforcement. Audit it.
		if (res.status === 401 || res.status === 403) {
			throw new AuthFailureError("Twitch usher rejected the playback token", {
				stage: "usher",
				status: res.status,
				body: text.slice(0, 500),
			});
		}

		// Anything else with an offline marker (defensive) → offline; else error.
		if (OFFLINE_MARKERS.some((m) => text.includes(m))) {
			throw new ChannelOfflineError(channel.login);
		}
		throw new RetrievalError(
			`Twitch usher returned HTTP ${res.status}: ${text.slice(0, 200)}`,
		);
	}
}

/** Read a response body as text without throwing. */
async function safeText(res: Response): Promise<string> {
	try {
		return await res.text();
	} catch {
		return "";
	}
}
