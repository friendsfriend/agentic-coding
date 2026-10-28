// Synchronous read-only authority adapter. Production batched acquisitions run
// this module inside workflow-session-worker, never on the TUI event loop.
import path from "node:path";
import { openReadStore } from "../workflow/runtime/store.ts";
import {
	NON_REPOSITORY_WORKFLOW_TARGETS,
	validateWorkflowId,
	wikiWorkflowDataRoot,
} from "../workflow/runtime/targets.ts";
import { hostIdentityPaths, readHostCertificate } from "./host-identity.ts";
import { hostLayout } from "./layout.ts";
import { canonicalWorkflowSocket } from "./socket-path.ts";

export interface SessionRequest {
	readonly runId: string;
	readonly recordedSocket: string;
	readonly authenticated?: boolean;
}
export type Verification =
	| { readonly socket: string; readonly fingerprint?: string }
	| { readonly error: string };
export type SessionBatchReply =
	| { readonly started: true }
	| { readonly results: Verification[] }
	| { readonly error: string };

export function verifyWorkflowSessions(
	target: string,
	workflowId: string,
	requests: readonly SessionRequest[],
): Verification[] {
	validateWorkflowId(workflowId);
	const db = openReadStore(target);
	let worktree: unknown;
	const members = new Set<string>();
	try {
		const workflow = db
			.query<{ worktree: unknown }, [string]>(
				"SELECT json_extract(snapshot_json, '$.metadata.worktree') AS worktree FROM workflow_instances WHERE id = ?",
			)
			.get(workflowId);
		if (!workflow) throw new Error("workflow is unavailable");
		worktree = workflow.worktree;
		const ids = [...new Set(requests.map((request) => request.runId))];
		for (let start = 0; start < ids.length; start += 256) {
			const batch = ids.slice(start, start + 256);
			const rows = db
				.query<{ id: string }, string[]>(
					`SELECT id FROM workflow_runs WHERE workflow_id = ? AND id IN (${batch.map(() => "?").join(",")})`,
				)
				.all(workflowId, ...batch);
			for (const row of rows) members.add(row.id);
		}
	} finally {
		db.close();
	}
	let runtimeDir: string;
	if (NON_REPOSITORY_WORKFLOW_TARGETS.includes(target)) {
		// Repository-independent launches keep their runtime (including the
		// host) under runs/, matching agentRunEnvironmentFile and effect-runner.
		runtimeDir = path.join(wikiWorkflowDataRoot(), workflowId, "runs");
	} else {
		if (typeof worktree !== "string" || !path.isAbsolute(worktree))
			throw new Error("workflow runtime location is unavailable");
		runtimeDir = path.join(worktree, ".herdr-workflow");
	}
	const expected = hostLayout(runtimeDir).socketPath;
	// Validate every path component, including ancestors. No persistent trust
	// cache: every acquisition batch rechecks the store and canonical socket.
	const canonical = canonicalWorkflowSocket(expected);
	let identity: { socket: string; fingerprint: string } | undefined;
	if (requests.some((request) => request.authenticated)) {
		try {
			const secure = hostIdentityPaths(expected).socket;
			canonicalWorkflowSocket(secure);
			identity = { socket: secure, fingerprint: readHostCertificate(expected) };
		} catch (error) {
			throw new Error(
				`agent host instance identity unavailable; restart the local host with the upgraded binary: ${error instanceof Error ? error.message : String(error)}`,
			);
		}
	}
	return requests.map((request) => {
		if (!members.has(request.runId))
			return { error: "agent run does not belong to this workflow" };
		if (request.recordedSocket !== expected)
			return {
				error: "recorded agent socket does not belong to this workflow",
			};
		return request.authenticated && identity ? identity : { socket: canonical };
	});
}

/** Explicit single-request boundary for non-fan-out callers. */
export function workflowSessionSocket(
	target: string,
	workflowId: string,
	runId: string,
	recordedSocket: string,
): string {
	const result = verifyWorkflowSessions(target, workflowId, [
		{ runId, recordedSocket },
	])[0];
	if (!result) throw new Error("workflow session is unavailable");
	if ("error" in result) throw new Error(result.error);
	return result.socket;
}
