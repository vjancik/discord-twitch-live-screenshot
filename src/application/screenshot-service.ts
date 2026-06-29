import { AuthFailureError, ChannelOfflineError } from "../domain/errors";
import type {
	AuditLogger,
	FrameGrabber,
	Logger,
	StreamMetadata,
	StreamResolver,
} from "../domain/ports";
import type { TwitchChannel } from "../domain/twitch-channel";

/** Narrow capture surface consumed by delivery adapters (e.g. the Discord bot). */
export interface ScreenshotCapturer {
	capture(channel: TwitchChannel): Promise<CaptureResult>;
}

/** Outcome of a screenshot capture attempt. */
export type CaptureResult =
	| {
			status: "ok";
			image: Buffer;
			channel: string;
			/** Best-effort broadcast metadata (title/game/viewers); may be undefined. */
			metadata?: StreamMetadata;
	  }
	| { status: "offline"; channel: string }
	| { status: "auth_failure"; channel: string }
	| { status: "error"; channel: string };

/**
 * Orchestrates the capture pipeline: resolve a live channel to its source HLS
 * variant, then grab a single frame.
 *
 * Auth-contract health is tracked in-memory across calls. Because the resolver
 * uses Twitch's anonymous inline-GQL flow (no rotating secret), failures are
 * rare and indicate Twitch changed the contract rather than a transient hiccup;
 * when one occurs it is audited, and the first success afterwards is audited as
 * a recovery. There is intentionally no periodic probe — see README.
 */
export class ScreenshotService implements ScreenshotCapturer {
	private authHealthy = true;

	constructor(
		private readonly resolver: StreamResolver,
		private readonly grabber: FrameGrabber,
		private readonly audit: AuditLogger,
		private readonly logger: Logger,
	) {}

	/**
	 * Capture a source-quality frame for the given channel.
	 *
	 * Never throws: every failure mode is mapped to a {@link CaptureResult} so
	 * callers (slash command, auto-embed) can decide presentation. Detailed
	 * diagnostics are logged; auth failures are additionally audited.
	 */
	async capture(channel: TwitchChannel): Promise<CaptureResult> {
		const log = this.logger.child({ channel: channel.login });
		try {
			const { sourceUrl, metadata } = await this.resolver.resolve(channel);
			const image = await this.grabber.grabFrame(sourceUrl);
			log.info({ bytes: image.byteLength }, "Captured screenshot");
			await this.markHealthy(channel);
			return { status: "ok", image, channel: channel.login, metadata };
		} catch (err) {
			return await this.handleFailure(channel, log, err);
		}
	}

	/** Map a thrown error to a result, logging and auditing as appropriate. */
	private async handleFailure(
		channel: TwitchChannel,
		log: Logger,
		err: unknown,
	): Promise<CaptureResult> {
		if (err instanceof ChannelOfflineError) {
			log.debug("Channel offline");
			// A successful offline determination still proves the auth contract works.
			await this.markHealthy(channel);
			return { status: "offline", channel: channel.login };
		}

		if (err instanceof AuthFailureError) {
			log.error({ err, detail: err.detail }, "Twitch auth contract failure");
			this.authHealthy = false;
			await this.audit.reportAuthFailure({
				channel: channel.login,
				message: err.message,
				stage: err.detail.stage,
				status: err.detail.status,
				body: err.detail.body,
			});
			return { status: "auth_failure", channel: channel.login };
		}

		log.error({ err }, "Screenshot retrieval failed");
		return { status: "error", channel: channel.login };
	}

	/** Record a healthy contract, emitting a one-shot recovery audit on transition. */
	private async markHealthy(channel: TwitchChannel): Promise<void> {
		if (!this.authHealthy) {
			this.authHealthy = true;
			this.logger.info(
				{ channel: channel.login },
				"Twitch auth contract recovered",
			);
			await this.audit.reportRecovery({ channel: channel.login });
		}
	}
}
