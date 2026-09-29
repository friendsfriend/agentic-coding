// The detached-process argv and scheduling used to continue draining a
// workflow after a `--no-drain` handoff returns, plus the drain-wait
// constant shared with the in-process drain (which lives in the
// application-operations boundary, src/workflow/operations.ts,
// enforce-source-layer-boundaries). Moved verbatim out of cli.ts
// (split-workflow-god-modules).

import { CONFIG_ROOT_VAR, resolveConfigRoot } from "../../config-root.ts";
import { selfExecEntry } from "../../self-exec.ts";
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
	const argv = detachedDrainArgv(selfExecEntry(), repo);
	if (limit !== 20) argv.push("--limit", String(limit));
	argv.push("--wait-ms", String(waitMs));
	const env = detachedDrainEnvironment(process.env);
	const child = Bun.spawn(argv, {
		detached: true,
		stdio: ["ignore", "ignore", "ignore"],
		cwd: process.cwd(),
		env,
	});
	child.unref();
}

/** The detached drain's bounded environment allowlist: runtime selection and
 * both runtimes' connection variables, plus the process basics. */
export function detachedDrainEnvironment(
	source: NodeJS.ProcessEnv,
): Record<string, string> {
	const safeKeys = [
		"PATH",
		"HOME",
		// The workflow worktree root resolves from the managed runtime home; a
		// drain that lost the exported value would place worktrees elsewhere.
		"DEVENV_HOME",
		"TMPDIR",
		"TERM",
		"LANG",
		"LC_ALL",
		"LC_MESSAGES",
		"AGENTIC_CODING_MULTIPLEXER",
		"HERDR_ENV",
		"HERDR_BIN_PATH",
		"HERDR_SOCKET_PATH",
		"HERDR_WORKFLOW_CONFIG",
		"HERDR_WIKI_DIR",
		"LUVUS_ENV",
		"LUVUS_BIN_PATH",
		"LUVUS_SOCKET_PATH",
		"LUVUS_API_ADDRESS",
		"LUVUS_HOME",
		"LUVUS_SESSION",
		"LUVUS_PANE_ID",
		"OPENCODE_API_KEY",
	];
	return {
		...Object.fromEntries(
			safeKeys.flatMap((key) =>
				source[key] === undefined ? [] : [[key, source[key] as string]],
			),
		),
		// The detached drain resolves the same configuration root as its parent.
		[CONFIG_ROOT_VAR]: source[CONFIG_ROOT_VAR] ?? resolveConfigRoot(),
	};
}
