/**
 * Domain-level error hierarchy for the Twitch screenshot pipeline.
 *
 * These are deliberately granular so the application/infrastructure layers can
 * react differently to each failure mode (e.g. stay silent on offline, audit-log
 * an auth failure, show a generic error for an unexpected retrieval fault).
 */

/** Base class for all errors originating from this application's own logic. */
export abstract class AppError extends Error {
	constructor(message: string, options?: { cause?: unknown }) {
		super(message, options);
		this.name = new.target.name;
	}
}

/** The supplied string is not a parseable Twitch channel URL/name. */
export class InvalidChannelUrlError extends AppError {
	constructor(
		public readonly input: string,
		reason: string,
	) {
		super(`Invalid Twitch channel URL "${input}": ${reason}`);
	}
}

/** The URL is a valid Twitch URL, but points at a VOD or clip rather than a live channel. */
export class UnsupportedTwitchUrlError extends AppError {
	constructor(
		public readonly input: string,
		public readonly kind: "vod" | "clip",
	) {
		super(
			`Unsupported Twitch URL "${input}": ${kind} URLs are not supported, only live channels`,
		);
	}
}

/** The channel exists but is not currently streaming. Auto-embed treats this as "do nothing". */
export class ChannelOfflineError extends AppError {
	constructor(public readonly channel: string) {
		super(`Channel "${channel}" is offline`);
	}
}

/**
 * Twitch rejected our anonymous GQL/usher request in a way that indicates the
 * auth contract changed (e.g. integrity token now required, Client-ID retired,
 * schema altered). This is the signal that should be audited.
 */
export class AuthFailureError extends AppError {
	constructor(
		message: string,
		public readonly detail: {
			stage: "gql" | "usher";
			status?: number;
			body?: string;
		},
		options?: { cause?: unknown },
	) {
		super(message, options);
	}
}

/** A non-auth failure during retrieval (network, ffmpeg, playlist parsing, etc.). */
export class RetrievalError extends AppError {}
