import { describe, expect, test } from "bun:test";
import { sanitizeForLog } from "./sanitize-for-log";

describe("sanitizeForLog", () => {
	test("replaces a Buffer with a byte-count placeholder", () => {
		expect(sanitizeForLog(Buffer.alloc(2_000_000))).toBe(
			"[Binary 2000000 bytes]",
		);
	});

	test("replaces a Uint8Array with a placeholder", () => {
		expect(sanitizeForLog(new Uint8Array(128))).toBe("[Binary 128 bytes]");
	});

	test("replaces a dense numeric (serialized byte) array", () => {
		const bytes = Array.from({ length: 50 }, () => 255);
		expect(sanitizeForLog(bytes)).toBe("[Binary ~50 bytes]");
	});

	test("leaves a short numeric array untouched", () => {
		expect(sanitizeForLog([1, 2, 3])).toEqual([1, 2, 3]);
	});

	test("sanitizes buffers nested inside objects in place", () => {
		// `unknown`-typed fields so the post-sanitization string assertions type-check.
		const payload: { code: number; data: { frame: unknown }; msg: string } = {
			code: 4014,
			data: { frame: Buffer.alloc(5) },
			msg: "Used disallowed intents",
		};
		const result = sanitizeForLog(payload) as typeof payload;
		expect(result).toBe(payload); // same reference (mutated in place)
		expect(result.data.frame).toBe("[Binary 5 bytes]");
		expect(result.msg).toBe("Used disallowed intents");
		expect(result.code).toBe(4014);
	});

	test("sanitizes buffers attached to Error instances", () => {
		const err = new Error("boom") as Error & { payload?: unknown };
		err.payload = Buffer.alloc(10);
		sanitizeForLog(err);
		expect((err as Error & { payload?: unknown }).payload).toBe(
			"[Binary 10 bytes]",
		);
		expect(err.message).toBe("boom");
	});

	test("does not recurse past the depth guard", () => {
		// Build a chain deeper than the guard; should not throw.
		let nested: Record<string, unknown> = { buf: Buffer.alloc(4) };
		for (let i = 0; i < 15; i++) nested = { next: nested };
		expect(() => sanitizeForLog(nested)).not.toThrow();
	});

	test("passes through primitives", () => {
		expect(sanitizeForLog("hi")).toBe("hi");
		expect(sanitizeForLog(42)).toBe(42);
		expect(sanitizeForLog(null)).toBeNull();
	});
});
