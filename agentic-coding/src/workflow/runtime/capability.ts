// The security boundary (design D2): token hashing/comparison, run
// capability issuance, agent and exact-run authorization, and the artifact
// path/size/schema/digest checks bounded by MAX_ARTIFACT_BYTES. Extracted as
// one cohesive unit rather than spread across files, so it can be reviewed
// and tested as a whole. Moved verbatim out of runtime.ts
// (split-workflow-god-modules).
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type { WorkflowRun } from "../contracts.ts";
import { WorkflowRuntimeError } from "../contracts.ts";
import type { WorkflowRegistry } from "../registry.ts";
import {
	ACTIVE_RUN,
	getSnapshot,
	openStore,
	type RunRow,
	activeRunForRole as storeActiveRunForRole,
	getRun as storeGetRun,
} from "./store.ts";

export const MAX_ARTIFACT_BYTES = 512 * 1024;

export function hashToken(token: string): string {
	return createHash("sha256").update(token).digest("hex");
}
export function tokenMatches(token: string, hash: string): boolean {
	const actual = Buffer.from(hashToken(token), "hex");
	const expected = Buffer.from(hash, "hex");
	return actual.length === expected.length && timingSafeEqual(actual, expected);
}

export function issueRunCapability(repo: string, runId: string): string {
	const db = openStore(repo);
	try {
		db.exec("BEGIN IMMEDIATE");
		const row = db
			.query("SELECT * FROM workflow_runs WHERE id=?")
			.get(runId) as RunRow | null;
		if (!row || !ACTIVE_RUN.has(row.status))
			throw new WorkflowRuntimeError("stale-run", "run is stale or inactive");
		const token = randomBytes(32).toString("base64url");
		db.query("UPDATE workflow_runs SET capability_hash=? WHERE id=?").run(
			hashToken(token),
			runId,
		);
		db.exec("COMMIT");
		return token;
	} catch (error) {
		try {
			db.exec("ROLLBACK");
		} catch {
			/* no transaction */
		}
		throw error;
	} finally {
		db.close();
	}
}

/** Validate the launch-bound capability for a role-scoped CLI operation. */
export function authorizeAgentCapability(
	repo: string,
	workflowId: string,
	stepId: string,
	role: string,
	token: string,
	registry: WorkflowRegistry,
	now: () => Date,
): WorkflowRun {
	if (!token)
		throw new WorkflowRuntimeError(
			"unauthorized",
			"authenticated run capability is required",
		);
	const run = storeActiveRunForRole(repo, workflowId, stepId, role);
	const snapshot = getSnapshot(repo, workflowId, registry, now);
	if (
		snapshot.currentStep !== stepId ||
		!snapshot.step.activeRunIds.includes(run.id) ||
		!run.capabilityHash ||
		Date.parse(run.capabilityExpiresAt) <= now().getTime() ||
		!tokenMatches(token, run.capabilityHash)
	)
		throw new WorkflowRuntimeError(
			"unauthorized",
			"invalid or inactive run capability",
		);
	return run;
}

/** Validate a capability against the exact run that issued it. This is used
 * by subprocess-facing commands; role-scoped lookup is intentionally not
 * sufficient because a child process must not select a sibling run. */
export function authorizeExactRunCapability(
	repo: string,
	workflowId: string,
	runId: string,
	stepId: string,
	role: string,
	token: string,
	registry: WorkflowRegistry,
	now: () => Date,
): WorkflowRun {
	if (!token)
		throw new WorkflowRuntimeError(
			"unauthorized",
			"authenticated run capability is required",
		);
	const run = storeGetRun(repo, runId);
	const snapshot = getSnapshot(repo, workflowId, registry, now);
	if (
		run.workflowId !== workflowId ||
		run.stepId !== stepId ||
		run.role !== role ||
		snapshot.currentStep !== stepId ||
		!snapshot.step.activeRunIds.includes(run.id) ||
		!ACTIVE_RUN.has(run.status) ||
		!run.capabilityHash ||
		Date.parse(run.capabilityExpiresAt) <= now().getTime() ||
		!tokenMatches(token, run.capabilityHash)
	)
		throw new WorkflowRuntimeError(
			"unauthorized",
			"invalid or inactive run capability",
		);
	return run;
}

export function artifact(
	run: WorkflowRun,
	submitted?: string,
): { output: unknown; digest: string } {
	if (!submitted || !run.outputPath)
		throw new WorkflowRuntimeError("artifact", "required artifact missing");
	const expected = path.resolve(run.outputPath);
	const actual = path.resolve(submitted);
	if (actual !== expected)
		throw new WorkflowRuntimeError(
			"artifact",
			"artifact path does not match assignment",
		);
	const root = path.resolve(path.dirname(run.assignmentPath));
	if (!actual.startsWith(`${root}${path.sep}`))
		throw new WorkflowRuntimeError(
			"artifact",
			"artifact escapes run directory",
		);
	const stat = fs.lstatSync(actual);
	if (!stat.isFile() || stat.isSymbolicLink() || stat.size > MAX_ARTIFACT_BYTES)
		throw new WorkflowRuntimeError(
			"artifact",
			"artifact must be bounded regular non-symlink file",
		);
	const bytes = fs.readFileSync(actual);
	let envelope: unknown;
	try {
		envelope = JSON.parse(bytes.toString("utf8"));
	} catch {
		throw new WorkflowRuntimeError("artifact", "artifact is invalid JSON");
	}
	if (!envelope || typeof envelope !== "object" || Array.isArray(envelope))
		throw new WorkflowRuntimeError(
			"artifact",
			"artifact envelope must be object",
		);
	const item = envelope as Record<string, unknown>;
	const schema = run.outputSchema;
	if (
		!schema ||
		item.runId !== run.id ||
		item.schemaId !== schema.id ||
		item.schemaVersion !== schema.version
	)
		throw new WorkflowRuntimeError(
			"artifact",
			"artifact run/schema identity mismatch",
		);
	return {
		output: item.payload,
		digest: createHash("sha256").update(bytes).digest("hex"),
	};
}
