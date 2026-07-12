/** Result of parsing the (Un)Spoiler modal's attachment-selection input. */
export type SelectionParseResult =
	| {
			ok: true;
			/** Selected attachment indexes: 0-based, deduplicated, ascending. */
			indexes: number[];
	  }
	| {
			ok: false;
			/** Human-readable reason, safe to show to the invoking admin. */
			reason: string;
	  };

/** Matches a lone, base-10, unsigned integer token. */
const DIGITS = /^\d+$/;

const USAGE = 'Use 1-indexed, comma-separated numbers (e.g. "1,3") or "all".';

/**
 * Parse the (Un)Spoiler modal input into attachment indexes.
 *
 * Accepts a comma-separated list of 1-indexed attachment positions (e.g.
 * `1,3`) or the value `all` (case-insensitive) for every attachment.
 * Whitespace around tokens is ignored and duplicates are collapsed.
 *
 * @param input raw text entered in the modal.
 * @param count number of attachments on the target message.
 * @returns the selected indexes (converted to 0-based) or a rejection reason.
 */
export function parseAttachmentSelection(
	input: string,
	count: number,
): SelectionParseResult {
	const normalized = input.trim();
	if (normalized === "") {
		return { ok: false, reason: `Empty selection. ${USAGE}` };
	}
	if (normalized.toLowerCase() === "all") {
		return { ok: true, indexes: Array.from({ length: count }, (_, i) => i) };
	}

	const indexes = new Set<number>();
	for (const token of normalized.split(",").map((t) => t.trim())) {
		if (!DIGITS.test(token)) {
			return { ok: false, reason: `"${token}" isn't a number. ${USAGE}` };
		}
		const position = Number(token);
		if (position < 1 || position > count) {
			return {
				ok: false,
				reason: `There is no attachment ${position} (message has ${count}).`,
			};
		}
		indexes.add(position - 1);
	}
	return { ok: true, indexes: [...indexes].sort((a, b) => a - b) };
}
