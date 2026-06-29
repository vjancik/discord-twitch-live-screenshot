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
const MASTER_PLAYLIST = `#EXTM3U
#EXT-X-MEDIA:TYPE=VIDEO,GROUP-ID="chunked",NAME="1080p60 (source)"
#EXT-X-STREAM-INF:BANDWIDTH=8579821,RESOLUTION=1920x1080,VIDEO="chunked"
https://example.ttvnw.net/source.m3u8`;

/** Build a fetch stub that returns the GQL response, then the usher response. */
function stubFetch(gql: Response, usher?: Response): typeof fetch {
	let call = 0;
	return (async () => {
		call += 1;
		if (call === 1) return gql;
		if (usher === undefined) throw new Error("unexpected second fetch");
		return usher;
	}) as unknown as typeof fetch;
}

describe("TwitchGqlResolver", () => {
	test("resolves the source variant url for a live channel", async () => {
		const resolver = new TwitchGqlResolver(
			noopLogger,
			stubFetch(
				jsonResponse(200, VALID_TOKEN),
				textResponse(200, MASTER_PLAYLIST),
			),
		);
		await expect(resolver.resolveSourceUrl(channel)).resolves.toBe(
			"https://example.ttvnw.net/source.m3u8",
		);
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
		await expect(resolver.resolveSourceUrl(channel)).rejects.toBeInstanceOf(
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
		await expect(resolver.resolveSourceUrl(channel)).rejects.toBeInstanceOf(
			ChannelOfflineError,
		);
	});

	test("maps GQL 403 to AuthFailureError", async () => {
		const resolver = new TwitchGqlResolver(
			noopLogger,
			stubFetch(textResponse(403, "forbidden")),
		);
		await expect(resolver.resolveSourceUrl(channel)).rejects.toBeInstanceOf(
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
		await expect(resolver.resolveSourceUrl(channel)).rejects.toBeInstanceOf(
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
		await expect(resolver.resolveSourceUrl(channel)).rejects.toBeInstanceOf(
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
		await expect(resolver.resolveSourceUrl(channel)).rejects.toBeInstanceOf(
			AuthFailureError,
		);
	});

	test("maps usher 5xx to RetrievalError", async () => {
		const usher = textResponse(503, "service unavailable");
		const resolver = new TwitchGqlResolver(
			noopLogger,
			stubFetch(jsonResponse(200, VALID_TOKEN), usher),
		);
		await expect(resolver.resolveSourceUrl(channel)).rejects.toBeInstanceOf(
			RetrievalError,
		);
	});
});
