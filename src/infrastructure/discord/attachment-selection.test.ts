import { describe, expect, test } from "bun:test";
import { parseAttachmentSelection } from "./attachment-selection";

describe("parseAttachmentSelection", () => {
	test("parses a single 1-indexed position to a 0-based index", () => {
		expect(parseAttachmentSelection("1", 3)).toEqual({
			ok: true,
			indexes: [0],
		});
	});

	test("parses a comma-separated list", () => {
		expect(parseAttachmentSelection("1,3", 3)).toEqual({
			ok: true,
			indexes: [0, 2],
		});
	});

	test("ignores whitespace around tokens", () => {
		expect(parseAttachmentSelection(" 1 , 3 ", 3)).toEqual({
			ok: true,
			indexes: [0, 2],
		});
	});

	test("collapses duplicates and sorts ascending", () => {
		expect(parseAttachmentSelection("3,1,3,1", 3)).toEqual({
			ok: true,
			indexes: [0, 2],
		});
	});

	test('accepts "all" case-insensitively', () => {
		expect(parseAttachmentSelection("all", 3)).toEqual({
			ok: true,
			indexes: [0, 1, 2],
		});
		expect(parseAttachmentSelection(" ALL ", 2)).toEqual({
			ok: true,
			indexes: [0, 1],
		});
	});

	test("rejects empty input", () => {
		const result = parseAttachmentSelection("   ", 3);
		expect(result.ok).toBe(false);
	});

	test("rejects non-numeric tokens", () => {
		const result = parseAttachmentSelection("1,a", 3);
		expect(result).toMatchObject({ ok: false });
		if (!result.ok) expect(result.reason).toContain('"a"');
	});

	test("rejects a trailing comma (empty token)", () => {
		expect(parseAttachmentSelection("1,", 3).ok).toBe(false);
	});

	test("rejects zero (selection is 1-indexed)", () => {
		const result = parseAttachmentSelection("0", 3);
		expect(result).toMatchObject({ ok: false });
		if (!result.ok) expect(result.reason).toContain("no attachment 0");
	});

	test("rejects out-of-range positions, naming the count", () => {
		const result = parseAttachmentSelection("4", 3);
		expect(result).toMatchObject({ ok: false });
		if (!result.ok) expect(result.reason).toContain("message has 3");
	});

	test("rejects negative numbers (sign fails the digit check)", () => {
		expect(parseAttachmentSelection("-1", 3).ok).toBe(false);
	});
});
