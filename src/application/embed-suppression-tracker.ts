/** How long a message is tracked before its entry is evicted (ms). */
const DEFAULT_TTL_MS = 60_000;

/** Per-message suppression state. */
interface Entry {
	/** True once at least one screenshot was posted for this message. */
	shouldSuppress: boolean;
	/** True once we've issued the suppress call, so we never repeat it. */
	suppressed: boolean;
	/** Epoch ms when this entry was created; used for TTL eviction. */
	createdAt: number;
}

/**
 * Coordinates embed suppression across the two Discord events that race:
 *   - `messageCreate` → we start capturing and (on success) decide to suppress;
 *   - `messageUpdate` → Discord attaches the auto-unfurl embed.
 *
 * The native Twitch embed is attached asynchronously, so it may appear before or
 * after our screenshot reply. This tracker records, per message id, whether a
 * screenshot was posted (`shouldSuppress`) and whether we've already suppressed,
 * so suppression fires exactly once regardless of event ordering. Entries are
 * evicted after a TTL to keep the map bounded.
 *
 * Pure application logic with no Discord/runtime dependencies, so the ordering
 * decisions are unit-testable. The caller performs the actual suppress side
 * effect when {@link onScreenshotPosted} or {@link onEmbedAppeared} returns true.
 */
export class EmbedSuppressionTracker {
	private readonly entries = new Map<string, Entry>();

	constructor(
		private readonly ttlMs = DEFAULT_TTL_MS,
		/** Injectable clock for deterministic tests. */
		private readonly now: () => number = Date.now,
	) {}

	/**
	 * Begin tracking a message that contains Twitch channel link(s). Idempotent:
	 * re-tracking an already-tracked message leaves existing state intact.
	 */
	track(messageId: string): void {
		this.evictExpired();
		if (!this.entries.has(messageId)) {
			this.entries.set(messageId, {
				shouldSuppress: false,
				suppressed: false,
				createdAt: this.now(),
			});
		}
	}

	/**
	 * Record that a screenshot was successfully posted for the message.
	 *
	 * @param embedPresent whether the native auto-embed is already attached to the
	 *   message at this point (the caller knows from the live message object).
	 * @returns true if the caller should suppress the message's embeds now — only
	 *   when the embed already exists. When it does not, suppression is deferred:
	 *   {@link onEmbedAppeared} will return true once Discord attaches the embed.
	 */
	onScreenshotPosted(messageId: string, embedPresent: boolean): boolean {
		const entry = this.entries.get(messageId);
		if (entry === undefined) return false;
		entry.shouldSuppress = true;
		// Nothing to suppress yet — wait for the messageUpdate that adds the embed
		// so we don't burn the one-shot claim on a no-op API call.
		if (!embedPresent) return false;
		return this.claimSuppression(entry);
	}

	/**
	 * Record that Discord attached an embed to the message (a `messageUpdate`).
	 *
	 * @returns true if the caller should suppress now — only when we've already
	 *   decided to suppress (a screenshot was posted) and haven't done so yet.
	 */
	onEmbedAppeared(messageId: string): boolean {
		const entry = this.entries.get(messageId);
		if (entry === undefined) return false;
		if (!entry.shouldSuppress) return false;
		return this.claimSuppression(entry);
	}

	/** Stop tracking a message (e.g. once suppression is confirmed done). */
	forget(messageId: string): void {
		this.entries.delete(messageId);
	}

	/** Atomically claim the one-shot suppress action for an entry. */
	private claimSuppression(entry: Entry): boolean {
		if (entry.suppressed) return false;
		entry.suppressed = true;
		return true;
	}

	/** Drop entries older than the TTL. */
	private evictExpired(): void {
		const cutoff = this.now() - this.ttlMs;
		for (const [id, entry] of this.entries) {
			if (entry.createdAt < cutoff) this.entries.delete(id);
		}
	}
}
