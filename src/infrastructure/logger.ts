import { type Logger as PinoLogger, pino } from "pino";
import { sanitizeForLog } from "../application/sanitize-for-log";
import type { Logger } from "../domain/ports";

type Level = "debug" | "info" | "warn" | "error";

/**
 * Wrap a pino instance in the domain {@link Logger} port, sanitizing the object
 * argument of every call so binary payloads (e.g. discord.js DiscordAPIError
 * instances carrying the request body's file buffers) can never flood the logs.
 *
 * Sanitizing here, at the single logging boundary, means no call site has to
 * remember to do it.
 */
function wrap(instance: PinoLogger): Logger {
	const log = (level: Level, obj: object | string, msg?: string): void => {
		if (typeof obj === "string") {
			instance[level](obj);
			return;
		}
		// sanitizeForLog mutates in place; that is acceptable for objects headed
		// straight into a log call and avoids cloning large structures.
		instance[level](sanitizeForLog(obj) as object, msg);
	};

	return {
		debug: (obj, msg) => log("debug", obj, msg),
		info: (obj, msg) => log("info", obj, msg),
		warn: (obj, msg) => log("warn", obj, msg),
		error: (obj, msg) => log("error", obj, msg),
		child: (bindings) => wrap(instance.child(bindings)),
	};
}

/**
 * Create the application's root {@link Logger}, backed by pino.
 *
 * In a TTY it uses `pino-pretty` for readable output; otherwise emits JSON.
 * The returned object satisfies the domain {@link Logger} port, so the rest of
 * the app never imports pino directly.
 */
export function createLogger(level: string): Logger {
	const usePretty = process.stdout.isTTY === true;
	const instance = pino({
		level,
		transport: usePretty
			? {
					target: "pino-pretty",
					options: { colorize: true, translateTime: "SYS:standard" },
				}
			: undefined,
	});
	return wrap(instance);
}
