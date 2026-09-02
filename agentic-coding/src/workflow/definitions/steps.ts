// The builtin step catalog: per-step instruction asset lists, the `step()`
// factory that wires a step id to its contracts/behavior/instruction
// digests, and the full list of `StepDefinition`s registered by
// `registerBuiltins`. Moved verbatim out of definitions.ts
// (split-workflow-god-modules).
import { createHash } from "node:crypto";
import type { WorkflowSnapshot } from "../contracts.ts";
import { AGENT_DEFINITIONS } from "../embedded.generated.ts";
import type { Reduction, StepDefinition } from "../registry.ts";
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
			"requirements" | "allowedEffects" | "retryLimit" | "output"
		>
	> = {},
): StepDefinition {
	const assets = INSTRUCTION_BY_STEP[id] ?? [];
	return {
		id,
		version: 1,
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
 * loop (openspec, no-openspec, fusion). */
export const COMMON_IMPLEMENTATION_STEPS: readonly string[] = [
	"core.implementation",
	"core.triage",
	"core.verification",
	"core.developer-review",
];

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
	step(
		"core.implementation",
		"Implementation",
		"agent",
		["complete", "blocked", "failed"],
		{ retryLimit: 6 },
	),
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
