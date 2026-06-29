import type { StreamMetadata } from "../../domain/ports";

/**
 * Render the shared "live" headline for both the slash command and auto-embed
 * replies, so the two presentations stay in sync.
 *
 * Format: `📸 <slug> — <title>`, where `<slug>` is the bold channel login,
 * optionally wrapped in a markdown link. When no title is available it falls
 * back to `📸 <slug> is live`. Category and viewer count, when present, are
 * appended on a subtle second line.
 *
 * @param channelLogin the channel slug to display (already normalized).
 * @param metadata best-effort broadcast metadata; any field may be missing.
 * @param link when provided, render the slug as a markdown link to this URL.
 *   The URL is wrapped in `<...>` (i.e. `[text](<url>)`) so Discord does NOT
 *   unfurl it into a profile embed — a markdown link alone does not suppress the
 *   unfurl; only the angle brackets do. Omit it for auto-embed replies, where
 *   the link already lives in the user's original message.
 */
export function formatLiveHeadline(
	channelLogin: string,
	metadata: StreamMetadata | undefined,
	link?: string,
): string {
	const slug =
		link !== undefined
			? `[**${channelLogin}**](<${link}>)`
			: `**${channelLogin}**`;
	const title = metadata?.title?.trim();
	const headline =
		title !== undefined && title.length > 0
			? `📸 ${slug} — ${title}`
			: `📸 ${slug} is live`;

	// Append a compact detail line for category/viewers when available.
	const details: string[] = [];
	if (metadata?.game !== undefined && metadata.game.length > 0) {
		details.push(metadata.game);
	}
	if (metadata?.viewersCount !== undefined) {
		details.push(`${metadata.viewersCount.toLocaleString("en-US")} viewers`);
	}
	return details.length > 0
		? `${headline}\n-# ${details.join(" · ")}`
		: headline;
}

/**
 * Render the one-off notice shown when a channel is in a commercial break, so
 * no screenshot could be grabbed. Reuses {@link formatLiveHeadline} and appends
 * a single ad-break line. There is no timer and no follow-up — we report it once.
 */
export function formatAdBreakNotice(
	channelLogin: string,
	metadata: StreamMetadata | undefined,
	link?: string,
): string {
	const headline = formatLiveHeadline(channelLogin, metadata, link);
	return `${headline}\n⚠️ Commercial ad break in progress`;
}
