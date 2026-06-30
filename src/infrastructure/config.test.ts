import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { ConfigError, loadConfig } from "./config";

/** Env keys this suite mutates, restored after each test. */
const TOUCHED = [
	"DISCORD_TOKEN",
	"DISCORD_APP_ID",
	"AUDIT_CHANNEL",
	"RATE_LIMIT_PER_USER",
	"RATE_LIMIT_PER_CHANNEL",
] as const;

let saved: Record<string, string | undefined>;

beforeEach(() => {
	saved = Object.fromEntries(TOUCHED.map((k) => [k, process.env[k]]));
	// Minimal required config so loadConfig() reaches the optional parsing.
	process.env.DISCORD_TOKEN = "token";
	process.env.DISCORD_APP_ID = "app";
	process.env.AUDIT_CHANNEL = "audit";
	process.env.RATE_LIMIT_PER_USER = undefined;
	process.env.RATE_LIMIT_PER_CHANNEL = undefined;
});

afterEach(() => {
	for (const key of TOUCHED) {
		const value = saved[key];
		if (value === undefined) delete process.env[key];
		else process.env[key] = value;
	}
});

describe("loadConfig rate-limit windows", () => {
	test("defaults both windows to 60 seconds when unset", () => {
		delete process.env.RATE_LIMIT_PER_USER;
		delete process.env.RATE_LIMIT_PER_CHANNEL;
		const config = loadConfig();
		expect(config.rateLimitPerUserSeconds).toBe(60);
		expect(config.rateLimitPerChannelSeconds).toBe(60);
	});

	test("parses explicit positive-integer overrides", () => {
		process.env.RATE_LIMIT_PER_USER = "30";
		process.env.RATE_LIMIT_PER_CHANNEL = "120";
		const config = loadConfig();
		expect(config.rateLimitPerUserSeconds).toBe(30);
		expect(config.rateLimitPerChannelSeconds).toBe(120);
	});

	test("rejects zero", () => {
		process.env.RATE_LIMIT_PER_USER = "0";
		expect(() => loadConfig()).toThrow(ConfigError);
	});

	test("rejects negative values", () => {
		process.env.RATE_LIMIT_PER_CHANNEL = "-5";
		expect(() => loadConfig()).toThrow(ConfigError);
	});

	test("rejects non-integer values", () => {
		process.env.RATE_LIMIT_PER_USER = "1.5";
		expect(() => loadConfig()).toThrow(ConfigError);
	});

	test("rejects non-numeric values", () => {
		process.env.RATE_LIMIT_PER_CHANNEL = "soon";
		expect(() => loadConfig()).toThrow(ConfigError);
	});
});
