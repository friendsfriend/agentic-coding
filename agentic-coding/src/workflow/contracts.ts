import path from "node:path";
import { ContractFailure, decodeContract } from "../contracts/decode.ts";
import type { JsonValue, WorkflowSnapshot } from "../contracts/workflow.ts";
import { WorkflowSnapshotSchema } from "./schema.ts";
/** Shared with `src/workflow/steps/*.ts` so step behavior hooks can throw the
 * same engine error the runtime recognizes, without importing runtime.ts and
 * creating a cycle back through definitions.ts -> steps/index.ts. */
export class WorkflowRuntimeError extends Error {
	constructor(
		readonly code: string,
		message: string,
		readonly currentRevision?: number,
	) {
		super(message);
	}
}

export function decodeSnapshot(value: unknown): WorkflowSnapshot {
	const snapshot = decodeContract<WorkflowSnapshot>(
		"core.workflow-snapshot",
		WorkflowSnapshotSchema,
		value,
		// Preserve unknown keys through the read/rewrite cycle (QUALITY-004):
		// legacy or forward-compat snapshot_json keys not declared in the schema
		// must not be silently discarded when the engine decodes and rewrites
		// the parsed object back to the store.
		{ onExcessProperty: "preserve" },
	);
	// Repository-relative path normalization + cross-field invariants stay as
	// pure validation (design-permitted): Effect Schema decodes the structure,
	// these functions normalize/validate across fields without services.
	const repoIndependent =
		snapshot.definition.id === "wiki-comments" ||
		snapshot.definition.id === "research";
	const metadata: WorkflowSnapshot["metadata"] = { ...snapshot.metadata };
	metadata.repository =
		repoIndependent && metadata.repository === ""
			? ""
			: path.resolve(requireText(metadata.repository, "$.metadata.repository"));
	metadata.worktree = path.resolve(
		requireText(metadata.worktree, "$.metadata.worktree"),
	);
	metadata.branch =
		repoIndependent && metadata.branch === ""
			? ""
			: requireText(metadata.branch, "$.metadata.branch");
	metadata.baseBranch =
		repoIndependent && metadata.baseBranch === ""
			? ""
			: requireText(metadata.baseBranch, "$.metadata.baseBranch");
	metadata.baseCommit =
		repoIndependent && metadata.baseCommit === ""
			? ""
			: requireText(metadata.baseCommit, "$.metadata.baseCommit");
	if (metadata.wikiRoot !== undefined)
		metadata.wikiRoot = path.resolve(metadata.wikiRoot);
	const normalized: WorkflowSnapshot = { ...snapshot, metadata };
	if (normalized.step.context !== undefined)
		normalized.step.context = JSON.parse(
			JSON.stringify(normalized.step.context),
		) as JsonValue;
	const dialogue = normalized.developerDialogue;
	for (const item of dialogue) {
		if (item.status === "pending" && item.answer)
			throw new ContractFailure("core.workflow-snapshot", [
				{
					path: "$.developerDialogue",
					message: "pending question cannot have answer",
				},
			]);
		if (item.status !== "pending" && !item.answer)
			throw new ContractFailure("core.workflow-snapshot", [
				{
					path: "$.developerDialogue",
					message: "resolved question requires answer",
				},
			]);
	}
	if (new Set(dialogue.map((item) => item.id)).size !== dialogue.length)
		throw new ContractFailure("core.workflow-snapshot", [
			{ path: "$.developerDialogue", message: "duplicate question ID" },
		]);
	if (Buffer.byteLength(JSON.stringify(dialogue)) > 128 * 1024)
		throw new ContractFailure("core.workflow-snapshot", [
			{
				path: "$.developerDialogue",
				message: "dialogue content exceeds bound",
			},
		]);
	if (
		new Set(normalized.step.activeRunIds).size !==
		normalized.step.activeRunIds.length
	)
		throw new ContractFailure("core.workflow-snapshot", [
			{ path: "$.step.activeRunIds", message: "duplicate run ID" },
		]);
	if (
		normalized.status === "active" &&
		["core.completed", "core.closed"].includes(normalized.currentStep)
	)
		throw new ContractFailure("core.workflow-snapshot", [
			{ path: "$.status", message: "terminal step cannot be active" },
		]);
	return normalized;
}

/** Non-empty bounded string used by the snapshot path-normalization pass. */
function requireText(value: string, at: string): string {
	if (!value.trim())
		throw new ContractFailure("core.workflow-snapshot", [
			{ path: at, message: "expected non-empty string" },
		]);
	return value;
}
