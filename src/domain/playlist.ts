import { RetrievalError } from "./errors";

/** A single quality variant parsed from an HLS master playlist. */
export interface StreamVariant {
	/** Direct URL to the variant's media playlist. */
	url: string;
	/** Advertised bandwidth in bits/s; used to rank quality. */
	bandwidth: number;
	/** `WxH` resolution if present (audio-only variants have none). */
	resolution?: string;
	/** Group id, e.g. `chunked` for the source variant. */
	groupId?: string;
	/** Human-facing name, e.g. `1080p60 (source)`. */
	name?: string;
}

const STREAM_INF = "#EXT-X-STREAM-INF:";
const MEDIA = "#EXT-X-MEDIA:";

/** Pull a quoted or bare attribute value out of an HLS attribute list. */
function attr(line: string, key: string): string | undefined {
	const match = line.match(new RegExp(`${key}=("([^"]*)"|[^,]*)`));
	if (!match) return undefined;
	return match[2] ?? match[1];
}

/**
 * Parse a Twitch HLS master playlist into its variants.
 *
 * Twitch emits one `#EXT-X-MEDIA` line (carrying the GROUP-ID/NAME, e.g.
 * `chunked` / `1080p60 (source)`) immediately followed by a
 * `#EXT-X-STREAM-INF` line and then the variant URL. We pair each STREAM-INF
 * with the most recently seen MEDIA line to recover the group/name metadata.
 *
 * @throws {RetrievalError} if the playlist contains no usable video variants.
 */
export function parseMasterPlaylist(playlist: string): StreamVariant[] {
	const lines = playlist.split("\n").map((l) => l.trim());
	const variants: StreamVariant[] = [];

	let pendingMedia: { groupId?: string; name?: string } | null = null;
	let pendingStreamInf: string | null = null;

	for (const line of lines) {
		if (line.startsWith(MEDIA)) {
			pendingMedia = {
				groupId: attr(line, "GROUP-ID"),
				name: attr(line, "NAME"),
			};
			continue;
		}
		if (line.startsWith(STREAM_INF)) {
			pendingStreamInf = line;
			continue;
		}
		if (pendingStreamInf && line.startsWith("http")) {
			const bandwidthRaw = attr(pendingStreamInf, "BANDWIDTH");
			const bandwidth = bandwidthRaw ? Number.parseInt(bandwidthRaw, 10) : 0;
			variants.push({
				url: line,
				bandwidth: Number.isFinite(bandwidth) ? bandwidth : 0,
				resolution: attr(pendingStreamInf, "RESOLUTION"),
				groupId: pendingMedia?.groupId,
				name: pendingMedia?.name,
			});
			pendingStreamInf = null;
			pendingMedia = null;
		}
	}

	if (variants.length === 0) {
		throw new RetrievalError("Master playlist contained no stream variants");
	}

	return variants;
}

/** HLS daterange CLASS Twitch uses to mark a stitched commercial. */
const STITCHED_AD_CLASS = 'CLASS="twitch-stitched-ad"';

/**
 * Whether a Twitch source *media* playlist currently contains a stitched ad.
 *
 * Twitch marks an ad window with an `#EXT-X-DATERANGE` line carrying
 * `CLASS="twitch-stitched-ad"`. A frame grabbed while one is present is the ad
 * creative, not the stream. We use `playerType: "embed"` to avoid prerolls, so
 * this is a rare-case mid-roll detector rather than the norm.
 */
export function hasAdBreak(mediaPlaylist: string): boolean {
	return mediaPlaylist.includes(STITCHED_AD_CLASS);
}

/**
 * Select the best video variant for a source-quality screenshot.
 *
 * Prefers the `chunked` group (Twitch's source/passthrough ingest), falling
 * back to the highest-bandwidth non-audio variant. Audio-only variants (no
 * resolution) are excluded.
 *
 * @throws {RetrievalError} if no video variant is available.
 */
export function selectSourceVariant(variants: StreamVariant[]): StreamVariant {
	const video = variants.filter(
		(v) => v.resolution !== undefined && v.groupId !== "audio_only",
	);
	const pool = video.length > 0 ? video : variants;

	const chunked = pool.find((v) => v.groupId === "chunked");
	if (chunked) return chunked;

	const best = pool.reduce<StreamVariant | null>(
		(acc, v) => (acc === null || v.bandwidth > acc.bandwidth ? v : acc),
		null,
	);

	if (best === null) {
		throw new RetrievalError("No video variant available for screenshot");
	}
	return best;
}
