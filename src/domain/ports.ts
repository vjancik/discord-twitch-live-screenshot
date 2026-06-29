import type { TwitchChannel } from "./twitch-channel";

/**
 * Best-effort metadata about a live broadcast (title, category, viewers).
 * Every field is optional: it is decorative, fetched alongside the source URL,
 * and its absence must never block a screenshot.
 */
export interface StreamMetadata {
	/** The current stream title (from the channel's last broadcast). */
	title?: string;
	/** The category / game display name. */
	game?: string;
	/** Current concurrent viewer count. */
	viewersCount?: number;
}

/** A resolved live channel: the HLS source URL plus any best-effort metadata. */
export interface ResolvedStream {
	/** The source-quality media playlist URL for the live channel. */
	sourceUrl: string;
	/** Decorative broadcast metadata; undefined if the metadata fetch failed. */
	metadata?: StreamMetadata;
}

/**
 * Resolves a live Twitch channel to a ready-to-consume HLS source variant URL.
 *
 * Implementations encapsulate the GQL auth + usher negotiation. They must throw
 * `ChannelOfflineError` for offline channels, `AuthFailureError` when Twitch
 * rejects the anonymous auth contract, and `RetrievalError` for other faults.
 */
export interface StreamResolver {
	/** @returns the source-quality playlist URL and best-effort metadata. */
	resolve(channel: TwitchChannel): Promise<ResolvedStream>;

	/**
	 * Inspect the source media playlist for an in-progress stitched ad break
	 * (a mid-roll). A frame grabbed during one would be the ad, not the stream.
	 *
	 * @param sourceUrl a source variant playlist URL from {@link resolve}.
	 * @returns true if an ad is currently stitched into the playlist. Best-effort:
	 *   on any fetch/parse failure, resolves to `false` so capture proceeds.
	 */
	checkAdBreak(sourceUrl: string): Promise<boolean>;
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
