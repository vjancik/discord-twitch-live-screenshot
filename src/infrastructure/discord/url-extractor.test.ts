import { describe, expect, test } from "bun:test";
import { extractChannels } from "./url-extractor";

describe("extractChannels", () => {
	test("finds a single channel url in prose", () => {
		const logins = extractChannels(
			"check out https://twitch.tv/lirik tonight!",
		).map((c) => c.login);
		expect(logins).toEqual(["lirik"]);
	});

	test("trims trailing punctuation", () => {
		const logins = extractChannels("watch (https://twitch.tv/lirik).").map(
			(c) => c.login,
		);
		expect(logins).toEqual(["lirik"]);
	});

	test("deduplicates the same channel by login", () => {
		const logins = extractChannels(
			"https://twitch.tv/Lirik and https://www.twitch.tv/lirik",
		).map((c) => c.login);
		expect(logins).toEqual(["lirik"]);
	});

	test("returns multiple distinct channels", () => {
		const logins = extractChannels(
			"https://twitch.tv/lirik vs https://twitch.tv/shroud",
		).map((c) => c.login);
		expect(logins).toEqual(["lirik", "shroud"]);
	});

	test("ignores VOD and clip urls", () => {
		const text =
			"https://twitch.tv/videos/123 https://clips.twitch.tv/Foo https://twitch.tv/lirik/clip/Bar";
		expect(extractChannels(text)).toHaveLength(0);
	});

	test("ignores bare 'twitch' mentions without a url", () => {
		expect(extractChannels("I love twitch streams")).toHaveLength(0);
	});
});
