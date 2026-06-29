import { describe, expect, mock, test } from "bun:test";
import {
	AuthFailureError,
	ChannelOfflineError,
	RetrievalError,
} from "../domain/errors";
import type {
	AuditLogger,
	FrameGrabber,
	Logger,
	StreamResolver,
} from "../domain/ports";
import { TwitchChannel } from "../domain/twitch-channel";
import { ScreenshotService } from "./screenshot-service";

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
const IMAGE = Buffer.from([0x89, 0x50, 0x4e, 0x47]);

function build(overrides: {
	resolve?: StreamResolver["resolve"];
	grab?: FrameGrabber["grabFrame"];
}) {
	const resolver: StreamResolver = {
		resolve:
			overrides.resolve ??
			mock(async () => ({ sourceUrl: "https://example/source.m3u8" })),
	};
	const grabber: FrameGrabber = {
		grabFrame: overrides.grab ?? mock(async () => IMAGE),
	};
	const audit: AuditLogger = {
		reportAuthFailure: mock(async () => {}),
		reportRecovery: mock(async () => {}),
	};
	const service = new ScreenshotService(resolver, grabber, audit, noopLogger);
	return { service, audit };
}

describe("ScreenshotService.capture", () => {
	test("returns ok with the image on success", async () => {
		const { service } = build({});
		const result = await service.capture(channel);
		expect(result).toEqual({
			status: "ok",
			image: IMAGE,
			channel: "somechannel",
			metadata: undefined,
		});
	});

	test("threads resolver metadata onto the ok result", async () => {
		const { service } = build({
			resolve: async () => ({
				sourceUrl: "https://example/source.m3u8",
				metadata: { title: "hi", game: "Chess", viewersCount: 7 },
			}),
		});
		const result = await service.capture(channel);
		expect(result).toMatchObject({
			status: "ok",
			metadata: { title: "hi", game: "Chess", viewersCount: 7 },
		});
	});

	test("returns offline (no audit) when channel is offline", async () => {
		const { service, audit } = build({
			resolve: async () => {
				throw new ChannelOfflineError("somechannel");
			},
		});
		const result = await service.capture(channel);
		expect(result.status).toBe("offline");
		expect(audit.reportAuthFailure).not.toHaveBeenCalled();
	});

	test("returns error (no audit) for generic retrieval failure", async () => {
		const { service, audit } = build({
			grab: async () => {
				throw new RetrievalError("ffmpeg blew up");
			},
		});
		const result = await service.capture(channel);
		expect(result.status).toBe("error");
		expect(audit.reportAuthFailure).not.toHaveBeenCalled();
	});

	test("audits auth failures", async () => {
		const { service, audit } = build({
			resolve: async () => {
				throw new AuthFailureError("nope", { stage: "gql", status: 403 });
			},
		});
		const result = await service.capture(channel);
		expect(result.status).toBe("auth_failure");
		expect(audit.reportAuthFailure).toHaveBeenCalledTimes(1);
	});

	test("audits a single recovery on the first success after a failure", async () => {
		let fail = true;
		const { service, audit } = build({
			resolve: async () => {
				if (fail)
					throw new AuthFailureError("nope", { stage: "gql", status: 403 });
				return { sourceUrl: "https://example/source.m3u8" };
			},
		});

		await service.capture(channel); // fails -> auth_failure
		fail = false;
		await service.capture(channel); // succeeds -> recovery
		await service.capture(channel); // succeeds -> no second recovery

		expect(audit.reportAuthFailure).toHaveBeenCalledTimes(1);
		expect(audit.reportRecovery).toHaveBeenCalledTimes(1);
	});

	test("a successful offline determination also triggers recovery", async () => {
		let mode: "auth" | "offline" = "auth";
		const { service, audit } = build({
			resolve: async () => {
				if (mode === "auth")
					throw new AuthFailureError("nope", { stage: "gql" });
				throw new ChannelOfflineError("somechannel");
			},
		});
		await service.capture(channel); // auth_failure
		mode = "offline";
		await service.capture(channel); // offline but contract works -> recovery
		expect(audit.reportRecovery).toHaveBeenCalledTimes(1);
	});
});
