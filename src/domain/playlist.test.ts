import { describe, expect, test } from "bun:test";
import { RetrievalError } from "./errors";
import {
	hasAdBreak,
	parseMasterPlaylist,
	selectSourceVariant,
} from "./playlist";

const SAMPLE = `#EXTM3U
#EXT-X-TWITCH-INFO:NODE="..."
#EXT-X-MEDIA:TYPE=VIDEO,GROUP-ID="chunked",NAME="1080p60 (source)",AUTOSELECT=YES,DEFAULT=YES
#EXT-X-STREAM-INF:BANDWIDTH=8579821,RESOLUTION=1920x1080,CODECS="avc1.64002A,mp4a.40.2",VIDEO="chunked",FRAME-RATE=60.000
https://example.ttvnw.net/source.m3u8
#EXT-X-MEDIA:TYPE=VIDEO,GROUP-ID="720p60",NAME="720p60",AUTOSELECT=YES,DEFAULT=YES
#EXT-X-STREAM-INF:BANDWIDTH=3422999,RESOLUTION=1280x720,CODECS="avc1.4D401F,mp4a.40.2",VIDEO="720p60",FRAME-RATE=60.000
https://example.ttvnw.net/720.m3u8
#EXT-X-MEDIA:TYPE=VIDEO,GROUP-ID="audio_only",NAME="audio_only",AUTOSELECT=NO,DEFAULT=NO
#EXT-X-STREAM-INF:BANDWIDTH=160000,CODECS="mp4a.40.2",VIDEO="audio_only"
https://example.ttvnw.net/audio.m3u8`;

describe("parseMasterPlaylist", () => {
	test("parses all variants with metadata", () => {
		const variants = parseMasterPlaylist(SAMPLE);
		expect(variants).toHaveLength(3);
		expect(variants[0]).toMatchObject({
			url: "https://example.ttvnw.net/source.m3u8",
			bandwidth: 8579821,
			resolution: "1920x1080",
			groupId: "chunked",
			name: "1080p60 (source)",
		});
		expect(variants[2]).toMatchObject({
			groupId: "audio_only",
			resolution: undefined,
		});
	});

	test("throws on a playlist with no variants", () => {
		expect(() => parseMasterPlaylist("#EXTM3U\n")).toThrow(RetrievalError);
	});
});

describe("selectSourceVariant", () => {
	test("prefers the chunked (source) group", () => {
		const variant = selectSourceVariant(parseMasterPlaylist(SAMPLE));
		expect(variant.groupId).toBe("chunked");
		expect(variant.resolution).toBe("1920x1080");
	});

	test("falls back to highest-bandwidth video when no chunked group exists", () => {
		const variants = parseMasterPlaylist(SAMPLE).filter(
			(v) => v.groupId !== "chunked",
		);
		const variant = selectSourceVariant(variants);
		expect(variant.resolution).toBe("1280x720");
	});

	test("excludes audio-only variants from selection", () => {
		const audioOnly = parseMasterPlaylist(SAMPLE).filter(
			(v) => v.groupId === "audio_only",
		);
		// Only audio remains -> pool falls back to it, but it has no resolution.
		const variant = selectSourceVariant(audioOnly);
		expect(variant.groupId).toBe("audio_only");
	});
});

describe("hasAdBreak", () => {
	test("detects a stitched-ad daterange", () => {
		const playlist = `#EXTM3U
#EXT-X-DATERANGE:ID="stitched-ad-1",CLASS="twitch-stitched-ad",START-DATE="2026-06-29T09:00:00.000Z",DURATION=30.000
#EXT-X-DISCONTINUITY
#EXTINF:2.0,
https://example.ttvnw.net/ad-seg.ts`;
		expect(hasAdBreak(playlist)).toBe(true);
	});

	test("returns false for a clean playlist", () => {
		const playlist = `#EXTM3U
#EXT-X-DATERANGE:ID="session-1",CLASS="twitch-session",START-DATE="2026-06-29T09:00:00.000Z"
#EXTINF:2.0,
https://example.ttvnw.net/seg.ts`;
		expect(hasAdBreak(playlist)).toBe(false);
	});
});
