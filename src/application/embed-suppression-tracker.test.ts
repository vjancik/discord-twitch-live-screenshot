import { describe, expect, test } from "bun:test";
import { EmbedSuppressionTracker } from "./embed-suppression-tracker";

/** A controllable clock for deterministic TTL tests. */
function fakeClock(start = 0): {
	now: () => number;
	advance: (ms: number) => void;
} {
	let t = start;
	return { now: () => t, advance: (ms) => (t += ms) };
}

describe("EmbedSuppressionTracker", () => {
	test("untracked message never suppresses", () => {
		const tracker = new EmbedSuppressionTracker();
		expect(tracker.onScreenshotPosted("m1", true)).toBe(false);
		expect(tracker.onEmbedAppeared("m1")).toBe(false);
	});

	test("embed already present at screenshot time: suppress immediately", () => {
		const tracker = new EmbedSuppressionTracker();
		tracker.track("m1");
		// Embed already attached when the screenshot posts → suppress now.
		expect(tracker.onScreenshotPosted("m1", true)).toBe(true);
	});

	test("embed appears before screenshot: screenshot suppresses if present", () => {
		const tracker = new EmbedSuppressionTracker();
		tracker.track("m1");
		// A messageUpdate arrives before we've decided to suppress → no-op.
		expect(tracker.onEmbedAppeared("m1")).toBe(false);
		// Screenshot posts and the embed is present → suppress now.
		expect(tracker.onScreenshotPosted("m1", true)).toBe(true);
	});

	test("screenshot before embed: embed-appear triggers suppression", () => {
		const tracker = new EmbedSuppressionTracker();
		tracker.track("m1");
		// Screenshot posts but the embed hasn't landed yet → defer.
		expect(tracker.onScreenshotPosted("m1", false)).toBe(false);
		// Embed lands later via messageUpdate → suppress now.
		expect(tracker.onEmbedAppeared("m1")).toBe(true);
	});

	test("suppression is one-shot (immediate path)", () => {
		const tracker = new EmbedSuppressionTracker();
		tracker.track("m1");
		expect(tracker.onScreenshotPosted("m1", true)).toBe(true);
		// Subsequent signals must not re-trigger.
		expect(tracker.onScreenshotPosted("m1", true)).toBe(false);
		expect(tracker.onEmbedAppeared("m1")).toBe(false);
	});

	test("suppression is one-shot (deferred path)", () => {
		const tracker = new EmbedSuppressionTracker();
		tracker.track("m1");
		expect(tracker.onScreenshotPosted("m1", false)).toBe(false);
		expect(tracker.onEmbedAppeared("m1")).toBe(true);
		// A second embed-attach (e.g. another link) must not re-trigger.
		expect(tracker.onEmbedAppeared("m1")).toBe(false);
	});

	test("track is idempotent and preserves state", () => {
		const tracker = new EmbedSuppressionTracker();
		tracker.track("m1");
		expect(tracker.onScreenshotPosted("m1", false)).toBe(false); // decided, awaiting embed
		tracker.track("m1"); // re-track must not reset shouldSuppress
		expect(tracker.onEmbedAppeared("m1")).toBe(true);
	});

	test("forget stops tracking", () => {
		const tracker = new EmbedSuppressionTracker();
		tracker.track("m1");
		tracker.forget("m1");
		expect(tracker.onScreenshotPosted("m1", true)).toBe(false);
	});

	test("entries are evicted after the TTL", () => {
		const clock = fakeClock();
		const tracker = new EmbedSuppressionTracker(60_000, clock.now);
		tracker.track("m1");
		clock.advance(60_001);
		// A new track() triggers eviction; the stale m1 entry is gone.
		tracker.track("m2");
		expect(tracker.onScreenshotPosted("m1", true)).toBe(false);
		// m2 is fresh and works.
		expect(tracker.onScreenshotPosted("m2", true)).toBe(true);
	});

	test("entry within TTL survives", () => {
		const clock = fakeClock();
		const tracker = new EmbedSuppressionTracker(60_000, clock.now);
		tracker.track("m1");
		clock.advance(59_000);
		tracker.track("m2"); // triggers eviction sweep, but m1 is still fresh
		expect(tracker.onScreenshotPosted("m1", true)).toBe(true);
	});
});
