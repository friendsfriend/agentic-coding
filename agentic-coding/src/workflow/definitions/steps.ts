// The builtin step catalog: per-step instruction asset lists, the `step()`
// factory that wires a step id to its contracts/behavior/instruction
// digests, and the full list of `StepDefinition`s registered by
// `registerBuiltins`. Moved verbatim out of definitions.ts
// (split-workflow-god-modules).
import { createHash } from "node:crypto";
import type { WorkflowSnapshot } from "../../contracts/workflow.ts";
import { AGENT_DEFINITIONS } from "../embedded.generated.ts";
import type { Reduction, StepDefinition, StepReference } from "../registry.ts";
import { stepBehavior } from "../steps/index.ts";
import {
	empty,
	findings,
	passthrough,
	planDraft,
	triage,
} from "./contracts.ts";

function unchanged(snapshot: WorkflowSnapshot): Reduction {
	return { snapshot: structuredClone(snapshot), effects: [] };
}

const INSTRUCTION_BY_STEP: Record<string, string[]> = {
	"core.plan": ["workflow-agent-protocol.md", "planning.md"],
	"core.implementation": ["workflow-agent-protocol.md", "implementation.md"],
	"core.triage": ["workflow-agent-protocol.md", "triage.md"],
	"core.verification": [
		"workflow-agent-protocol.md",
		"verification.md",
		"verification-security.md",
		"verification-quality.md",
		"verification-performance.md",
		"verification-openspec.md",
		"verification-usability.md",
		"verification-test.md",
		"verification-concurrency.md",
		"verification-migration.md",
		"verification-test-quality.md",
	],
	"core.wiki": [
		"workflow-agent-protocol.md",
		"wiki.md",
		"wiki-openspec.md",
		"wiki-research.md",
	],
	"core.research": ["workflow-agent-protocol.md", "research.md"],
	"core.archive": ["workflow-agent-protocol.md", "archive.md"],
	"fusion.plan": ["workflow-agent-protocol.md", "planning-fusion.md"],
	"fusion.consolidate": [
		"workflow-agent-protocol.md",
		"fusion-consolidation.md",
	],
};
function instructionDigest(name: string): string {
	const content = AGENT_DEFINITIONS[`instructions/${name}`];
	if (content === undefined)
		throw new Error(`missing instruction asset: ${name}`);
	return createHash("sha256").update(content).digest("hex");
}
function step(
	id: string,
	label: string,
	actor: "agent" | "developer" | "system",
	outcomes: string[],
	options: Partial<
		Pick<
			StepDefinition,
			| "version"
			| "requirements"
			| "allowedEffects"
			| "retryLimit"
			| "output"
			| "behaviorVersion"
		>
	> = {},
): StepDefinition {
	const assets = INSTRUCTION_BY_STEP[id] ?? [];
	return {
		id,
		version: options.version ?? 1,
		behaviorVersion: options.behaviorVersion ?? 1,
		label,
		actor,
		instructionAssets: assets,
		instructionDigests: assets.map(instructionDigest),
		requirements:
			options.requirements ??
			(actor === "agent" ? ["prompt", "run-environment", "observe"] : []),
		input: passthrough,
		output: options.output ?? (actor === "agent" ? passthrough : empty),
		outcomes,
		retryLimit: options.retryLimit,
		allowedEffects:
			options.allowedEffects ??
			(actor === "agent"
				? ["artifact.write", "agent.launch", "agent.prompt", "agent.stop"]
				: []),
		behavior: stepBehavior(id),
		enter: unchanged,
		reduce(snapshot, command) {
			if (!outcomes.includes(command.outcome))
				throw new Error(`illegal ${id} outcome: ${command.outcome}`);
			return unchanged(snapshot);
		},
	};
}

/** Step ids shared by every workflow family that runs an implementation
 * loop (openspec, no-openspec, fusion). The routing step and the gates are
 * tier-specific shape changes (classifier-driven-triage-routing,
 * add-jev-stage-gating): only a definition version that registers them carries
 * the per-round verifier-role selection and the gate steps. */
export function commonImplementationSteps(
	includeTriageRoute = false,
	stageGates = false,
): readonly string[] {
	return [
		"core.implementation",
		...(includeTriageRoute ? ["core.triage-route"] : []),
		"core.triage",
		"core.verification",
		...(stageGates ? ["core.review-gate"] : []),
		"core.developer-review",
	];
}

/** Convert a graph's stable step IDs into exact semantic references. Graph
 * edges intentionally continue using IDs so UI and transition identity stay
 * stable while new definition versions pin implementation compatibility. */
export function exactStepReferences(
	stepIds: readonly string[],
	versions: Readonly<Record<string, number>> = {},
): StepReference[] {
	return stepIds.map((id) => ({
		id,
		version: versions[id] ?? 1,
		behaviorVersion: 1,
	}));
}

export const WORKFLOW_STEPS: readonly StepDefinition[] = [
	step("core.plan", "Planning", "agent", ["complete", "blocked", "failed"], {
		retryLimit: 3,
		allowedEffects: [
			"artifact.write",
			"agent.launch",
			"agent.prompt",
			"agent.stop",
			"openspec.validate",
			"notification.show",
		],
	}),
	step(
		"fusion.plan",
		"Fusion planning",
		"agent",
		["complete", "blocked", "failed"],
		{
			output: planDraft,
			retryLimit: 3,
			allowedEffects: [
				"artifact.write",
				"agent.launch",
				"agent.prompt",
				"agent.stop",
				"openspec.validate",
				"notification.show",
			],
		},
	),
	step(
		"fusion.consolidate",
		"Plan fusion",
		"agent",
		["complete", "blocked", "failed"],
		{
			retryLimit: 3,
			allowedEffects: [
				"artifact.write",
				"agent.launch",
				"agent.prompt",
				"agent.stop",
				"openspec.validate",
				"notification.show",
			],
		},
	),
	step("core.plan-approval", "Plan approval", "developer", [
		"approve",
		"reject",
		"comments",
	]),
	step("core.route-plan", "Plan-phase model routing", "system", ["complete"], {
		allowedEffects: ["model.classify"],
		retryLimit: 3,
	}),
	step(
		"core.route-apply",
		"Apply-phase model routing",
		"system",
		["complete"],
		{
			allowedEffects: ["model.classify"],
			retryLimit: 3,
		},
	),
	// Per-step model selection (classifier-driven-step-model-selection): one
	// routing step immediately before every classifiable agent step. The
	// pre-per-step `core.route-plan`/`core.route-apply` passes stay registered
	// with the same ids and definitions, so a definition pinned to an earlier
	// tier keeps resolving them.
	step(
		"core.route-fusion-consolidate",
		"Consolidator model routing",
		"system",
		["complete"],
		{ allowedEffects: ["model.classify"], retryLimit: 3 },
	),
	step(
		"core.route-fusion-plan",
		"Fusion planner model routing",
		"system",
		["complete"],
		{ allowedEffects: ["model.classify"], retryLimit: 3 },
	),
	step(
		"core.route-implementation",
		"Implementation model routing",
		"system",
		["complete"],
		{ allowedEffects: ["model.classify"], retryLimit: 3 },
	),
	step("core.route-triage", "Triage model routing", "system", ["complete"], {
		allowedEffects: ["model.classify"],
		retryLimit: 3,
	}),
	step(
		"core.route-verification",
		"Verification model routing",
		"system",
		["complete"],
		{ allowedEffects: ["model.classify"], retryLimit: 3 },
	),
	step("core.route-wiki", "Wiki model routing", "system", ["complete"], {
		allowedEffects: ["model.classify"],
		retryLimit: 3,
	}),
	step("core.route-archive", "Archive model routing", "system", ["complete"], {
		allowedEffects: ["model.classify"],
		retryLimit: 3,
	}),
	step(
		"core.route-research",
		"Research model routing",
		"system",
		["complete"],
		{ allowedEffects: ["model.classify"], retryLimit: 3 },
	),
	step(
		"core.implementation",
		"Implementation",
		"agent",
		["complete", "blocked", "failed"],
		{ retryLimit: 6 },
	),
	step(
		"core.triage-route",
		"Verifier role routing",
		"system",
		// Version 1 is the published verifier-role-only step. Version 2 adds
		// the verification gate's `skip-verification` outcome; keeping the
		// earlier version registered leaves every definition pinned to it with
		// its previous step digest, so only the gate tier resolves version 2.
		["complete", "empty"],
		{
			allowedEffects: ["model.classify"],
			retryLimit: 3,
		},
	),
	step(
		"core.triage-route",
		"Verifier role routing",
		"system",
		["complete", "empty", "skip-verification"],
		{
			version: 2,
			allowedEffects: ["model.classify"],
			retryLimit: 3,
		},
	),
	step("core.plan-gate", "Plan approval gate", "system", ["run", "skip"], {
		allowedEffects: ["model.classify"],
		retryLimit: 3,
	}),
	step("core.review-gate", "Developer review gate", "system", ["run", "skip"], {
		allowedEffects: ["model.classify"],
		retryLimit: 3,
	}),
	step("core.wiki-gate", "Wiki documentation gate", "system", ["run", "skip"], {
		allowedEffects: ["model.classify"],
		retryLimit: 3,
	}),
	step(
		"core.triage",
		"Verification triage",
		"agent",
		["complete", "blocked", "failed"],
		{ output: triage, retryLimit: 3 },
	),
	step(
		"core.verification",
		"Verification",
		"agent",
		["pass", "fix", "limit", "blocked", "failed"],
		{
			requirements: ["prompt", "run-environment", "observe", "read-only"],
			output: findings,
			retryLimit: 20,
		},
	),
	step("core.developer-review", "Developer review", "developer", [
		"approve",
		"comments",
	]),
	step(
		"core.wiki",
		"Wiki documentation",
		"agent",
		["complete", "blocked", "failed"],
		{
			requirements: ["prompt", "run-environment", "observe", "shell", "edit"],
			retryLimit: 3,
		},
	),
	step(
		"core.wiki-approval",
		"Wiki approval",
		"developer",
		["approve", "comments"],
		{
			allowedEffects: ["wiki.verify"],
		},
	),
	step(
		"core.research",
		"Research",
		"agent",
		["blocked", "failed", "request-wiki", "close-research"],
		{
			retryLimit: 3,
			requirements: [
				"interactive",
				"prompt",
				"persistent-session",
				"run-environment",
				"observe",
			],
		},
	),
	step(
		"core.archive",
		"OpenSpec archive",
		"agent",
		["complete", "blocked", "failed"],
		{
			requirements: ["prompt", "run-environment", "observe", "shell", "edit"],
			retryLimit: 3,
			allowedEffects: [
				"artifact.write",
				"agent.launch",
				"agent.prompt",
				"agent.stop",
				"openspec.validate",
				"wiki.verify",
			],
		},
	),
	step("core.delivery", "Delivery", "system", ["complete", "failed"], {
		allowedEffects: ["delivery.commit", "delivery.push"],
	}),
	step("core.completed", "Completed", "developer", ["close", "create-pr"], {
		allowedEffects: ["pull-request.create", "workspace.close"],
	}),
	step("core.closed", "Closed", "system", ["closed"], {
		allowedEffects: ["workspace.close", "workspace.cleanup"],
	}),
];
