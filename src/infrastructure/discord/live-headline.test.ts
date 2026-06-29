import { describe, expect, test } from "bun:test";
import { formatAdBreakNotice, formatLiveHeadline } from "./live-headline";

describe("formatLiveHeadline", () => {
	test("bold slug, no link, with title and details", () => {
		expect(
			formatLiveHeadline("jinnytty", {
				title: "HOKKAIDO DAY 2",
				game: "Just Chatting",
				viewersCount: 4031,
			}),
		).toBe(
			"📸 **jinnytty** — HOKKAIDO DAY 2\n-# Just Chatting · 4,031 viewers",
		);
	});

	test("renders a markdown link with the url wrapped in <> to suppress the unfurl", () => {
		expect(
			formatLiveHeadline(
				"jinnytty",
				{ title: "stream title" },
				"https://www.twitch.tv/jinnytty",
			),
		).toBe(
			"📸 [**jinnytty**](<https://www.twitch.tv/jinnytty>) — stream title",
		);
	});

	test("falls back to 'is live' when no title", () => {
		expect(formatLiveHeadline("foo", undefined)).toBe("📸 **foo** is live");
	});

	test("falls back to 'is live' for a blank/whitespace title", () => {
		expect(formatLiveHeadline("foo", { title: "   " })).toBe(
			"📸 **foo** is live",
		);
	});

	test("trims surrounding whitespace from the title", () => {
		expect(formatLiveHeadline("foo", { title: "  spaced  " })).toBe(
			"📸 **foo** — spaced",
		);
	});

	test("includes only the available detail fields", () => {
		expect(formatLiveHeadline("foo", { title: "t", viewersCount: 5 })).toBe(
			"📸 **foo** — t\n-# 5 viewers",
		);
		expect(formatLiveHeadline("foo", { title: "t", game: "Chess" })).toBe(
			"📸 **foo** — t\n-# Chess",
		);
	});

	test("renders a detail line even with the 'is live' fallback", () => {
		expect(formatLiveHeadline("foo", { game: "Chess", viewersCount: 10 })).toBe(
			"📸 **foo** is live\n-# Chess · 10 viewers",
		);
	});

	test("formats large viewer counts with thousands separators", () => {
		expect(
			formatLiveHeadline("foo", { title: "t", viewersCount: 1234567 }),
		).toBe("📸 **foo** — t\n-# 1,234,567 viewers");
	});
});

describe("formatAdBreakNotice", () => {
	test("appends the ad-break line to the headline (no link)", () => {
		expect(formatAdBreakNotice("foo", { title: "t" })).toBe(
			"📸 **foo** — t\n⚠️ Commercial ad break in progress",
		);
	});

	test("includes the linked slug for the slash command", () => {
		expect(
			formatAdBreakNotice("foo", { title: "t" }, "https://www.twitch.tv/foo"),
		).toBe(
			"📸 [**foo**](<https://www.twitch.tv/foo>) — t\n⚠️ Commercial ad break in progress",
		);
	});

	test("works with the 'is live' fallback and detail line", () => {
		expect(formatAdBreakNotice("foo", { game: "Chess", viewersCount: 5 })).toBe(
			"📸 **foo** is live\n-# Chess · 5 viewers\n⚠️ Commercial ad break in progress",
		);
	});
});
