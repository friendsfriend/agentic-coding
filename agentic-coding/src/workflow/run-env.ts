// Agent run environment file (multiplexer removal).
//
// The durable agent host reads its per-run environment from this file, so the
// secret-bearing file is written in exactly one place. It is 0600, contains one
// `KEY='value'` line per variable, and lives under the workflow's run directory
// so it never outlives the run.
import path from "node:path";
import {
	closeSecureDirectory,
	openSecureDirectory,
	writeAtomicPrivateFile,
} from "./secure-fs.ts";

export interface AgentRunEnvInput {
	cwd: string;
	runDirectory?: string;
	runId: string;
	environment: Record<string, string>;
}

function shQuote(value: string): string {
	return `'${value.replace(/'/g, `'\\''`)}'`;
}

/** Write the run environment file and return its absolute path. */
export function writeAgentRunEnv(input: AgentRunEnvInput): string {
	const envFile = path.join(
		input.runDirectory ?? path.join(input.cwd, ".herdr-workflow"),
		"runtime-bin",
		input.runId,
		"run.env",
	);
	const directory = openSecureDirectory(
		path.dirname(envFile),
		input.runDirectory ?? input.cwd,
	);
	try {
		// The file is parsed one line per variable by the runtime telemetry
		// bridges, so a value containing CR/LF/NUL would inject additional
		// assignments. Preserve the engine-side guard in the one shared writer.
		if (
			Object.values(input.environment).some((value) => /[\r\n\0]/.test(value))
		)
			throw new Error("run environment values may not contain newlines");
		const lines = Object.entries(input.environment)
			.filter(([key]) => /^[A-Za-z_][A-Za-z0-9_]*$/.test(key))
			.map(([key, value]) => `${key}=${shQuote(value)}`);
		writeAtomicPrivateFile(
			directory,
			path.basename(envFile),
			`${lines.join("\n")}\n`,
			0o600,
		);
	} finally {
		closeSecureDirectory(directory);
	}
	return envFile;
}
