// Process-tree cancellation (`port-action-execution-to-bun`, task 3.3).
//
// Ported from `server/pkg/server/script_metadata_process_unix.go`, which makes a
// metadata probe its own process group (`Setpgid`) and kills the whole group on
// timeout.
//
// Bun's `spawn` has no `setpgid`/`detached` option, so the group cannot be
// created at spawn time and `kill(-pid)` is not usable — the child stays in the
// parent's group, and signalling that group would kill the server. The
// observable requirement is the same one Go meets: cancelling a command or
// killing a tracked process must take its children with it. This module resolves
// the descendant set and signals it leaves-first, and on Windows uses
// `taskkill /T`, which terminates the tree natively.
import { spawnSync } from "node:child_process";

export type KillSignal = "SIGTERM" | "SIGKILL";

/**
 * Every descendant of `pid`, deepest first, followed by `pid` itself.
 * `null` means the process table could not be read, in which case the caller
 * falls back to killing the direct child only.
 */
export function collectProcessTree(
	pid: number,
	processTable: () => string | undefined = readProcessTable,
): number[] | undefined {
	const table = processTable();
	if (table === undefined) return undefined;
	const children = new Map<number, number[]>();
	for (const line of table.split("\n")) {
		const fields = line.trim().split(/\s+/);
		if (fields.length < 2) continue;
		const child = Number(fields[0]);
		const parent = Number(fields[1]);
		if (!Number.isInteger(child) || !Number.isInteger(parent)) continue;
		const siblings = children.get(parent);
		if (siblings) siblings.push(child);
		else children.set(parent, [child]);
	}
	const ordered: number[] = [];
	const seen = new Set<number>([pid]);
	const visit = (current: number): void => {
		for (const child of children.get(current) ?? []) {
			if (seen.has(child)) continue;
			seen.add(child);
			visit(child);
			ordered.push(child);
		}
	};
	visit(pid);
	ordered.push(pid);
	return ordered;
}

function readProcessTable(): string | undefined {
	try {
		const result = spawnSync("ps", ["-A", "-o", "pid=,ppid="], {
			encoding: "utf8",
			timeout: 2000,
		});
		if (result.status !== 0 || typeof result.stdout !== "string")
			return undefined;
		return result.stdout;
	} catch {
		return undefined;
	}
}

/** The `taskkill` invocation Windows uses to terminate a process tree. */
export function windowsKillTreeCommand(pid: number): string[] {
	return ["taskkill", "/PID", String(pid), "/T", "/F"];
}

/**
 * Terminates `pid` and everything it started. A process that has already exited
 * is not an error.
 */
export function killProcessTree(
	pid: number,
	options: {
		platform?: string;
		signal?: KillSignal;
		processTable?: () => string | undefined;
		runWindows?: (command: string[]) => void;
	} = {},
): void {
	if (!Number.isInteger(pid) || pid <= 0) return;
	const platform = options.platform ?? process.platform;
	if (platform === "win32") {
		const run = options.runWindows ?? defaultRunWindowsKill;
		run(windowsKillTreeCommand(pid));
		return;
	}
	const signal = options.signal ?? "SIGTERM";
	const tree =
		options.processTable !== undefined
			? collectProcessTree(pid, options.processTable)
			: collectProcessTree(pid);
	const targets = tree ?? [pid];
	for (const target of targets) {
		try {
			process.kill(target, signal);
		} catch {
			// Already gone: nothing to cancel.
		}
	}
}

function defaultRunWindowsKill(command: string[]): void {
	try {
		spawnSync(command[0] as string, command.slice(1), { timeout: 5000 });
	} catch {
		// The tree is already gone, or taskkill is unavailable.
	}
}
