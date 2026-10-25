// Local boundary for reopening a workflow session after a host/process restart.
// Never trust a socket, environment path or conversation supplied by a view:
// resolve them from the canonical workflow store and verify the launch identity.
import fs from "node:fs";
import path from "node:path";
import type {
	AgentHandle,
	WorkflowRun,
	WorkflowSnapshot,
} from "../contracts/workflow.ts";
import { selfExecEntry } from "../self-exec.ts";
import { decodeSnapshot } from "../workflow/contracts.ts";
import {
	agentRunEnvironmentFile,
	parseRunEnvFile,
} from "../workflow/run-env.ts";
import { tokenMatches } from "../workflow/runtime/capability.ts";
import {
	openReadStore,
	type RunRow,
	runFromRow,
} from "../workflow/runtime/store.ts";
import {
	closeSecureDirectory,
	openSecureDirectory,
	openSecureFile,
} from "../workflow/secure-fs.ts";
import { ensureHostRunning, HostClient } from "./client.ts";
import { hostLayout } from "./layout.ts";
import type { EnsureRunRequest } from "./protocol.ts";

export interface RecoveredSession {
	readonly runId: string;
	readonly hostSocket: string;
	readonly conversationId: string;
}

/** Pure ownership checks also used before any process is spawned. A historical
 * run may still be watched, but cannot take over the current conversation. */
export function recoveryRequest(
	snapshot: WorkflowSnapshot,
	run: WorkflowRun,
):
	| (Omit<EnsureRunRequest, "type"> & { expectedConversationId: string })
	| undefined {
	const handle = run.handle;
	if (
		run.workflowId !== snapshot.workflowId ||
		!handle ||
		handle.runtime !== "pi-durable" ||
		handle.sessionId !== run.id ||
		!handle.name ||
		!handle.conversationId
	)
		throw new Error("run recovery requires an exact durable workflow handle");
	const runEnvPath = agentRunEnvironmentFile({
		worktree: snapshot.metadata.worktree,
		definitionId: snapshot.definition.id,
		workflowId: snapshot.workflowId,
		runId: run.id,
	});
	const layout = hostLayout(
		path.dirname(path.dirname(path.dirname(runEnvPath))),
	);
	if (handle.hostSocket !== layout.socketPath)
		throw new Error("run recovery host socket ownership mismatch");
	if (
		["paused", "completed", "closed"].includes(snapshot.status) ||
		run.stepId !== snapshot.currentStep ||
		run.attempt !== snapshot.step.attempt ||
		![...snapshot.step.activeRunIds, ...snapshot.step.completedRunIds].includes(
			run.id,
		) ||
		!["pending", "working", "blocked"].includes(run.status)
	)
		return undefined;
	return {
		runId: run.id,
		name: handle.name,
		cwd: snapshot.metadata.worktree,
		runEnvPath,
		expectedConversationId: handle.conversationId,
		toolPolicy:
			run.profile.readOnly || run.profile.capabilities.includes("read-only")
				? "read-only"
				: "default",
	};
}

function verifyEnvironment(
	request: Omit<EnsureRunRequest, "type">,
	run: WorkflowRun,
): void {
	const directory = openSecureDirectory(
		path.dirname(request.runEnvPath),
		path.dirname(path.dirname(request.runEnvPath)),
		false,
	);
	let contents: string;
	try {
		const file = openSecureFile(directory, path.basename(request.runEnvPath));
		try {
			contents = fs.readFileSync(file, "utf8");
		} finally {
			fs.closeSync(file);
		}
	} finally {
		closeSecureDirectory(directory);
	}
	const env = parseRunEnvFile(contents);
	if (
		env.HERDR_RUN_ID !== run.id ||
		env.HERDR_WORKFLOW_ID !== run.workflowId ||
		env.HERDR_STEP_ID !== run.stepId ||
		env.HERDR_ROLE !== run.role ||
		!env.HERDR_RUN_TOKEN ||
		(run.capabilityHash &&
			!tokenMatches(env.HERDR_RUN_TOKEN, run.capabilityHash))
	)
		throw new Error(
			"run recovery launch environment does not match its workflow run",
		);
}

/** Opening does not send a prompt, clear an abort, or answer a question. The
 * existing submit/resume-run path remains the sole owner of those transitions. */
export async function recoverWorkflowSession(
	repo: string,
	workflowId: string,
	runId: string,
): Promise<RecoveredSession> {
	const db = openReadStore(repo);
	let run: WorkflowRun;
	let snapshot: WorkflowSnapshot;
	let hasSibling = false;
	try {
		const row = db
			.query<RunRow, [string, string]>(
				"SELECT * FROM workflow_runs WHERE id=? AND workflow_id=?",
			)
			.get(runId, workflowId);
		const instance = db
			.query<{ snapshot_json: string }, [string]>(
				"SELECT snapshot_json FROM workflow_instances WHERE id=?",
			)
			.get(workflowId);
		if (!row || !instance) throw new Error("unknown workflow session");
		run = runFromRow(row);
		snapshot = decodeSnapshot(JSON.parse(instance.snapshot_json));
		// A newer run of the same role owns the conversation after a handoff.
		const sibling = db
			.query<{ id: string }, [string, string, string, number, string]>(
				"SELECT id FROM workflow_runs WHERE workflow_id=? AND step_id=? AND role=? AND attempt=? AND id<>? AND status IN ('pending','working')",
			)
			.get(workflowId, run.stepId, run.role, run.attempt, run.id);
		hasSibling = sibling !== null;
	} finally {
		db.close();
	}
	const eligible = recoveryRequest(snapshot, run);
	const request = hasSibling ? undefined : eligible;
	const handle = run.handle;
	if (!handle?.hostSocket || !handle.conversationId)
		throw new Error("missing durable session binding");
	if (request) verifyEnvironment(request, run);
	const runtimeDir = path.dirname(path.dirname(handle.hostSocket));
	const layout = hostLayout(runtimeDir);
	const entry = selfExecEntry();
	await ensureHostRunning(layout, {
		command: process.execPath,
		args: [
			...(entry ? [entry] : []),
			"agent",
			"host",
			"--workflow-dir",
			runtimeDir,
		],
		cwd: snapshot.metadata.worktree,
	});
	const client = new HostClient(layout.socketPath);
	if (request && (await client.status(run.id)).status === "unknown") {
		// Starting a host yields to other workflow operations. Do not register a
		// run that handed off or lost ownership while the process was starting.
		const fresh = openReadStore(repo);
		try {
			const row = fresh
				.query<RunRow, [string]>("SELECT * FROM workflow_runs WHERE id=?")
				.get(run.id);
			const current = fresh
				.query<{ revision: number }, [string]>(
					"SELECT revision FROM workflow_instances WHERE id=?",
				)
				.get(workflowId);
			if (
				!row ||
				current?.revision !== snapshot.revision ||
				row.status !== run.status ||
				row.capability_hash !== run.capabilityHash ||
				row.handle_json !== JSON.stringify(handle)
			)
				throw new Error(
					"run recovery ownership changed; reopen the session to retry",
				);
		} finally {
			fresh.close();
		}
		verifyEnvironment(request, run);
		await client.recoverRun(request);
	}
	return {
		runId: run.id,
		hostSocket: layout.socketPath,
		conversationId: handle.conversationId,
	};
}

/** Adapter handles do not carry a repository target. Resolve it only from the
 * private launch file, then go back through the authoritative store checks. */
export async function recoverDurableHandle(
	handle: AgentHandle,
): Promise<RecoveredSession> {
	if (
		!handle.hostSocket ||
		!handle.sessionId ||
		!/^[a-zA-Z0-9-]+$/.test(handle.sessionId)
	)
		throw new Error("missing durable run identity");
	const runtimeDir = path.dirname(path.dirname(handle.hostSocket));
	const directory = openSecureDirectory(
		path.join(runtimeDir, "runtime-bin", handle.sessionId),
		runtimeDir,
		false,
	);
	let env: Record<string, string>;
	try {
		const file = openSecureFile(directory, "run.env");
		try {
			env = parseRunEnvFile(fs.readFileSync(file, "utf8"));
		} finally {
			fs.closeSync(file);
		}
	} finally {
		closeSecureDirectory(directory);
	}
	if (
		!env.HERDR_WORKFLOW_TARGET ||
		!env.HERDR_WORKFLOW_ID ||
		env.HERDR_RUN_ID !== handle.sessionId
	)
		throw new Error("missing durable workflow launch identity");
	return recoverWorkflowSession(
		env.HERDR_WORKFLOW_TARGET,
		env.HERDR_WORKFLOW_ID,
		handle.sessionId,
	);
}
