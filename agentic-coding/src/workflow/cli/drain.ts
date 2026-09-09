// The detached-process argv and scheduling used to continue draining a
// workflow after a `--no-drain` handoff returns, plus the drain-wait
// constant shared with the in-process drain (which lives in the
// application-operations boundary, src/workflow/operations.ts,
// enforce-source-layer-boundaries). Moved verbatim out of cli.ts
// (split-workflow-god-modules).
import { CONTINUATION_WAIT_MS } from "../operations.ts";

export function detachedDrainArgv(
	entry: string | undefined,
	repo: string,
	_workflowId?: string,
): string[] {
	return [
		process.execPath,
		...(entry ? [entry] : []),
		"workflow",
		"drain",
		"--repo",
		repo,
	];
}

/** Schedule bounded execution without making an observational read own it. */
export function scheduleDrain(
	repo: string,
	limit = 20,
	waitMs = CONTINUATION_WAIT_MS,
): void {
	const entry = Bun.main.startsWith("$bunfs") ? undefined : Bun.main;
	const argv = detachedDrainArgv(entry, repo);
	if (limit !== 20) argv.push("--limit", String(limit));
	argv.push("--wait-ms", String(waitMs));
	const safeKeys = [
		"PATH",
		"HOME",
		"TMPDIR",
		"TERM",
		"LANG",
		"LC_ALL",
		"LC_MESSAGES",
		"HERDR_ENV",
		"HERDR_BIN_PATH",
		"HERDR_SOCKET_PATH",
		"HERDR_WORKFLOW_CONFIG",
		"HERDR_WIKI_DIR",
	];
	const env = Object.fromEntries(
		safeKeys.flatMap((key) =>
			process.env[key] === undefined ? [] : [[key, process.env[key] as string]],
		),
	);
	const child = Bun.spawn(argv, {
		detached: true,
		stdio: ["ignore", "ignore", "ignore"],
		cwd: process.cwd(),
		env,
	});
	child.unref();
}
