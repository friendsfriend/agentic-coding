// Luvus CLI boundary (add-multiplexer-adapters, task 5.1).
//
// The semantic CLI is the shortest path for one action (Luvus's own guidance),
// so notification delivery uses `luvus ui notification push`. The selected
// named session is always passed through; the binary path is resolved from
// `LUVUS_BIN_PATH` (never hardcoded) with a PATH lookup fallback.
export interface LuvusCliOptions {
	binPath?: string;
	session?: string;
}

export function luvusArgv(
	args: string[],
	options: LuvusCliOptions = {},
): string[] {
	const bin = options.binPath ?? process.env.LUVUS_BIN_PATH ?? "luvus";
	return [
		bin,
		...(options.session ? ["--session", options.session] : []),
		...args,
	];
}

/** Parse the CLI's `{result}` envelope; a non-zero exit or error envelope
 * throws with the bounded diagnostic Luvus printed. */
export function parseLuvusCliResult(stdout: string): unknown {
	if (!stdout.trim()) return {};
	let parsed: unknown;
	try {
		parsed = JSON.parse(stdout);
	} catch {
		throw new Error(`luvus returned invalid JSON: ${stdout.slice(0, 200)}`);
	}
	if (!parsed || typeof parsed !== "object")
		throw new Error("luvus returned an invalid envelope");
	const envelope = parsed as {
		result?: unknown;
		error?: { code?: unknown; message?: unknown };
	};
	if (envelope.error) {
		const message =
			typeof envelope.error.message === "string"
				? envelope.error.message
				: String(envelope.error.code ?? "luvus command failed");
		const error = new Error(message) as Error & { code?: string };
		if (typeof envelope.error.code === "string")
			error.code = envelope.error.code;
		throw error;
	}
	return envelope.result ?? {};
}

/** Synchronous CLI invocation for bounded presentation writes. */
export function runLuvus(
	args: string[],
	options: LuvusCliOptions = {},
): unknown {
	const result = Bun.spawnSync(luvusArgv(args, options), {
		stdout: "pipe",
		stderr: "pipe",
	});
	const stdout = result.stdout.toString();
	const stderr = result.stderr.toString();
	if (result.exitCode !== 0) {
		const detail = (stderr || stdout || "command failed").trim();
		const error = new Error(detail) as Error & { code?: string };
		error.code = "command_failed";
		throw error;
	}
	return parseLuvusCliResult(stdout);
}
