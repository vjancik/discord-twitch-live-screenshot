import { describe, expect, test } from "bun:test";
import {
	AuthFailureError,
	ChannelOfflineError,
	RetrievalError,
} from "../../domain/errors";
import type { Logger } from "../../domain/ports";
import { TwitchChannel } from "../../domain/twitch-channel";
import { TwitchGqlResolver } from "./gql-resolver";

const noopLogger: Logger = {
	debug() {},
	info() {},
	warn() {},
	error() {},
	child() {
		return noopLogger;
	},
};

const channel = TwitchChannel.parse("somechannel");

function jsonResponse(status: number, body: unknown): Response {
	return new Response(JSON.stringify(body), {
		status,
		headers: { "Content-Type": "application/json" },
	});
}
function textResponse(status: number, body: string): Response {
	return new Response(body, { status });
}

const VALID_TOKEN = {
	data: { streamPlaybackAccessToken: { value: "v", signature: "s" } },
};
const METADATA = {
	data: {
		user: {
			lastBroadcast: { title: "playing games" },
			stream: { id: "1", viewersCount: 1234, game: { displayName: "Chess" } },
		},
	},
};
const MASTER_PLAYLIST = `#EXTM3U
#EXT-X-MEDIA:TYPE=VIDEO,GROUP-ID="chunked",NAME="1080p60 (source)"
#EXT-X-STREAM-INF:BANDWIDTH=8579821,RESOLUTION=1920x1080,VIDEO="chunked"
https://example.ttvnw.net/source.m3u8`;

/** True if a GQL request body carries the access-token query. */
function isTokenRequest(init?: RequestInit): boolean {
	const body = typeof init?.body === "string" ? init.body : "";
	return body.includes("PlaybackAccessToken_Template");
}

/**
 * Build a fetch stub that routes by URL/body: the access-token GQL POST, the
 * metadata GQL POST (same endpoint, different query), and the usher GET. The
 * token and metadata calls race (Promise.all), so order is not guaranteed.
 */
function stubFetch(
	gql: Response,
	usher?: Response,
	metadata: Response = jsonResponse(200, METADATA),
): typeof fetch {
	return (async (url: string, init?: RequestInit) => {
		if (url.includes("gql.twitch.tv")) {
			// `gql` is intended as the token response; route metadata separately, but
			// re-clone so a test that asserts on the token error isn't masked.
			return isTokenRequest(init) ? gql.clone() : metadata.clone();
		}
		if (usher === undefined) throw new Error("unexpected usher fetch");
		return usher;
	}) as unknown as typeof fetch;
}

describe("TwitchGqlResolver", () => {
	test("resolves the source variant url and metadata for a live channel", async () => {
		const resolver = new TwitchGqlResolver(
			noopLogger,
			stubFetch(
				jsonResponse(200, VALID_TOKEN),
				textResponse(200, MASTER_PLAYLIST),
			),
		);
		await expect(resolver.resolve(channel)).resolves.toEqual({
			sourceUrl: "https://example.ttvnw.net/source.m3u8",
			metadata: { title: "playing games", game: "Chess", viewersCount: 1234 },
		});
	});

	test("source resolution succeeds even when metadata fetch fails", async () => {
		const resolver = new TwitchGqlResolver(
			noopLogger,
			stubFetch(
				jsonResponse(200, VALID_TOKEN),
				textResponse(200, MASTER_PLAYLIST),
				textResponse(500, "boom"),
			),
		);
		const result = await resolver.resolve(channel);
		expect(result.sourceUrl).toBe("https://example.ttvnw.net/source.m3u8");
		expect(result.metadata).toBeUndefined();
	});

	test("omits metadata fields that are absent (offline-ish stream)", async () => {
		const resolver = new TwitchGqlResolver(
			noopLogger,
			stubFetch(
				jsonResponse(200, VALID_TOKEN),
				textResponse(200, MASTER_PLAYLIST),
				jsonResponse(200, {
					data: {
						user: { lastBroadcast: { title: "old title" }, stream: null },
					},
				}),
			),
		);
		const result = await resolver.resolve(channel);
		expect(result.metadata).toEqual({
			title: "old title",
			game: undefined,
			viewersCount: undefined,
		});
	});

	test("maps usher 404 'transcode does not exist' to ChannelOfflineError", async () => {
		const usher = textResponse(
			404,
			JSON.stringify([{ error: "transcode does not exist" }]),
		);
		const resolver = new TwitchGqlResolver(
			noopLogger,
			stubFetch(jsonResponse(200, VALID_TOKEN), usher),
		);
		await expect(resolver.resolve(channel)).rejects.toBeInstanceOf(
			ChannelOfflineError,
		);
	});

	test("maps usher 'can not find channel' to ChannelOfflineError", async () => {
		const usher = textResponse(
			404,
			JSON.stringify([{ error: "Can not find channel" }]),
		);
		const resolver = new TwitchGqlResolver(
			noopLogger,
			stubFetch(jsonResponse(200, VALID_TOKEN), usher),
		);
		await expect(resolver.resolve(channel)).rejects.toBeInstanceOf(
			ChannelOfflineError,
		);
	});

	test("maps GQL 403 to AuthFailureError", async () => {
		const resolver = new TwitchGqlResolver(
			noopLogger,
			stubFetch(textResponse(403, "forbidden")),
		);
		await expect(resolver.resolve(channel)).rejects.toBeInstanceOf(
			AuthFailureError,
		);
	});

	test("maps GQL errors[] (schema change) to AuthFailureError", async () => {
		const resolver = new TwitchGqlResolver(
			noopLogger,
			stubFetch(
				jsonResponse(200, { errors: [{ message: "PersistedQueryNotFound" }] }),
			),
		);
		await expect(resolver.resolve(channel)).rejects.toBeInstanceOf(
			AuthFailureError,
		);
	});

	test("maps missing token in a 200 response to AuthFailureError", async () => {
		const resolver = new TwitchGqlResolver(
			noopLogger,
			stubFetch(
				jsonResponse(200, { data: { streamPlaybackAccessToken: null } }),
			),
		);
		await expect(resolver.resolve(channel)).rejects.toBeInstanceOf(
			AuthFailureError,
		);
	});

	test("maps usher 403 WITHOUT offline marker to AuthFailureError", async () => {
		const usher = textResponse(
			403,
			JSON.stringify([{ error: "token invalid" }]),
		);
		const resolver = new TwitchGqlResolver(
			noopLogger,
			stubFetch(jsonResponse(200, VALID_TOKEN), usher),
		);
		await expect(resolver.resolve(channel)).rejects.toBeInstanceOf(
			AuthFailureError,
		);
	});

	test("maps usher 5xx to RetrievalError", async () => {
		const usher = textResponse(503, "service unavailable");
		const resolver = new TwitchGqlResolver(
			noopLogger,
			stubFetch(jsonResponse(200, VALID_TOKEN), usher),
		);
		await expect(resolver.resolve(channel)).rejects.toBeInstanceOf(
			RetrievalError,
		);
	});
});

describe("TwitchGqlResolver.checkAdBreak", () => {
	const AD = `#EXTM3U\n#EXT-X-DATERANGE:ID="a",CLASS="twitch-stitched-ad",START-DATE="2026-06-29T09:00:00.000Z"`;
	const CLEAN = `#EXTM3U\n#EXTINF:2.0,\nhttps://x/seg.ts`;

	test("true when the playlist has a stitched-ad daterange", async () => {
		const resolver = new TwitchGqlResolver(noopLogger, (async () =>
			textResponse(200, AD)) as unknown as typeof fetch);
		expect(await resolver.checkAdBreak("https://x/source.m3u8")).toBe(true);
	});

	test("false for a clean playlist", async () => {
		const resolver = new TwitchGqlResolver(noopLogger, (async () =>
			textResponse(200, CLEAN)) as unknown as typeof fetch);
		expect(await resolver.checkAdBreak("https://x/source.m3u8")).toBe(false);
	});

	test("false (best-effort) on a non-OK playlist fetch", async () => {
		const resolver = new TwitchGqlResolver(noopLogger, (async () =>
			textResponse(500, "boom")) as unknown as typeof fetch);
		expect(await resolver.checkAdBreak("https://x/source.m3u8")).toBe(false);
	});

	test("false (best-effort) on a network error", async () => {
		const resolver = new TwitchGqlResolver(noopLogger, (async () => {
			throw new Error("network down");
		}) as unknown as typeof fetch);
		expect(await resolver.checkAdBreak("https://x/source.m3u8")).toBe(false);
	});

	test("cache-busts the playlist url with a query param", async () => {
		let seenUrl = "";
		const resolver = new TwitchGqlResolver(noopLogger, (async (u: string) => {
			seenUrl = u;
			return textResponse(200, CLEAN);
		}) as unknown as typeof fetch);
		await resolver.checkAdBreak("https://x/source.m3u8");
		expect(seenUrl).toMatch(/[?&]_=\d+/);
	});
});
