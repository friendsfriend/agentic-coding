// Authenticates the calling process ancestry for managed-agent commands
// (question, handoff, research-handoff, wiki write/verify/log). Moved
// verbatim out of cli.ts (split-workflow-god-modules).
import fs from "node:fs";
import { researchWorkflowTarget, wikiWorkflowTarget } from "../runtime.ts";

export type CallerEnvironment = Record<string, string>;

function processEnvironment(pid: number): CallerEnvironment {
	return Object.fromEntries(
		fs
			.readFileSync(`/proc/${pid}/environ`)
			.toString()
			.split("\0")
			.flatMap((entry) => {
				const separator = entry.indexOf("=");
				return separator > 0
					? [[entry.slice(0, separator), entry.slice(separator + 1)]]
					: [];
			}),
	);
}
function parentProcessId(pid: number): number | undefined {
	if (process.platform !== "linux") {
		const result = Bun.spawnSync(["ps", "-p", String(pid), "-o", "ppid="], {
			stdout: "pipe",
			stderr: "pipe",
		});
		if (result.exitCode !== 0)
			throw new Error("managed caller ancestry is unavailable");
		const parent = Number(result.stdout.toString().trim());
		if (!Number.isInteger(parent) || parent < 0)
			throw new Error("managed caller ancestry is malformed");
		return parent === 0 ? undefined : parent;
	}
	let stat: string;
	try {
		stat = fs.readFileSync(`/proc/${pid}/stat`, "utf8");
	} catch (error) {
		// Process entries can disappear while walking ancestry.
		if (error instanceof Error && "code" in error && error.code === "ENOENT")
			return undefined;
		throw error;
	}
	const fields = stat
		.slice(stat.lastIndexOf(")") + 1)
		.trim()
		.split(/\s+/);
	const parent = Number(fields[1]);
	if (!Number.isInteger(parent) || parent < 0)
		throw new Error("managed caller ancestry is malformed");
	return parent === 0 ? undefined : parent;
}
function processCommand(pid: number): string {
	const result = Bun.spawnSync(["ps", "-p", String(pid), "-o", "command="], {
		stdout: "pipe",
		stderr: "pipe",
	});
	if (result.exitCode !== 0)
		throw new Error("managed caller ancestry is unavailable");
	return result.stdout.toString().trim();
}
function managedProcessAncestor(): boolean {
	const seen = new Set<number>();
	let pid = process.ppid;
	while (pid > 1 && !seen.has(pid)) {
		seen.add(pid);
		if (
			/(?:^|[\\s/])(pi|opencode|opencode2|opencode-v2)(?:[\\s]|$)/i.test(
				processCommand(pid),
			)
		)
			return true;
		const parent = parentProcessId(pid);
		if (parent === undefined) return false;
		pid = parent;
	}
	if (seen.has(pid)) throw new Error("managed caller ancestry is cyclic");
	return false;
}
/** Read the launch environment from the caller's process ancestry. A child
 * cannot bypass the managed-agent boundary by unsetting its own environment. */
export function callerEnvironment(): CallerEnvironment {
	const local = process.env as CallerEnvironment;
	if (process.platform !== "linux") {
		// A managed run always carries these values in the current process. If a
		// child clears them, identify the managed runtime through its ancestry;
		// never infer interactivity from the current working directory.
		if (local.HERDR_RUN_TOKEN || local.HERDR_WORKFLOW_ID) return local;
		if (managedProcessAncestor())
			throw new Error("managed caller ancestry is unavailable");
		return {};
	}
	let managed: CallerEnvironment = {};
	let managedPid: number | undefined;
	const seen = new Set<number>();
	let pid = process.pid;
	let rootReached = false;
	while (!seen.has(pid)) {
		seen.add(pid);
		// PID 1 is the process-tree root in the host namespace; its environment
		// is not needed to establish the managed ancestor and may be unreadable.
		let environment: CallerEnvironment;
		try {
			environment =
				pid === process.pid ? local : pid === 1 ? {} : processEnvironment(pid);
		} catch {
			if (managedPid !== undefined) {
				rootReached = true;
				break;
			}
			throw new Error("managed caller ancestry is unavailable");
		}
		if (
			pid !== process.pid &&
			(environment.HERDR_RUN_TOKEN || environment.HERDR_WORKFLOW_ID)
		) {
			managed = environment;
			managedPid = pid;
		}
		const parent = parentProcessId(pid);
		if (parent === undefined) {
			rootReached = true;
			break;
		}
		pid = parent;
	}
	if (!rootReached) throw new Error("managed caller ancestry is cyclic");
	if (local.HERDR_RUN_TOKEN || local.HERDR_WORKFLOW_ID) {
		if (managedPid === undefined)
			throw new Error("managed caller ancestry is unavailable");
	}
	return managed;
}
export function managedAgent(): boolean {
	try {
		const environment = callerEnvironment();
		return Boolean(
			environment.HERDR_RUN_TOKEN ||
				environment.HERDR_WORKFLOW_ID ||
				environment.HERDR_STEP_ID,
		);
	} catch {
		// If ancestry cannot be authenticated, fail closed as managed.
		return true;
	}
}
export function managedWorkflowTarget(fallback = process.cwd()): string {
	return process.env.HERDR_WORKFLOW_TARGET === wikiWorkflowTarget()
		? wikiWorkflowTarget()
		: process.env.HERDR_WORKFLOW_TARGET === researchWorkflowTarget()
			? researchWorkflowTarget()
			: fallback;
}
