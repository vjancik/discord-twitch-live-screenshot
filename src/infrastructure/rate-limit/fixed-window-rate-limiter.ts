import type { RateLimiter } from "../../domain/ports";

/** Per-key window state. */
interface Window {
	/** Epoch ms when the current window started. */
	windowStart: number;
	/** Units consumed within the current window. */
	count: number;
}

/**
 * In-memory {@link RateLimiter} using a fixed-window counter per key.
 *
 * Each key is allowed at most `limit` acquisitions per `windowMs`. When a key's
 * window expires, the next acquisition opens a fresh window. State is held in a
 * `Map` and stale entries are evicted lazily (on access) once their window has
 * fully elapsed, keeping the map bounded without a background timer.
 *
 * Fixed-window (rather than sliding/token-bucket) is deliberate: the bot only
 * needs an allow/deny decision — it never surfaces a retry-after — so the
 * cheapest correct algorithm wins. The clock is injectable for deterministic
 * tests, mirroring {@link EmbedSuppressionTracker}.
 */
export class FixedWindowRateLimiter implements RateLimiter {
	private readonly windows = new Map<string, Window>();

	/**
	 * @param windowMs length of each window in ms.
	 * @param limit max acquisitions permitted per window (default 1).
	 * @param now injectable clock for deterministic tests.
	 */
	constructor(
		private readonly windowMs: number,
		private readonly limit = 1,
		private readonly now: () => number = Date.now,
	) {}

	tryAcquire(key: string): boolean {
		const current = this.now();
		this.evictExpired(current);

		const existing = this.windows.get(key);
		// No live window, or the previous one has fully elapsed → open a fresh one.
		if (
			existing === undefined ||
			current - existing.windowStart >= this.windowMs
		) {
			this.windows.set(key, { windowStart: current, count: 1 });
			return true;
		}

		if (existing.count >= this.limit) return false;
		existing.count += 1;
		return true;
	}

	/** Drop windows that have fully elapsed, so the map stays bounded. */
	private evictExpired(current: number): void {
		for (const [key, window] of this.windows) {
			if (current - window.windowStart >= this.windowMs) {
				this.windows.delete(key);
			}
		}
	}
}
