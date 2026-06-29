import type { TwitchChannel } from "./twitch-channel";

/**
 * Resolves a live Twitch channel to a ready-to-consume HLS source variant URL.
 *
 * Implementations encapsulate the GQL auth + usher negotiation. They must throw
 * `ChannelOfflineError` for offline channels, `AuthFailureError` when Twitch
 * rejects the anonymous auth contract, and `RetrievalError` for other faults.
 */
export interface StreamResolver {
	/** @returns the source-quality media playlist URL for the live channel. */
	resolveSourceUrl(channel: TwitchChannel): Promise<string>;
}

/** Captures a single frame from an HLS stream URL and returns the encoded image. */
export interface FrameGrabber {
	/**
	 * @param streamUrl an HLS media/variant playlist URL.
	 * @returns the encoded image bytes (PNG).
	 */
	grabFrame(streamUrl: string): Promise<Buffer>;
}

/**
 * Sink for operational/audit events about the Twitch auth contract's health.
 * Backed by a Discord channel in production.
 */
export interface AuditLogger {
	/** The anonymous auth/retrieval contract appears broken (likely Twitch changed it). */
	reportAuthFailure(detail: {
		channel: string;
		message: string;
		stage: string;
		status?: number;
		body?: string;
	}): Promise<void>;
	/** Retrieval succeeded after a prior failure — the contract is working again. */
	reportRecovery(detail: { channel: string }): Promise<void>;
}

/** Minimal structured logger surface, decoupled from the concrete logging library. */
export interface Logger {
	debug(obj: object | string, msg?: string): void;
	info(obj: object | string, msg?: string): void;
	warn(obj: object | string, msg?: string): void;
	error(obj: object | string, msg?: string): void;
	/** Create a child logger with bound context fields. */
	child(bindings: Record<string, unknown>): Logger;
}
