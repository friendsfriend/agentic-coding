// Local step-output contracts used by the builtin step catalog
// (definitions/steps.ts), plus the standalone research-handoff contract
// consumed directly by runtime.ts's `agent.research-handoff` reducer. Moved
// verbatim out of definitions.ts (split-workflow-god-modules).
//
// Every contract's decoding is backed by a single Effect Schema in
// `../schema.ts` (adopt-workflow-effect-foundation, phase 1). These `Contract`
// objects are synchronous facades: they delegate to Schema and apply only the
// pure cross-field / byte-bound checks and output-shape projections the design
// permits, never a second validator.
import path from "node:path";
import type { Contract, JsonValue } from "../contracts.ts";
import { ContractFailure } from "../contracts.ts";
import {
	decodeContract,
	FindingsInputSchema,
	PlanDraftSchema,
	PlanResultSchema,
	ResearchHandoffSchema,
	TriagePlanSchema,
} from "../schema.ts";

export const passthrough: Contract<JsonValue> = {
	id: "core.json",
	version: 1,
	parse(value) {
		if (value === undefined) return null;
		try {
			return JSON.parse(JSON.stringify(value)) as JsonValue;
		} catch {
			throw new ContractFailure("core.json", [
				{ path: "$", message: "not JSON serializable" },
			]);
		}
	},
};
export const empty: Contract<null> = {
	id: "core.empty",
	version: 1,
	parse(value) {
		if (value !== undefined && value !== null)
			throw new ContractFailure("core.empty", [
				{ path: "$", message: "expected empty output" },
			]);
		return null;
	},
};
export const findings: Contract<{ critical: number }> = {
	id: "core.findings",
	version: 1,
	parse(value) {
		const input = decodeContract<{
			findings: Array<{ severity: "critical" | "warning" | "info" }>;
		}>("core.findings", FindingsInputSchema, value);
		return {
			critical: input.findings.filter(
				(finding) => finding.severity === "critical",
			).length,
		};
	},
};
export type ResearchHandoffDirectiveIntent = "create" | "update";
export interface ResearchHandoffDirective {
	/** Existing concept identifier to update, or a proposed project-scoped
	 * identifier for a new concept, depending on `intent`. */
	target: string;
	intent: ResearchHandoffDirectiveIntent;
	/** Specific source-backed facts the wiki agent must document. */
	claims: string[];
	/** Citations supporting this directive's claims. */
	citations: string[];
}
export interface ResearchHandoff {
	subject: string;
	canonicalTarget?: string;
	/** Freeform narrative/context the structured directives cannot capture. */
	findings: string;
	/** Per-concept documentation directives; the wiki agent's actionable
	 * starting point for which concepts to create or update. */
	directives: ResearchHandoffDirective[];
	citations: string[];
	noSourcesUsed: boolean;
}
const MAX_RESEARCH_HANDOFF_BYTES = 48 * 1024;
/** Schema-backed research-handoff decode (complete-workflow-effect-cutover,
 * task 3.1): the migration-only `researchHandoffContract` facade is removed;
 * the reducer decodes through the Schema path directly, keeping the byte
 * bound as pure validation. */
export function decodeResearchHandoff(value: unknown): ResearchHandoff {
	const parsed = decodeContract(
		"core.research-handoff",
		ResearchHandoffSchema,
		value,
	) as ResearchHandoff;
	if (
		Buffer.byteLength(JSON.stringify(parsed), "utf8") >
		MAX_RESEARCH_HANDOFF_BYTES
	)
		throw new ContractFailure("core.research-handoff", [
			{
				path: "$",
				message: `handoff exceeds ${MAX_RESEARCH_HANDOFF_BYTES} bytes serialized`,
			},
		]);
	return parsed;
}
export const triage: Contract<{
	roles: string[];
	assignments: Array<{ role: string; reason: string; files: string[] }>;
}> = {
	id: "core.triage-plan",
	version: 1,
	parse(value) {
		const input = decodeContract(
			"core.triage-plan",
			TriagePlanSchema,
			value,
		) as {
			roles: Array<{
				role: string;
				reason: string;
				files: string[];
				hunks?: Record<string, number[]>;
			}>;
		};
		for (const entry of input.roles) {
			if (
				!entry.files.length ||
				entry.files.some(
					(file) =>
						path.isAbsolute(file) || file.split(path.sep).includes(".."),
				)
			)
				throw new ContractFailure("core.triage-plan", [
					{
						path: "$.roles",
						message: "expected scoped repository-relative files",
					},
				]);
			if (entry.hunks !== undefined)
				for (const file of Object.keys(entry.hunks))
					if (!entry.files.includes(file))
						throw new ContractFailure("core.triage-plan", [
							{
								path: "$.roles",
								message: "invalid scoped hunk IDs",
							},
						]);
		}
		const assignments = input.roles.map((entry) => ({
			role: entry.role,
			reason: entry.reason,
			files: [...entry.files],
		}));
		return { roles: assignments.map((item) => item.role), assignments };
	},
};
export const planDraft: Contract<{
	approach: string;
	files: Array<{ path: string; change: string }>;
	risks: Array<{ detail: string }>;
	questions: Array<{ detail: string }>;
}> = {
	id: "core.plan-draft",
	version: 1,
	parse(value) {
		const input = decodeContract("core.plan-draft", PlanDraftSchema, value) as {
			approach: string;
			files: Array<{ path: string; change: string }>;
			risks: Array<{ detail: string }>;
			questions: Array<{ detail: string }>;
		};
		for (const file of input.files)
			if (
				path.isAbsolute(file.path) ||
				file.path.split(path.sep).includes("..")
			)
				throw new ContractFailure("core.plan-draft", [
					{
						path: "$.files",
						message: "expected repository-relative file path",
					},
				]);
		return input;
	},
};

/** The planning handoff output (`core.plan` / `fusion.consolidate` complete):
 * declares the primary change the workflow implements. The planner picks the
 * change id(s) itself, so the engine cannot know the primary at start — it is
 * required here and recorded into `metadata.changeId` by the handoff reducer
 * (which also validates the id shape and the declared change directory). The
 * remaining fields the planner emits for developer review are bounded but
 * optional, so single-pass and addressed retries keep their shape. */
export function decodePlanResult(value: unknown): {
	primaryChangeId: string;
	summary?: string;
	artifacts?: string[];
	risks?: string[];
	openQuestions?: string[];
} {
	return decodeContract("core.plan-result", PlanResultSchema, value) as {
		primaryChangeId: string;
		summary?: string;
		artifacts?: string[];
		risks?: string[];
		openQuestions?: string[];
	};
}
