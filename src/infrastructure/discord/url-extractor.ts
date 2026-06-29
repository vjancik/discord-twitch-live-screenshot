import { TwitchChannel } from "../../domain/twitch-channel";

/** Matches http(s) Twitch URLs (any twitch subdomain) embedded in free text. */
const TWITCH_URL_PATTERN = /https?:\/\/(?:[\w-]+\.)?twitch\.tv\/\S+/gi;

/**
 * Extract distinct, live-streamable Twitch channels from a block of message text.
 *
 * Only `http(s)` Twitch URLs are considered (a bare word like "twitch" in chat
 * must not trigger the bot). VOD and clip URLs are filtered out by
 * {@link TwitchChannel.tryParse}. Results are de-duplicated by login so the same
 * channel is screenshotted at most once per message.
 */
export function extractChannels(text: string): TwitchChannel[] {
	const matches = text.match(TWITCH_URL_PATTERN);
	if (matches === null) return [];

	const byLogin = new Map<string, TwitchChannel>();
	for (const raw of matches) {
		// Trim trailing punctuation that commonly clings to URLs in prose.
		const cleaned = raw.replace(/[.,;:!?)\]}>'"]+$/, "");
		const channel = TwitchChannel.tryParse(cleaned);
		if (channel !== null && !byLogin.has(channel.login)) {
			byLogin.set(channel.login, channel);
		}
	}
	return [...byLogin.values()];
}
