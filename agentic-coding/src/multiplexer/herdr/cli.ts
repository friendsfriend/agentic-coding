// Single shared Herdr CLI boundary: the one place that parses the `.result`
// envelope, plus the one place pane-geometry/direction math lives. Consumed by
// the Herdr multiplexer adapter (workflow launch/layout) and the dashboard
// (agent focus). Moved verbatim from src/herdr-client.ts
// (add-multiplexer-adapters, task 1.2).
import { Schema } from "effect";
import type { Direction } from "../port.ts";

export type { Direction };

/** The raw argv-shaped Herdr transport the adapter and the deprecated
 * Herdr-only sidebar integration share. */
export interface HerdrCli {
	call(...args: string[]): unknown;
	callAsync?(args: string[], signal?: AbortSignal): Promise<unknown>;
}

export type HerdrError = Error & { code?: string };

/** Build the bounded CLI failure. Herdr prints a structured
 * `{"id":...,"error":{"code","message"}}` envelope for known failures; the
 * code is attached when present so absence classification does not depend on
 * free-text matching. */
function herdrFailure(args: string[], detail: string): HerdrError {
	const trimmed = detail.trim();
	const envelopeStart = trimmed.indexOf("{");
	if (envelopeStart >= 0) {
		try {
			const parsed = JSON.parse(trimmed.slice(envelopeStart)) as {
				error?: { code?: unknown; message?: unknown };
			};
			const code =
				typeof parsed.error?.code === "string" ? parsed.error.code : undefined;
			const message =
				typeof parsed.error?.message === "string"
					? parsed.error.message
					: trimmed;
			const error = new Error(
				`herdr ${args.join(" ")}: ${message}`,
			) as HerdrError;
			if (code) error.code = code;
			return error;
		} catch {
			/* not a structured envelope: fall through to the raw detail */
		}
	}
	return new Error(`herdr ${args.join(" ")}: ${trimmed}`) as HerdrError;
}

// biome-ignore lint/suspicious/noExplicitAny: untyped CLI JSON envelope, callers narrow fields
export function runHerdr(args: string[], binPath?: string): any {
	const result = Bun.spawnSync([binPath ?? "herdr", ...args], {
		stdout: "pipe",
		stderr: "pipe",
	});
	const stdout = result.stdout.toString();
	const stderr = result.stderr.toString();
	if (result.exitCode !== 0) {
		const detail = (stderr || stdout || "command failed").trim();
		throw herdrFailure(args, detail);
	}
	return stdout.trim() ? (JSON.parse(stdout).result ?? {}) : {};
}

export function parseHerdrResult(output: string): unknown {
	return output.trim() ? (JSON.parse(output).result ?? {}) : {};
}

/** Decode an already-parsed `.result` envelope through an Effect Schema at the
 * workflow-facing boundary (migrate-workflow-execution-to-effect, task 2.2).
 * Failures surface as bounded plain `Error`s so the runner can classify them
 * instead of treating a Herdr shape drift as a programming defect. */
export function decodeHerdrResult<A>(
	// biome-ignore lint/suspicious/noExplicitAny: Effect Schema generics don't line up with envelope shapes (readonly arrays, optional vs undefined); mirrored from schema.ts decodeContract.
	schema: Schema.Schema<A, any, never>,
	parsed: unknown,
): A {
	try {
		return Schema.decodeUnknownSync(schema)(parsed);
	} catch (error) {
		throw new Error(
			`herdr envelope did not match its schema: ${String(error instanceof Error ? error.message : error).slice(0, 512)}`,
		);
	}
}

export async function runHerdrAsync(
	args: string[],
	signal?: AbortSignal,
	binPath?: string,
): Promise<unknown> {
	const proc = Bun.spawn([binPath ?? "herdr", ...args], {
		stdout: "pipe",
		stderr: "pipe",
	});
	const stdout = new Response(proc.stdout).text();
	const stderr = new Response(proc.stderr).text();
	const timeout = setTimeout(() => proc.kill(), 120_000);
	const abort = () => proc.kill();
	if (signal?.aborted) proc.kill();
	else signal?.addEventListener("abort", abort, { once: true });
	try {
		const exitCode = await proc.exited;
		const output = await stdout;
		const error = await stderr;
		if (exitCode !== 0) throw herdrFailure(args, (error || output).trim());
		return parseHerdrResult(output);
	} finally {
		clearTimeout(timeout);
		signal?.removeEventListener("abort", abort);
	}
}

export class Herdr implements HerdrCli {
	readonly callAsync?: (
		args: string[],
		signal?: AbortSignal,
	) => Promise<unknown>;
	/** `HERDR_BIN_PATH` is the one executable override every Herdr call honors;
	 * the default stays the bare `herdr` name so unset behavior is unchanged. */
	readonly binPath?: string;
	constructor(binPath: string | undefined = process.env.HERDR_BIN_PATH) {
		this.binPath = binPath;
		this.callAsync = (args, signal) =>
			runHerdrAsync(args, signal, this.binPath);
	}
	/** Wraps the `herdr` CLI, parsing the `.result` envelope. */
	// biome-ignore lint/suspicious/noExplicitAny: untyped CLI JSON envelope
	call(...args: string[]): any {
		return runHerdr(args, this.binPath);
	}
}

export interface Rect {
	x: number;
	y: number;
	width: number;
	height: number;
}

/** Compass direction from one pane rect's center to another's — the shared
 * geometry primitive behind both split placement and focus traversal. */
export function directionBetween(from: Rect, to: Rect): Direction {
	const dx = to.x + to.width / 2 - (from.x + from.width / 2);
	const dy = to.y + to.height / 2 - (from.y + from.height / 2);
	return Math.abs(dx) >= Math.abs(dy)
		? dx > 0
			? "right"
			: "left"
		: dy > 0
			? "down"
			: "up";
}
