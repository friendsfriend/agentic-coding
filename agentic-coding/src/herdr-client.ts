// Single shared Herdr CLI client: the one place that parses the `.result`
// envelope, plus the one place pane-geometry/direction math lives. Consumed by
// the workflow engine (launch/layout) and the dashboard (agent focus).
import { Schema } from "effect";

// biome-ignore lint/suspicious/noExplicitAny: untyped CLI JSON envelope, callers narrow fields
export function runHerdr(args: string[]): any {
	const result = Bun.spawnSync(["herdr", ...args], {
		stdout: "pipe",
		stderr: "pipe",
	});
	const stdout = result.stdout.toString();
	const stderr = result.stderr.toString();
	if (result.exitCode !== 0) {
		const detail = (stderr || stdout || "command failed").trim();
		throw new Error(`herdr ${args.join(" ")}: ${detail}`);
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
): Promise<unknown> {
	const proc = Bun.spawn(["herdr", ...args], {
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
		if (exitCode !== 0)
			throw new Error(`herdr ${args.join(" ")}: ${(error || output).trim()}`);
		return parseHerdrResult(output);
	} finally {
		clearTimeout(timeout);
		signal?.removeEventListener("abort", abort);
	}
}

export class Herdr {
	readonly callAsync?: (
		args: string[],
		signal?: AbortSignal,
	) => Promise<unknown>;
	constructor() {
		this.callAsync = runHerdrAsync;
	}
	/** Wraps the `herdr` CLI, parsing the `.result` envelope. */
	// biome-ignore lint/suspicious/noExplicitAny: untyped CLI JSON envelope
	call(...args: string[]): any {
		return runHerdr(args);
	}
}

export interface Rect {
	x: number;
	y: number;
	width: number;
	height: number;
}

export type Direction = "left" | "right" | "up" | "down";

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
