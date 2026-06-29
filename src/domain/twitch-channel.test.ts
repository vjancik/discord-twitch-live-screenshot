import { describe, expect, test } from "bun:test";
import { InvalidChannelUrlError, UnsupportedTwitchUrlError } from "./errors";
import { TwitchChannel } from "./twitch-channel";

describe("TwitchChannel.parse", () => {
	test.each([
		["https://www.twitch.tv/somechannel", "somechannel"],
		["https://twitch.tv/SomeChannel", "somechannel"],
		["http://m.twitch.tv/food", "food"],
		["https://go.twitch.tv/food", "food"],
		["twitch.tv/lirik", "lirik"],
		["https://www.twitch.tv/miracle_doto#profile-0", "miracle_doto"],
		["https://player.twitch.tv/?channel=lotsofs", "lotsofs"],
		["somechannel", "somechannel"],
	])("accepts %s -> %s", (input, expected) => {
		expect(TwitchChannel.parse(input).login).toBe(expected);
	});

	test.each([
		["https://www.twitch.tv/videos/123456789"],
		["https://www.twitch.tv/videos"], // bare /videos route lists VODs
		["https://twitch.tv/somechannel/v/123456789"],
		["https://twitch.tv/somechannel/video/123456789"],
		["https://player.twitch.tv/?video=v123456789"],
	])("rejects VOD url %s", (input) => {
		expect(() => TwitchChannel.parse(input)).toThrow(UnsupportedTwitchUrlError);
	});

	test.each([
		["https://clips.twitch.tv/FaintLightGullWholeWheat"],
		["https://www.twitch.tv/xqc/clip/CulturedAmazingKuduDatSheffy"],
		["https://m.twitch.tv/rossbroadcast/clip/ConfidentBraveHumanChefFrank"],
	])("rejects clip url %s", (input) => {
		expect(() => TwitchChannel.parse(input)).toThrow(UnsupportedTwitchUrlError);
	});

	test.each([
		["https://www.twitch.tv/directory"],
		["https://www.twitch.tv/settings"],
		["https://example.com/somechannel"],
		["https://www.twitch.tv/"],
		["ab"], // too short for a login
		["this-has-dashes"], // dashes are not valid login chars
		["not a url at all !!"],
	])("rejects non-channel %s", (input) => {
		expect(() => TwitchChannel.parse(input)).toThrow(InvalidChannelUrlError);
	});

	test("exposes a canonical url", () => {
		expect(TwitchChannel.parse("twitch.tv/Lirik").url).toBe(
			"https://www.twitch.tv/lirik",
		);
	});
});

describe("TwitchChannel.tryParse", () => {
	test("returns null instead of throwing for invalid input", () => {
		expect(TwitchChannel.tryParse("https://clips.twitch.tv/foo")).toBeNull();
		expect(TwitchChannel.tryParse("https://example.com/foo")).toBeNull();
		expect(TwitchChannel.tryParse("a")).toBeNull(); // too short
	});
	test("returns a channel for valid input", () => {
		expect(TwitchChannel.tryParse("twitch.tv/lirik")?.login).toBe("lirik");
	});
});
