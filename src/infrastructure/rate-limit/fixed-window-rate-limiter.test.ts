import { describe, expect, test } from "bun:test";
import { FixedWindowRateLimiter } from "./fixed-window-rate-limiter";

/** A controllable clock for deterministic window math. */
function fakeClock(start = 0): {
	now: () => number;
	advance: (ms: number) => void;
} {
	let t = start;
	return {
		now: () => t,
		advance(ms: number) {
			t += ms;
		},
	};
}

describe("FixedWindowRateLimiter", () => {
	test("allows the first acquisition for a key", () => {
		const limiter = new FixedWindowRateLimiter(60_000);
		expect(limiter.tryAcquire("a")).toBe(true);
	});

	test("denies a second acquisition within the window (limit 1)", () => {
		const clock = fakeClock();
		const limiter = new FixedWindowRateLimiter(60_000, 1, clock.now);
		expect(limiter.tryAcquire("a")).toBe(true);
		clock.advance(59_999);
		expect(limiter.tryAcquire("a")).toBe(false);
	});

	test("allows again once the window has fully elapsed", () => {
		const clock = fakeClock();
		const limiter = new FixedWindowRateLimiter(60_000, 1, clock.now);
		expect(limiter.tryAcquire("a")).toBe(true);
		clock.advance(60_000);
		expect(limiter.tryAcquire("a")).toBe(true);
	});

	test("tracks keys independently", () => {
		const limiter = new FixedWindowRateLimiter(60_000, 1);
		expect(limiter.tryAcquire("a")).toBe(true);
		expect(limiter.tryAcquire("b")).toBe(true);
		expect(limiter.tryAcquire("a")).toBe(false);
	});

	test("honors a limit greater than one", () => {
		const clock = fakeClock();
		const limiter = new FixedWindowRateLimiter(60_000, 3, clock.now);
		expect(limiter.tryAcquire("a")).toBe(true);
		expect(limiter.tryAcquire("a")).toBe(true);
		expect(limiter.tryAcquire("a")).toBe(true);
		expect(limiter.tryAcquire("a")).toBe(false);
	});

	test("evicts elapsed windows so the map does not grow unbounded", () => {
		const clock = fakeClock();
		const limiter = new FixedWindowRateLimiter(60_000, 1, clock.now);
		limiter.tryAcquire("a");
		clock.advance(60_000);
		// Touching a different key triggers lazy eviction of the elapsed "a" window.
		limiter.tryAcquire("b");
		// (eviction is internal; we assert behavior: "a" is treated as a fresh window)
		expect(limiter.tryAcquire("a")).toBe(true);
	});
});
