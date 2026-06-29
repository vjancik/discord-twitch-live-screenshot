/** Max recursion depth, guarding against cyclic or pathologically nested objects. */
const MAX_DEPTH = 10;

/** Length above which a numeric array is sniffed as a serialized byte buffer. */
const DENSE_ARRAY_THRESHOLD = 16;

/**
 * Recursively sanitizes a value in-place for safe logging, replacing binary-like
 * data (Buffer, Uint8Array, or dense numeric arrays) with a short placeholder.
 * Prevents multi-megabyte payloads from flooding the terminal/log sink — the
 * primary offender being discord.js dumping raw gateway frames on errors such as
 * disallowed (privileged) intents.
 *
 * Mutates arrays, plain objects, and Error instances directly; returns the same
 * reference for objects/arrays, or a placeholder string for a binary leaf.
 *
 * @param value the value to sanitize (mutated in place when it is a container).
 * @param depth current recursion depth; callers should omit this.
 * @returns the sanitized value.
 */
export function sanitizeForLog(value: unknown, depth = 0): unknown {
	if (depth > MAX_DEPTH) return value;

	if (Buffer.isBuffer(value) || value instanceof Uint8Array) {
		return `[Binary ${value.byteLength} bytes]`;
	}

	// Dense numeric arrays (e.g. raw byte arrays serialized as JSON).
	if (
		Array.isArray(value) &&
		value.length > DENSE_ARRAY_THRESHOLD &&
		value.slice(0, 8).every((v) => typeof v === "number" && v >= 0 && v <= 255)
	) {
		return `[Binary ~${value.length} bytes]`;
	}

	if (Array.isArray(value)) {
		for (let i = 0; i < value.length; i++) {
			value[i] = sanitizeForLog(value[i], depth + 1);
		}
		return value;
	}

	if (value !== null && typeof value === "object") {
		const obj = value as Record<string, unknown>;
		for (const key of Object.keys(obj)) {
			obj[key] = sanitizeForLog(obj[key], depth + 1);
		}
		return value;
	}

	return value;
}
