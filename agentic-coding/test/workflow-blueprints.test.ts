// add-workflow-blueprint-compiler: the blueprint step catalog, the decode
// schema, the human-review validator and the pure compiler (internal-step
// rejection, insertion of the triage-routing/gate/per-step-routing steps,
// bounds, determinism, and equivalence with the newest built-in tier).
import { describe, expect, test } from "bun:test";
import {
	BLUEPRINT_STEP_CATALOG,
	BLUEPRINT_STEP_IDS,
	compileBlueprint,
	decodeBlueprint,
	isInternalStepId,
	MAX_BLUEPRINT_STEPS,
	validateBlueprintReviews,
} from "../src/workflow/blueprints/index.ts";
import {
	assertNewestTierInvariants,
	customDefinitionId,
} from "../src/workflow/definitions/custom.ts";
import { definitionVersionForFamilyTraits } from "../src/workflow/definitions/manifest-policy.ts";
import { WORKFLOW_STEPS } from "../src/workflow/definitions/steps.ts";
import { registerBuiltins } from "../src/workflow/definitions.ts";
import type { WorkflowEdge } from "../src/workflow/registry.ts";

const registry = registerBuiltins();
const TIER = definitionVersionForFamilyTraits(6);

const openspecTraits = {
	changeArtifacts: "openspec",
	planning: "single",
	changeIdentity: "planned",
	delivery: "pull-request",
	startRequirements: ["clean-tree", "openspec-project"],
	openspecVerifier: true,
} as const;
const noOpenspecTraits = {
	changeArtifacts: "none",
	planning: "none",
	changeIdentity: "none",
	delivery: "pull-request",
	startRequirements: ["task", "clean-tree"],
	openspecVerifier: false,
} as const;
const soloTraits = {
	changeArtifacts: "none",
	planning: "none",
	changeIdentity: "none",
	delivery: "none",
	startRequirements: ["task", "clean-tree"],
	openspecVerifier: true,
} as const;

function withRounds(
	blueprint: Record<string, unknown>,
): Record<string, unknown> {
	return { verificationRounds: 6, checkoutRequired: false, ...blueprint };
}

// ---------------------------------------------------------------------------
// Logical fixtures. These are the built-in families' logical graphs: the steps
// and edges before the compiler (and the built-in construction) insert the
// internal routing, triage-routing and gate steps.
// ---------------------------------------------------------------------------

function soloLogical(): Record<string, unknown> {
	return withRounds({
		label: "Solo task",
		rationale: "One implementation agent, start to finish.",
		traits: soloTraits,
		steps: ["core.implementation", "core.completed", "core.closed"],
		edges: [
			{
				from: "core.implementation",
				outcome: "complete",
				to: "core.completed",
			},
			{
				from: "core.implementation",
				outcome: "blocked",
				to: "core.implementation",
				loop: { maxAttempts: 3 },
			},
			{
				from: "core.implementation",
				outcome: "failed",
				to: "core.implementation",
				loop: { maxAttempts: 3 },
			},
			{ from: "core.completed", outcome: "close", to: "core.closed" },
		],
	});
}

function noOpenspecLogical(): Record<string, unknown> {
	return withRounds({
		label: "Change without OpenSpec",
		rationale: "Implement, verify, review, document and deliver.",
		traits: noOpenspecTraits,
		steps: [
			"core.implementation",
			"core.triage",
			"core.verification",
			"core.developer-review",
			"core.wiki",
			"core.wiki-approval",
			"core.delivery",
			"core.completed",
			"core.closed",
		],
		edges: [
			{
				from: "core.implementation",
				outcome: "complete",
				to: "core.triage",
			},
			{
				from: "core.implementation",
				outcome: "blocked",
				to: "core.implementation",
				loop: { maxAttempts: 6 },
			},
			{
				from: "core.implementation",
				outcome: "failed",
				to: "core.implementation",
				loop: { maxAttempts: 6 },
			},
			{ from: "core.triage", outcome: "complete", to: "core.verification" },
			{
				from: "core.triage",
				outcome: "blocked",
				to: "core.triage",
				loop: { maxAttempts: 3 },
			},
			{
				from: "core.triage",
				outcome: "failed",
				to: "core.triage",
				loop: { maxAttempts: 3 },
			},
			{
				from: "core.verification",
				outcome: "pass",
				to: "core.developer-review",
			},
			{
				from: "core.verification",
				outcome: "fix",
				to: "core.implementation",
				loop: { maxAttempts: 6 },
			},
			{
				from: "core.verification",
				outcome: "limit",
				to: "core.verification",
				loop: { maxAttempts: 1 },
			},
			{
				from: "core.verification",
				outcome: "blocked",
				to: "core.verification",
				loop: { maxAttempts: 6 },
			},
			{
				from: "core.verification",
				outcome: "failed",
				to: "core.implementation",
				loop: { maxAttempts: 6 },
			},
			{
				from: "core.developer-review",
				outcome: "approve",
				to: "core.wiki",
			},
			{
				from: "core.developer-review",
				outcome: "comments",
				to: "core.implementation",
				loop: { maxAttempts: 6 },
			},
			{ from: "core.wiki", outcome: "complete", to: "core.wiki-approval" },
			{
				from: "core.wiki",
				outcome: "blocked",
				to: "core.wiki",
				loop: { maxAttempts: 3 },
			},
			{
				from: "core.wiki",
				outcome: "failed",
				to: "core.wiki",
				loop: { maxAttempts: 3 },
			},
			{
				from: "core.wiki-approval",
				outcome: "approve",
				to: "core.delivery",
			},
			{
				from: "core.wiki-approval",
				outcome: "comments",
				to: "core.wiki",
				loop: { maxAttempts: 6 },
			},
			{ from: "core.delivery", outcome: "complete", to: "core.completed" },
			{
				from: "core.delivery",
				outcome: "failed",
				to: "core.delivery",
				loop: { maxAttempts: 3 },
			},
			{
				from: "core.completed",
				outcome: "create-pr",
				to: "core.completed",
				loop: { maxAttempts: 3 },
			},
			{ from: "core.completed", outcome: "close", to: "core.closed" },
		],
	});
}

function openspecLogical(): Record<string, unknown> {
	return withRounds({
		label: "OpenSpec change",
		rationale:
			"Plan, approve, implement, verify, review, document, archive, deliver.",
		traits: openspecTraits,
		steps: [
			"core.plan",
			"core.plan-approval",
			"core.implementation",
			"core.triage",
			"core.verification",
			"core.developer-review",
			"core.wiki",
			"core.wiki-approval",
			"core.archive",
			"core.delivery",
			"core.completed",
			"core.closed",
		],
		edges: [
			{ from: "core.plan", outcome: "complete", to: "core.plan-approval" },
			{
				from: "core.plan",
				outcome: "blocked",
				to: "core.plan",
				loop: { maxAttempts: 3 },
			},
			{
				from: "core.plan",
				outcome: "failed",
				to: "core.plan",
				loop: { maxAttempts: 3 },
			},
			{
				from: "core.plan-approval",
				outcome: "approve",
				to: "core.implementation",
			},
			{
				from: "core.plan-approval",
				outcome: "reject",
				to: "core.plan",
				loop: { maxAttempts: 3 },
			},
			{
				from: "core.plan-approval",
				outcome: "comments",
				to: "core.plan",
				loop: { maxAttempts: 3 },
			},
			{
				from: "core.implementation",
				outcome: "complete",
				to: "core.triage",
			},
			{
				from: "core.implementation",
				outcome: "blocked",
				to: "core.implementation",
				loop: { maxAttempts: 6 },
			},
			{
				from: "core.implementation",
				outcome: "failed",
				to: "core.implementation",
				loop: { maxAttempts: 6 },
			},
			{ from: "core.triage", outcome: "complete", to: "core.verification" },
			{
				from: "core.triage",
				outcome: "blocked",
				to: "core.triage",
				loop: { maxAttempts: 3 },
			},
			{
				from: "core.triage",
				outcome: "failed",
				to: "core.triage",
				loop: { maxAttempts: 3 },
			},
			{
				from: "core.verification",
				outcome: "pass",
				to: "core.developer-review",
			},
			{
				from: "core.verification",
				outcome: "fix",
				to: "core.implementation",
				loop: { maxAttempts: 6 },
			},
			{
				from: "core.verification",
				outcome: "limit",
				to: "core.verification",
				loop: { maxAttempts: 1 },
			},
			{
				from: "core.verification",
				outcome: "blocked",
				to: "core.verification",
				loop: { maxAttempts: 6 },
			},
			{
				from: "core.verification",
				outcome: "failed",
				to: "core.implementation",
				loop: { maxAttempts: 6 },
			},
			{
				from: "core.developer-review",
				outcome: "approve",
				to: "core.wiki",
			},
			{
				from: "core.developer-review",
				outcome: "comments",
				to: "core.implementation",
				loop: { maxAttempts: 6 },
			},
			{ from: "core.wiki", outcome: "complete", to: "core.wiki-approval" },
			{
				from: "core.wiki",
				outcome: "blocked",
				to: "core.wiki",
				loop: { maxAttempts: 3 },
			},
			{
				from: "core.wiki",
				outcome: "failed",
				to: "core.wiki",
				loop: { maxAttempts: 3 },
			},
			{
				from: "core.wiki-approval",
				outcome: "approve",
				to: "core.archive",
			},
			{
				from: "core.wiki-approval",
				outcome: "comments",
				to: "core.wiki",
				loop: { maxAttempts: 6 },
			},
			{ from: "core.archive", outcome: "complete", to: "core.delivery" },
			{
				from: "core.archive",
				outcome: "blocked",
				to: "core.archive",
				loop: { maxAttempts: 3 },
			},
			{
				from: "core.archive",
				outcome: "failed",
				to: "core.archive",
				loop: { maxAttempts: 3 },
			},
			{ from: "core.delivery", outcome: "complete", to: "core.completed" },
			{
				from: "core.delivery",
				outcome: "failed",
				to: "core.delivery",
				loop: { maxAttempts: 3 },
			},
			{
				from: "core.completed",
				outcome: "create-pr",
				to: "core.completed",
				loop: { maxAttempts: 3 },
			},
			{ from: "core.completed", outcome: "close", to: "core.closed" },
		],
	});
}

/** The verify family's logical graph: it reviews through `core.findings-review`
 * and enters the loop from `core.triage`, not from `core.implementation`. */
function verifyLogical(): Record<string, unknown> {
	return withRounds({
		label: "Verify the branch",
		rationale: "Verify the current branch and review the findings.",
		traits: {
			changeArtifacts: "none",
			planning: "none",
			changeIdentity: "none",
			delivery: "none",
			startRequirements: ["base-commit"],
			openspecVerifier: true,
		},
		steps: [
			"core.triage",
			"core.verification",
			"core.findings-review",
			"core.implementation",
			"core.completed",
			"core.closed",
		],
		edges: [
			{ from: "core.triage", outcome: "complete", to: "core.verification" },
			{
				from: "core.triage",
				outcome: "blocked",
				to: "core.triage",
				loop: { maxAttempts: 3 },
			},
			{
				from: "core.triage",
				outcome: "failed",
				to: "core.triage",
				loop: { maxAttempts: 3 },
			},
			{
				from: "core.verification",
				outcome: "pass",
				to: "core.findings-review",
			},
			{
				from: "core.verification",
				outcome: "fix",
				to: "core.findings-review",
				loop: { maxAttempts: 6 },
			},
			{
				from: "core.verification",
				outcome: "limit",
				to: "core.verification",
				loop: { maxAttempts: 1 },
			},
			{
				from: "core.verification",
				outcome: "blocked",
				to: "core.verification",
				loop: { maxAttempts: 3 },
			},
			{
				from: "core.verification",
				outcome: "failed",
				to: "core.verification",
				loop: { maxAttempts: 3 },
			},
			{
				from: "core.findings-review",
				outcome: "approve",
				to: "core.completed",
			},
			{
				from: "core.findings-review",
				outcome: "comments",
				to: "core.implementation",
				loop: { maxAttempts: 6 },
			},
			{
				from: "core.implementation",
				outcome: "complete",
				to: "core.triage",
				loop: { maxAttempts: 6 },
			},
			{
				from: "core.implementation",
				outcome: "blocked",
				to: "core.implementation",
				loop: { maxAttempts: 6 },
			},
			{
				from: "core.implementation",
				outcome: "failed",
				to: "core.implementation",
				loop: { maxAttempts: 6 },
			},
			{ from: "core.completed", outcome: "close", to: "core.closed" },
		],
	});
}

// ---------------------------------------------------------------------------

/** The rebase family's logical graph: one agent, then lifecycle bookkeeping. */
function rebaseLogical(): Record<string, unknown> {
	return withRounds({
		label: "Rebase the branch",
		rationale: "Rebase one branch onto another.",
		traits: {
			changeArtifacts: "none",
			planning: "none",
			changeIdentity: "none",
			delivery: "none",
			startRequirements: ["clean-tree", "rebase-refs"],
			openspecVerifier: true,
		},
		steps: ["core.rebase", "core.completed", "core.closed"],
		edges: [
			{ from: "core.rebase", outcome: "complete", to: "core.completed" },
			{
				from: "core.rebase",
				outcome: "blocked",
				to: "core.rebase",
				loop: { maxAttempts: 3 },
			},
			{
				from: "core.rebase",
				outcome: "failed",
				to: "core.rebase",
				loop: { maxAttempts: 3 },
			},
			{ from: "core.completed", outcome: "close", to: "core.closed" },
		],
	});
}

/** The propose-only family: plan, approve, done. `delivery: "none"` means its
 * `create-pr` edge is inert, so completion misses no review. */
function openspecProposeLogical(): Record<string, unknown> {
	return withRounds({
		label: "Propose a change",
		rationale: "Plan and approve, then stop.",
		traits: {
			changeArtifacts: "openspec",
			planning: "single",
			changeIdentity: "planned",
			delivery: "none",
			startRequirements: ["openspec-project"],
			openspecVerifier: true,
		},
		steps: ["core.plan", "core.plan-approval", "core.completed", "core.closed"],
		edges: [
			{ from: "core.plan", outcome: "complete", to: "core.plan-approval" },
			{
				from: "core.plan",
				outcome: "blocked",
				to: "core.plan",
				loop: { maxAttempts: 3 },
			},
			{
				from: "core.plan",
				outcome: "failed",
				to: "core.plan",
				loop: { maxAttempts: 3 },
			},
			{
				from: "core.plan-approval",
				outcome: "approve",
				to: "core.completed",
			},
			{
				from: "core.plan-approval",
				outcome: "reject",
				to: "core.plan",
				loop: { maxAttempts: 3 },
			},
			{
				from: "core.plan-approval",
				outcome: "comments",
				to: "core.plan",
				loop: { maxAttempts: 3 },
			},
			{
				from: "core.completed",
				outcome: "create-pr",
				to: "core.completed",
				loop: { maxAttempts: 3 },
			},
			{ from: "core.completed", outcome: "close", to: "core.closed" },
		],
	});
}

/** The apply-only OpenSpec family: no planning, but archive and delivery. */
function openspecApplyLogical(): Record<string, unknown> {
	return withRounds({
		label: "Apply and archive",
		rationale: "Implement, verify, review, document, archive and deliver.",
		traits: {
			changeArtifacts: "openspec",
			planning: "none",
			changeIdentity: "workflow-id",
			delivery: "pull-request",
			startRequirements: ["clean-tree", "openspec-project", "openspec-change"],
			openspecVerifier: true,
		},
		steps: [
			"core.implementation",
			"core.triage",
			"core.verification",
			"core.developer-review",
			"core.wiki",
			"core.wiki-approval",
			"core.archive",
			"core.delivery",
			"core.completed",
			"core.closed",
		],
		edges: [
			{
				from: "core.implementation",
				outcome: "complete",
				to: "core.triage",
			},
			{
				from: "core.implementation",
				outcome: "blocked",
				to: "core.implementation",
				loop: { maxAttempts: 6 },
			},
			{
				from: "core.implementation",
				outcome: "failed",
				to: "core.implementation",
				loop: { maxAttempts: 6 },
			},
			{ from: "core.triage", outcome: "complete", to: "core.verification" },
			{
				from: "core.triage",
				outcome: "blocked",
				to: "core.triage",
				loop: { maxAttempts: 3 },
			},
			{
				from: "core.triage",
				outcome: "failed",
				to: "core.triage",
				loop: { maxAttempts: 3 },
			},
			{
				from: "core.verification",
				outcome: "pass",
				to: "core.developer-review",
			},
			{
				from: "core.verification",
				outcome: "fix",
				to: "core.implementation",
				loop: { maxAttempts: 6 },
			},
			{
				from: "core.verification",
				outcome: "limit",
				to: "core.verification",
				loop: { maxAttempts: 1 },
			},
			{
				from: "core.verification",
				outcome: "blocked",
				to: "core.verification",
				loop: { maxAttempts: 6 },
			},
			{
				from: "core.verification",
				outcome: "failed",
				to: "core.implementation",
				loop: { maxAttempts: 6 },
			},
			{
				from: "core.developer-review",
				outcome: "approve",
				to: "core.wiki",
			},
			{
				from: "core.developer-review",
				outcome: "comments",
				to: "core.implementation",
				loop: { maxAttempts: 6 },
			},
			{ from: "core.wiki", outcome: "complete", to: "core.wiki-approval" },
			{
				from: "core.wiki",
				outcome: "blocked",
				to: "core.wiki",
				loop: { maxAttempts: 3 },
			},
			{
				from: "core.wiki",
				outcome: "failed",
				to: "core.wiki",
				loop: { maxAttempts: 3 },
			},
			{
				from: "core.wiki-approval",
				outcome: "approve",
				to: "core.archive",
			},
			{
				from: "core.wiki-approval",
				outcome: "comments",
				to: "core.wiki",
				loop: { maxAttempts: 6 },
			},
			{ from: "core.archive", outcome: "complete", to: "core.delivery" },
			{
				from: "core.archive",
				outcome: "blocked",
				to: "core.archive",
				loop: { maxAttempts: 3 },
			},
			{
				from: "core.archive",
				outcome: "failed",
				to: "core.archive",
				loop: { maxAttempts: 3 },
			},
			{ from: "core.delivery", outcome: "complete", to: "core.completed" },
			{
				from: "core.delivery",
				outcome: "failed",
				to: "core.delivery",
				loop: { maxAttempts: 3 },
			},
			{
				from: "core.completed",
				outcome: "create-pr",
				to: "core.completed",
				loop: { maxAttempts: 3 },
			},
			{ from: "core.completed", outcome: "close", to: "core.closed" },
		],
	});
}

/** The fusion family: a classified planner roster consolidating to one plan. */
function fusionLogical(): Record<string, unknown> {
	return withRounds({
		label: "Fusion change",
		rationale: "Plan as a roster, consolidate, then implement through close.",
		traits: {
			changeArtifacts: "openspec",
			planning: "fusion",
			changeIdentity: "planned",
			delivery: "pull-request",
			startRequirements: ["clean-tree", "openspec-project"],
			openspecVerifier: true,
		},
		steps: [
			"fusion.plan",
			"fusion.consolidate",
			"core.plan-approval",
			"core.implementation",
			"core.triage",
			"core.verification",
			"core.developer-review",
			"core.wiki",
			"core.wiki-approval",
			"core.archive",
			"core.delivery",
			"core.completed",
			"core.closed",
		],
		edges: [
			...fusionPlanningEdges(),
			{
				from: "core.plan-approval",
				outcome: "approve",
				to: "core.implementation",
			},
			...commonImplementationEdges(),
			{ from: "core.completed", outcome: "close", to: "core.closed" },
		],
	});
}

/** The fusion propose-only family: plan as a roster, consolidate, approve, done. */
function fusionProposeLogical(): Record<string, unknown> {
	return withRounds({
		label: "Fusion proposal",
		rationale: "Plan as a roster and stop at approval.",
		traits: {
			changeArtifacts: "openspec",
			planning: "fusion",
			changeIdentity: "planned",
			delivery: "none",
			startRequirements: ["openspec-project"],
			openspecVerifier: true,
		},
		steps: [
			"fusion.plan",
			"fusion.consolidate",
			"core.plan-approval",
			"core.completed",
			"core.closed",
		],
		edges: [
			...fusionPlanningEdges(),
			{
				from: "core.plan-approval",
				outcome: "approve",
				to: "core.completed",
			},
			{
				from: "core.completed",
				outcome: "create-pr",
				to: "core.completed",
				loop: { maxAttempts: 3 },
			},
			{ from: "core.completed", outcome: "close", to: "core.closed" },
		],
	});
}

/** The fusion planning phase's logical edges; the approval outcome is supplied
 * by each caller. */
function fusionPlanningEdges(): Array<Record<string, unknown>> {
	return [
		{ from: "fusion.plan", outcome: "complete", to: "fusion.consolidate" },
		{
			from: "fusion.plan",
			outcome: "blocked",
			to: "fusion.plan",
			loop: { maxAttempts: 3 },
		},
		{
			from: "fusion.plan",
			outcome: "failed",
			to: "fusion.plan",
			loop: { maxAttempts: 3 },
		},
		{
			from: "fusion.consolidate",
			outcome: "complete",
			to: "core.plan-approval",
		},
		{
			from: "fusion.consolidate",
			outcome: "blocked",
			to: "fusion.consolidate",
			loop: { maxAttempts: 3 },
		},
		{
			from: "fusion.consolidate",
			outcome: "failed",
			to: "fusion.consolidate",
			loop: { maxAttempts: 3 },
		},
		{
			from: "core.plan-approval",
			outcome: "reject",
			to: "fusion.consolidate",
			loop: { maxAttempts: 3 },
		},
		{
			from: "core.plan-approval",
			outcome: "comments",
			to: "fusion.consolidate",
			loop: { maxAttempts: 3 },
		},
	];
}

/** The shared implementation loop's logical edges (from `core.implementation`
 * through delivery to completion). */
function commonImplementationEdges(): Array<Record<string, unknown>> {
	return [
		{ from: "core.implementation", outcome: "complete", to: "core.triage" },
		{
			from: "core.implementation",
			outcome: "blocked",
			to: "core.implementation",
			loop: { maxAttempts: 6 },
		},
		{
			from: "core.implementation",
			outcome: "failed",
			to: "core.implementation",
			loop: { maxAttempts: 6 },
		},
		{ from: "core.triage", outcome: "complete", to: "core.verification" },
		{
			from: "core.triage",
			outcome: "blocked",
			to: "core.triage",
			loop: { maxAttempts: 3 },
		},
		{
			from: "core.triage",
			outcome: "failed",
			to: "core.triage",
			loop: { maxAttempts: 3 },
		},
		{
			from: "core.verification",
			outcome: "pass",
			to: "core.developer-review",
		},
		{
			from: "core.verification",
			outcome: "fix",
			to: "core.implementation",
			loop: { maxAttempts: 6 },
		},
		{
			from: "core.verification",
			outcome: "limit",
			to: "core.verification",
			loop: { maxAttempts: 1 },
		},
		{
			from: "core.verification",
			outcome: "blocked",
			to: "core.verification",
			loop: { maxAttempts: 6 },
		},
		{
			from: "core.verification",
			outcome: "failed",
			to: "core.implementation",
			loop: { maxAttempts: 6 },
		},
		{
			from: "core.developer-review",
			outcome: "approve",
			to: "core.wiki",
		},
		{
			from: "core.developer-review",
			outcome: "comments",
			to: "core.implementation",
			loop: { maxAttempts: 6 },
		},
		{ from: "core.wiki", outcome: "complete", to: "core.wiki-approval" },
		{
			from: "core.wiki",
			outcome: "blocked",
			to: "core.wiki",
			loop: { maxAttempts: 3 },
		},
		{
			from: "core.wiki",
			outcome: "failed",
			to: "core.wiki",
			loop: { maxAttempts: 3 },
		},
		{
			from: "core.wiki-approval",
			outcome: "approve",
			to: "core.archive",
		},
		{
			from: "core.wiki-approval",
			outcome: "comments",
			to: "core.wiki",
			loop: { maxAttempts: 6 },
		},
		{ from: "core.archive", outcome: "complete", to: "core.delivery" },
		{
			from: "core.archive",
			outcome: "blocked",
			to: "core.archive",
			loop: { maxAttempts: 3 },
		},
		{
			from: "core.archive",
			outcome: "failed",
			to: "core.archive",
			loop: { maxAttempts: 3 },
		},
		{ from: "core.delivery", outcome: "complete", to: "core.completed" },
		{
			from: "core.delivery",
			outcome: "failed",
			to: "core.delivery",
			loop: { maxAttempts: 3 },
		},
		{
			from: "core.completed",
			outcome: "create-pr",
			to: "core.completed",
			loop: { maxAttempts: 3 },
		},
	];
}

// ---------------------------------------------------------------------------

function canonicalEdge(edge: WorkflowEdge): string {
	const effects = (edge.effects ?? [])
		.map((effect) => effect.kind)
		.sort()
		.join(",");
	return `${edge.from}|${edge.outcome}|${edge.to}|${edge.loop?.maxAttempts ?? "-"}|${effects}`;
}

function canonicalEdges(edges: readonly WorkflowEdge[]): string[] {
	return edges.map(canonicalEdge).sort();
}

function expectCompiled(value: unknown) {
	const result = compileBlueprint(registry, value);
	if (!result.ok)
		throw new Error(
			`expected compilation to succeed: ${result.diagnostics
				.map((diagnostic) => diagnostic.message)
				.join("; ")}`,
		);
	return result;
}

function expectFailed(value: unknown, rule: string) {
	const result = compileBlueprint(registry, value);
	expect(result.ok).toBe(false);
	if (result.ok) throw new Error("expected compilation to fail");
	const match = result.diagnostics.find(
		(diagnostic) => diagnostic.rule === rule,
	);
	expect(match).toBeDefined();
	return result.diagnostics;
}

describe("blueprint step catalog", () => {
	test("the built-in catalog's widest logical graph fits the blueprint step bound", () => {
		let widest = 0;
		for (const family of [
			"openspec",
			"openspec-apply",
			"openspec-propose",
			"openspec-fusion",
			"openspec-fusion-propose",
			"no-openspec",
			"solo",
			"rebase",
			"verify",
			"wiki",
			"wiki-comments",
			"research",
		]) {
			const definition = registry.definition(family, TIER);
			const logical = definition.steps.filter(
				(id) => !isInternalStepId(id),
			).length;
			widest = Math.max(widest, logical);
		}
		expect(widest).toBeLessThanOrEqual(MAX_BLUEPRINT_STEPS);
	});

	test("every catalog entry is a registered step and no internal step is listed", () => {
		expect(new Set(BLUEPRINT_STEP_IDS).size).toBe(BLUEPRINT_STEP_IDS.length);
		for (const entry of BLUEPRINT_STEP_CATALOG) {
			const registered = WORKFLOW_STEPS.find((step) => step.id === entry.id);
			if (!registered)
				throw new Error(`catalog entry ${entry.id} is not a registered step`);
			expect(entry.label).toBe(registered.label);
			expect(entry.actor).toBe(registered.actor);
			expect([...entry.outcomes]).toEqual([...registered.outcomes]);
			expect(entry.description.length).toBeGreaterThan(0);
			expect(isInternalStepId(entry.id)).toBe(false);
		}
		for (const internal of [
			"core.route-implementation",
			"core.route-plan",
			"core.route-apply",
			"core.triage-route",
			"core.plan-gate",
			"core.review-gate",
			"core.wiki-gate",
		]) {
			expect(isInternalStepId(internal)).toBe(true);
			expect(BLUEPRINT_STEP_IDS).not.toContain(internal);
		}
	});
});

describe("blueprint schema", () => {
	test("decodes a blueprint and defaults checkoutRequired to false", () => {
		const decoded = decodeBlueprint(soloLogical());
		expect(decoded.label).toBe("Solo task");
		expect(decoded.checkoutRequired).toBe(false);
		expect(decoded.steps).toContain("core.implementation");
	});

	test("rejects a blueprint without a label or a valid round count", () => {
		const missingLabel = soloLogical();
		delete missingLabel.label;
		expect(() => decodeBlueprint(missingLabel)).toThrow(/label/);
		expect(() =>
			decodeBlueprint({ ...soloLogical(), verificationRounds: 0 }),
		).toThrow(/verificationRounds/);
		expect(() => decodeBlueprint({ ...soloLogical(), traits: {} })).toThrow(
			/changeArtifacts/,
		);
	});

	test("bounds the authored step and edge arrays and rejects unknown fields", () => {
		const steps = Array.from(
			{ length: 65 },
			(_, index) => `core.step-${index}`,
		);
		expect(() => decodeBlueprint({ ...soloLogical(), steps })).toThrow(
			/at most 64/,
		);
		const edges = Array.from({ length: 257 }, () => ({
			from: "core.implementation",
			outcome: "complete",
			to: "core.completed",
		}));
		expect(() => decodeBlueprint({ ...soloLogical(), edges })).toThrow(
			/at most 256/,
		);
		// A mistyped field is not silently dropped from the persisted manifest.
		expect(() =>
			decodeBlueprint({ ...soloLogical(), checkoutRequiered: true }),
		).toThrow();
		expect(() =>
			decodeBlueprint({
				...soloLogical(),
				traits: {
					...soloTraits,
					startRequirements: Array.from({ length: 7 }, () => "task"),
				},
			}),
		).toThrow(/at most 6/);
	});

	test("bounds the issue path of an unexpected property name", () => {
		const longKey = "K".repeat(4096);
		const diagnostics = expectFailed(
			{ ...soloLogical(), [longKey]: true },
			"schema",
		);
		expect(diagnostics[0]?.message).not.toContain(longKey);
		expect(diagnostics[0]?.path?.[0]?.length).toBeLessThanOrEqual(257);
	});
});

describe("human-review validator", () => {
	test("passes an implementation loop that returns to implementation after review", () => {
		const steps = [
			"core.implementation",
			"core.verification",
			"core.developer-review",
			"core.delivery",
			"core.completed",
			"core.closed",
		];
		const edges: WorkflowEdge[] = [
			{
				from: "core.implementation",
				outcome: "complete",
				to: "core.verification",
			},
			{
				from: "core.verification",
				outcome: "pass",
				to: "core.developer-review",
			},
			{
				from: "core.developer-review",
				outcome: "comments",
				to: "core.implementation",
				loop: { maxAttempts: 6 },
			},
			{
				from: "core.developer-review",
				outcome: "approve",
				to: "core.delivery",
			},
			{ from: "core.delivery", outcome: "complete", to: "core.completed" },
			{ from: "core.completed", outcome: "close", to: "core.closed" },
		];
		expect(validateBlueprintReviews(steps, edges)).toEqual([]);
	});

	test("passes planning that goes through plan approval", () => {
		const steps = [
			"core.plan",
			"core.plan-approval",
			"core.implementation",
			"core.developer-review",
			"core.completed",
			"core.closed",
		];
		const edges: WorkflowEdge[] = [
			{ from: "core.plan", outcome: "complete", to: "core.plan-approval" },
			{
				from: "core.plan-approval",
				outcome: "approve",
				to: "core.implementation",
			},
			{
				from: "core.implementation",
				outcome: "complete",
				to: "core.developer-review",
			},
			{
				from: "core.developer-review",
				outcome: "approve",
				to: "core.completed",
			},
			{ from: "core.completed", outcome: "close", to: "core.closed" },
		];
		expect(
			validateBlueprintReviews(steps, edges).filter(
				(violation) => violation.rule === "plan-approval",
			),
		).toEqual([]);
	});

	test("passes wiki work that goes through wiki approval", () => {
		const steps = [
			"core.wiki",
			"core.wiki-approval",
			"core.delivery",
			"core.completed",
			"core.closed",
		];
		const edges: WorkflowEdge[] = [
			{ from: "core.wiki", outcome: "complete", to: "core.wiki-approval" },
			{
				from: "core.wiki-approval",
				outcome: "approve",
				to: "core.delivery",
			},
			{ from: "core.delivery", outcome: "complete", to: "core.completed" },
			{ from: "core.completed", outcome: "close", to: "core.closed" },
		];
		expect(
			validateBlueprintReviews(steps, edges).filter(
				(violation) => violation.rule === "wiki-approval",
			),
		).toEqual([]);
	});

	test("allows the solo shape (nothing delivered, completion is the only exit)", () => {
		const steps = ["core.implementation", "core.completed", "core.closed"];
		const edges: WorkflowEdge[] = [
			{
				from: "core.implementation",
				outcome: "complete",
				to: "core.completed",
			},
			{ from: "core.completed", outcome: "close", to: "core.closed" },
		];
		expect(validateBlueprintReviews(steps, edges)).toEqual([]);
	});

	test("rejects implementation reaching delivery without a review", () => {
		const steps = [
			"core.implementation",
			"core.verification",
			"core.delivery",
			"core.completed",
			"core.closed",
		];
		const edges: WorkflowEdge[] = [
			{
				from: "core.implementation",
				outcome: "complete",
				to: "core.verification",
			},
			{
				from: "core.verification",
				outcome: "pass",
				to: "core.delivery",
			},
			{ from: "core.delivery", outcome: "complete", to: "core.completed" },
			{ from: "core.completed", outcome: "close", to: "core.closed" },
		];
		const violations = validateBlueprintReviews(steps, edges);
		expect(violations).toHaveLength(1);
		expect(violations[0]?.rule).toBe("implementation-review");
		expect(violations[0]?.path).toContain("core.delivery");
	});

	test("rejects planning reaching implementation without plan approval", () => {
		const steps = ["core.plan", "core.implementation", "core.closed"];
		const edges: WorkflowEdge[] = [
			{
				from: "core.plan",
				outcome: "complete",
				to: "core.implementation",
			},
			{ from: "core.implementation", outcome: "complete", to: "core.closed" },
		];
		const violations = validateBlueprintReviews(steps, edges);
		expect(violations.map((violation) => violation.rule)).toContain(
			"plan-approval",
		);
	});

	test("accepts core.findings-review as the review node", () => {
		const steps = [
			"core.implementation",
			"core.verification",
			"core.findings-review",
			"core.delivery",
			"core.completed",
			"core.closed",
		];
		const edges: WorkflowEdge[] = [
			{
				from: "core.implementation",
				outcome: "complete",
				to: "core.verification",
			},
			{
				from: "core.verification",
				outcome: "pass",
				to: "core.findings-review",
			},
			{
				from: "core.findings-review",
				outcome: "approve",
				to: "core.delivery",
			},
			{ from: "core.delivery", outcome: "complete", to: "core.completed" },
			{ from: "core.completed", outcome: "close", to: "core.closed" },
		];
		expect(validateBlueprintReviews(steps, edges)).toEqual([]);
	});

	test("accepts fusion planning that goes through plan approval", () => {
		const steps = [
			"fusion.plan",
			"fusion.consolidate",
			"core.plan-approval",
			"core.implementation",
			"core.developer-review",
			"core.completed",
			"core.closed",
		];
		const edges: WorkflowEdge[] = [
			{
				from: "fusion.plan",
				outcome: "complete",
				to: "fusion.consolidate",
			},
			{
				from: "fusion.consolidate",
				outcome: "complete",
				to: "core.plan-approval",
			},
			{
				from: "core.plan-approval",
				outcome: "approve",
				to: "core.implementation",
			},
			{
				from: "core.implementation",
				outcome: "complete",
				to: "core.developer-review",
			},
			{
				from: "core.developer-review",
				outcome: "approve",
				to: "core.completed",
			},
			{ from: "core.completed", outcome: "close", to: "core.closed" },
		];
		expect(
			validateBlueprintReviews(steps, edges).filter(
				(violation) => violation.rule === "plan-approval",
			),
		).toEqual([]);
	});

	test("rejects a fusion planner reaching implementation without approval", () => {
		const steps = ["fusion.plan", "core.implementation", "core.closed"];
		const edges: WorkflowEdge[] = [
			{
				from: "fusion.plan",
				outcome: "complete",
				to: "core.implementation",
			},
			{ from: "core.implementation", outcome: "complete", to: "core.closed" },
		];
		expect(
			validateBlueprintReviews(steps, edges).map((violation) => violation.rule),
		).toContain("plan-approval");
	});

	test("rejects wiki work reaching delivery without wiki approval", () => {
		const steps = [
			"core.wiki",
			"core.delivery",
			"core.completed",
			"core.closed",
		];
		const edges: WorkflowEdge[] = [
			{ from: "core.wiki", outcome: "complete", to: "core.delivery" },
			{ from: "core.delivery", outcome: "complete", to: "core.completed" },
			{ from: "core.completed", outcome: "close", to: "core.closed" },
		];
		const violations = validateBlueprintReviews(steps, edges);
		expect(violations.map((violation) => violation.rule)).toContain(
			"wiki-approval",
		);
	});
});

describe("blueprint compiler", () => {
	test("rejects an internal step, naming the step", () => {
		const diagnostics = expectFailed(
			{
				...soloLogical(),
				steps: [
					"core.route-implementation",
					"core.implementation",
					"core.completed",
					"core.closed",
				],
			},
			"internal-step",
		);
		expect(diagnostics[0]?.message).toContain("core.route-implementation");
	});

	test("rejects a step outside the catalog", () => {
		const diagnostics = expectFailed(
			{
				...soloLogical(),
				steps: ["core.mystery", "core.implementation", "core.closed"],
			},
			"unknown-step",
		);
		expect(diagnostics[0]?.message).toContain("core.mystery");
	});

	test("rejects an illegal outcome and a dangling edge", () => {
		const solo = soloLogical();
		expectFailed(
			{
				...solo,
				edges: [
					...(solo.edges as unknown[]),
					{ from: "core.completed", outcome: "nope", to: "core.closed" },
				],
			},
			"illegal-outcome",
		);
		expectFailed(
			{
				...solo,
				edges: [{ from: "core.completed", outcome: "close", to: "core.gone" }],
			},
			"unknown-edge-endpoint",
		);
	});

	test("enforces the step, loop and verification-round bounds", () => {
		expectFailed(
			{
				...soloLogical(),
				steps: [
					"core.plan",
					"fusion.plan",
					"fusion.consolidate",
					"core.plan-approval",
					"core.implementation",
					"core.triage",
					"core.verification",
					"core.developer-review",
					"core.findings-review",
					"core.wiki",
					"core.wiki-approval",
					"core.archive",
					"core.delivery",
					"core.rebase",
				],
			},
			"bounds.steps",
		);
		const solo = soloLogical();
		expectFailed(
			{
				...solo,
				edges: (solo.edges as Array<Record<string, unknown>>).map((edge) =>
					edge.from === "core.implementation" && edge.outcome === "blocked"
						? { ...edge, loop: { maxAttempts: 21 } }
						: edge,
				),
			},
			"bounds.loop",
		);
		expectFailed(
			{ ...soloLogical(), verificationRounds: 50 },
			"bounds.verification-rounds",
		);
	});

	test("rejects a review bypass with the developer-review rule", () => {
		const diagnostics = expectFailed(
			withRounds({
				label: "Review-free delivery",
				rationale: "Verification hands straight off.",
				traits: noOpenspecTraits,
				steps: [
					"core.implementation",
					"core.verification",
					"core.delivery",
					"core.completed",
					"core.closed",
				],
				edges: [
					{
						from: "core.implementation",
						outcome: "complete",
						to: "core.verification",
					},
					{
						from: "core.verification",
						outcome: "pass",
						to: "core.delivery",
					},
					{
						from: "core.verification",
						outcome: "fix",
						to: "core.implementation",
						loop: { maxAttempts: 6 },
					},
					{
						from: "core.delivery",
						outcome: "complete",
						to: "core.completed",
					},
					{ from: "core.completed", outcome: "close", to: "core.closed" },
				],
			}),
			"review.implementation-review",
		);
		expect(diagnostics[0]?.message).toContain("core.delivery");
		expect(
			diagnostics.find(
				(diagnostic) => diagnostic.rule === "review.implementation-review",
			)?.path,
		).toEqual(["core.implementation", "core.verification", "core.delivery"]);
	});

	test("rejects an implementation-free blueprint that hands straight off to delivery", () => {
		const diagnostics = expectFailed(
			withRounds({
				label: "Plan then deliver",
				rationale: "x",
				traits: openspecTraits,
				steps: ["core.plan", "core.delivery", "core.completed", "core.closed"],
				edges: [
					{
						from: "core.plan",
						outcome: "complete",
						to: "core.delivery",
					},
					{
						from: "core.delivery",
						outcome: "complete",
						to: "core.completed",
					},
					{ from: "core.completed", outcome: "close", to: "core.closed" },
				],
			}),
			"review.implementation-review",
		);
		// The same planning path also reaches delivery without plan approval.
		expect(
			diagnostics.find(
				(diagnostic) => diagnostic.rule === "review.plan-approval",
			)?.path,
		).toEqual(["core.plan", "core.delivery"]);
	});

	test("rejects planning reaching completion without plan approval", () => {
		const diagnostics = expectFailed(
			withRounds({
				label: "Plan then rebase",
				rationale: "x",
				traits: {
					...openspecTraits,
					delivery: "none",
					startRequirements: ["task"],
				},
				steps: ["core.plan", "core.rebase", "core.completed", "core.closed"],
				edges: [
					{ from: "core.plan", outcome: "complete", to: "core.rebase" },
					{
						from: "core.rebase",
						outcome: "complete",
						to: "core.completed",
					},
					{
						from: "core.rebase",
						outcome: "blocked",
						to: "core.rebase",
						loop: { maxAttempts: 3 },
					},
					{
						from: "core.rebase",
						outcome: "failed",
						to: "core.rebase",
						loop: { maxAttempts: 3 },
					},
					{ from: "core.completed", outcome: "close", to: "core.closed" },
				],
			}),
			"review.plan-approval",
		);
		expect(
			diagnostics.find(
				(diagnostic) => diagnostic.rule === "review.plan-approval",
			)?.path,
		).toEqual(["core.plan", "core.rebase", "core.completed"]);
	});

	test("rejects a change identity that contradicts the planner", () => {
		expectFailed(
			{
				...soloLogical(),
				traits: { ...openspecTraits, changeIdentity: "workflow-id" },
				steps: [
					"core.plan",
					"core.implementation",
					"core.completed",
					"core.closed",
				],
			},
			"change-identity",
		);
		expectFailed(
			{
				...soloLogical(),
				traits: { ...noOpenspecTraits, changeIdentity: "planned" },
			},
			"change-identity",
		);
	});

	test("rejects a review-free delivery reached from the entry, not from implementation", () => {
		const diagnostics = expectFailed(
			withRounds({
				label: "Verify then deliver",
				rationale: "x",
				traits: noOpenspecTraits,
				steps: [
					"core.verification",
					"core.implementation",
					"core.delivery",
					"core.completed",
					"core.closed",
				],
				edges: [
					{
						from: "core.verification",
						outcome: "pass",
						to: "core.delivery",
					},
					{
						from: "core.verification",
						outcome: "fix",
						to: "core.implementation",
						loop: { maxAttempts: 6 },
					},
					{
						from: "core.verification",
						outcome: "limit",
						to: "core.verification",
						loop: { maxAttempts: 1 },
					},
					{
						from: "core.implementation",
						outcome: "complete",
						to: "core.closed",
					},
					{
						from: "core.delivery",
						outcome: "complete",
						to: "core.completed",
					},
					{ from: "core.completed", outcome: "close", to: "core.closed" },
				],
			}),
			"review.implementation-review",
		);
		expect(
			diagnostics.find(
				(diagnostic) => diagnostic.rule === "review.implementation-review",
			)?.message,
		).toContain("core.verification");
	});

	test("rejects a terminal step as the entry", () => {
		expectFailed(
			withRounds({
				label: "Completed as entry",
				rationale: "x",
				traits: soloTraits,
				steps: ["core.completed", "core.closed"],
				edges: [
					{ from: "core.completed", outcome: "close", to: "core.closed" },
				],
			}),
			"initial-step",
		);
	});

	test("requires a verification fix loop for a verifying graph", () => {
		const diagnostics = expectFailed(
			withRounds({
				label: "Single-pass verification",
				rationale: "x",
				traits: noOpenspecTraits,
				steps: [
					"core.implementation",
					"core.verification",
					"core.developer-review",
					"core.delivery",
					"core.completed",
					"core.closed",
				],
				edges: [
					{
						from: "core.implementation",
						outcome: "complete",
						to: "core.verification",
					},
					{
						from: "core.verification",
						outcome: "pass",
						to: "core.developer-review",
					},
					{
						from: "core.developer-review",
						outcome: "approve",
						to: "core.delivery",
					},
					{
						from: "core.delivery",
						outcome: "complete",
						to: "core.completed",
					},
					{ from: "core.completed", outcome: "close", to: "core.closed" },
				],
			}),
			"bounds.verification-rounds",
		);
		expect(
			diagnostics.find(
				(diagnostic) => diagnostic.rule === "bounds.verification-rounds",
			)?.message,
		).toContain("no fix edge");
	});

	test("requires the verification fix edge to carry a loop bound", () => {
		const diagnostics = expectFailed(
			withRounds({
				label: "Loop-less fix edge",
				rationale: "x",
				traits: noOpenspecTraits,
				steps: [
					"core.implementation",
					"core.verification",
					"core.developer-review",
					"core.delivery",
					"core.completed",
					"core.closed",
				],
				edges: [
					{
						from: "core.implementation",
						outcome: "complete",
						to: "core.verification",
					},
					{
						from: "core.verification",
						outcome: "pass",
						to: "core.developer-review",
					},
					// The fix edge closes the round but declares no loop bound.
					{
						from: "core.verification",
						outcome: "fix",
						to: "core.implementation",
					},
					{
						from: "core.developer-review",
						outcome: "approve",
						to: "core.delivery",
					},
					{
						from: "core.delivery",
						outcome: "complete",
						to: "core.completed",
					},
					{ from: "core.completed", outcome: "close", to: "core.closed" },
				],
			}),
			"bounds.verification-rounds",
		);
		expect(
			diagnostics.find(
				(diagnostic) => diagnostic.rule === "bounds.verification-rounds",
			)?.message,
		).toContain("must carry a loop bound");
	});

	test("rejects duplicate steps and duplicate edges", () => {
		expectFailed(
			{
				...soloLogical(),
				steps: [
					"core.implementation",
					"core.implementation",
					"core.completed",
					"core.closed",
				],
			},
			"duplicate-step",
		);
		const solo = soloLogical();
		expectFailed(
			{
				...solo,
				edges: [
					...(solo.edges as unknown[]),
					{ from: "core.completed", outcome: "close", to: "core.closed" },
				],
			},
			"duplicate-edge",
		);
	});

	test("rejects an empty step list and an undecodable blueprint", () => {
		expectFailed({ ...soloLogical(), steps: [] }, "empty-steps");
		expectFailed({ nope: true }, "schema");
		expectFailed("not a blueprint", "schema");
	});

	test("rejects an entry step after the review chain", () => {
		// Starting at delivery would run git add -A and push before any
		// implementation or review; the derived entry is constrained.
		expectFailed(
			{
				label: "Entry at delivery",
				rationale: "x",
				traits: {
					changeArtifacts: "none",
					planning: "none",
					changeIdentity: "none",
					delivery: "pull-request",
					startRequirements: ["task"],
					openspecVerifier: false,
				},
				checkoutRequired: false,
				verificationRounds: 6,
				steps: [
					"core.delivery",
					"core.implementation",
					"core.findings-review",
					"core.completed",
					"core.closed",
				],
				edges: [
					{
						from: "core.delivery",
						outcome: "failed",
						to: "core.implementation",
						loop: { maxAttempts: 3 },
					},
					{
						from: "core.delivery",
						outcome: "complete",
						to: "core.completed",
					},
					{
						from: "core.implementation",
						outcome: "complete",
						to: "core.findings-review",
					},
					{
						from: "core.findings-review",
						outcome: "approve",
						to: "core.delivery",
						loop: { maxAttempts: 3 },
					},
					{
						from: "core.findings-review",
						outcome: "comments",
						to: "core.implementation",
						loop: { maxAttempts: 6 },
					},
					{ from: "core.completed", outcome: "close", to: "core.closed" },
				],
			},
			"initial-step",
		);
	});

	test("rejects a graph with no terminal step", () => {
		expectFailed(
			withRounds({
				label: "No sink",
				rationale: "x",
				traits: soloTraits,
				steps: ["core.implementation", "core.completed"],
				edges: [
					{
						from: "core.implementation",
						outcome: "complete",
						to: "core.completed",
					},
					{
						from: "core.completed",
						outcome: "close",
						to: "core.implementation",
						loop: { maxAttempts: 3 },
					},
				],
			}),
			"terminal-step",
		);
	});

	test("rejects triage without implementation to route into it", () => {
		expectFailed(
			withRounds({
				label: "Triage alone",
				rationale: "x",
				traits: soloTraits,
				steps: [
					"core.triage",
					"core.verification",
					"core.completed",
					"core.closed",
				],
				edges: [
					{
						from: "core.triage",
						outcome: "complete",
						to: "core.verification",
					},
					{
						from: "core.verification",
						outcome: "pass",
						to: "core.completed",
					},
					{
						from: "core.verification",
						outcome: "fix",
						to: "core.triage",
						loop: { maxAttempts: 6 },
					},
					{ from: "core.completed", outcome: "close", to: "core.closed" },
				],
			}),
			"triage-routing",
		);
	});

	test("rejects a gated stage with no approval target to skip to", () => {
		expectFailed(
			withRounds({
				label: "Approval without a plan",
				rationale: "x",
				traits: soloTraits,
				steps: [
					"core.plan-approval",
					"core.implementation",
					"core.completed",
					"core.closed",
				],
				edges: [
					{
						from: "core.plan-approval",
						outcome: "reject",
						to: "core.plan-approval",
						loop: { maxAttempts: 3 },
					},
					{
						from: "core.implementation",
						outcome: "complete",
						to: "core.completed",
					},
					{ from: "core.completed", outcome: "close", to: "core.closed" },
				],
			}),
			"stage-gate",
		);
	});

	test("maps the plan-approval and wiki-approval rules through the compiler", () => {
		const planDiagnostics = expectFailed(
			withRounds({
				label: "No plan approval",
				rationale: "x",
				traits: openspecTraits,
				steps: [
					"core.plan",
					"core.implementation",
					"core.completed",
					"core.closed",
				],
				edges: [
					{
						from: "core.plan",
						outcome: "complete",
						to: "core.implementation",
					},
					{
						from: "core.implementation",
						outcome: "complete",
						to: "core.completed",
					},
					{ from: "core.completed", outcome: "close", to: "core.closed" },
				],
			}),
			"review.plan-approval",
		);
		expect(
			planDiagnostics.find(
				(diagnostic) => diagnostic.rule === "review.plan-approval",
			)?.path,
		).toEqual(["core.plan", "core.implementation"]);
		const wikiDiagnostics = expectFailed(
			withRounds({
				label: "No wiki approval",
				rationale: "x",
				traits: noOpenspecTraits,
				steps: ["core.wiki", "core.delivery", "core.completed", "core.closed"],
				edges: [
					{ from: "core.wiki", outcome: "complete", to: "core.delivery" },
					{
						from: "core.delivery",
						outcome: "complete",
						to: "core.completed",
					},
					{ from: "core.completed", outcome: "close", to: "core.closed" },
				],
			}),
			"review.wiki-approval",
		);
		expect(
			wikiDiagnostics.find(
				(diagnostic) => diagnostic.rule === "review.wiki-approval",
			)?.path,
		).toEqual(["core.wiki", "core.delivery"]);
	});

	test("rejects completion that can create a pull request without a review", () => {
		// No delivery step, but `create-pr` is reachable, so completion is a
		// delivery point and must sit behind a review.
		expectFailed(
			withRounds({
				label: "PR without review",
				rationale: "x",
				traits: { ...soloTraits, delivery: "pull-request" },
				steps: ["core.implementation", "core.completed", "core.closed"],
				edges: [
					{
						from: "core.implementation",
						outcome: "complete",
						to: "core.completed",
					},
					{
						from: "core.completed",
						outcome: "create-pr",
						to: "core.completed",
						loop: { maxAttempts: 3 },
					},
					{ from: "core.completed", outcome: "close", to: "core.closed" },
				],
			}),
			"review.implementation-review",
		);
	});

	test("requires the declared round count to match the verification fix loop", () => {
		const diagnostics = expectFailed(
			{ ...noOpenspecLogical(), verificationRounds: 3 },
			"bounds.verification-rounds",
		);
		expect(
			diagnostics.find(
				(diagnostic) => diagnostic.rule === "bounds.verification-rounds",
			)?.message,
		).toContain("core.verification/fix->core.implementation");
	});

	test("names the offending edge in the loop bound diagnostic", () => {
		const solo = soloLogical();
		const diagnostics = expectFailed(
			{
				...solo,
				edges: (solo.edges as Array<Record<string, unknown>>).map((edge) =>
					edge.from === "core.implementation" && edge.outcome === "blocked"
						? { ...edge, loop: { maxAttempts: 21 } }
						: edge,
				),
			},
			"bounds.loop",
		);
		expect(
			diagnostics.find((diagnostic) => diagnostic.rule === "bounds.loop")
				?.message,
		).toContain("core.implementation/blocked->core.implementation");
	});

	test("names the count and the cap in the step bound diagnostic", () => {
		const diagnostics = expectFailed(
			{
				...soloLogical(),
				steps: [
					"core.plan",
					"fusion.plan",
					"fusion.consolidate",
					"core.plan-approval",
					"core.implementation",
					"core.triage",
					"core.verification",
					"core.developer-review",
					"core.findings-review",
					"core.wiki",
					"core.wiki-approval",
					"core.archive",
					"core.delivery",
					"core.rebase",
				],
			},
			"bounds.steps",
		);
		expect(
			diagnostics.find((diagnostic) => diagnostic.rule === "bounds.steps")
				?.message,
		).toContain(`declares 14`);
		expect(
			diagnostics.find((diagnostic) => diagnostic.rule === "bounds.steps")
				?.message,
		).toContain(`tops out at ${MAX_BLUEPRINT_STEPS}`);
	});

	test("maps a registry cycle failure to the compile rule", () => {
		// A cycle-closing edge with no loop bound is caught by the registry, not
		// by a blueprint rule; pin that fallback mapping.
		const diagnostics = expectFailed(
			withRounds({
				label: "Cycle without a loop",
				rationale: "x",
				traits: soloTraits,
				steps: ["core.implementation", "core.completed", "core.closed"],
				edges: [
					{
						from: "core.implementation",
						outcome: "complete",
						to: "core.completed",
					},
					{ from: "core.completed", outcome: "close", to: "core.closed" },
					// Closes a loop without a loop bound.
					{
						from: "core.implementation",
						outcome: "blocked",
						to: "core.implementation",
					},
				],
			}),
			"compile",
		);
		expect(diagnostics[0]?.message).toContain("cycle");
	});

	test("wires the triage-routing skip outcome for a review-free triage graph", () => {
		const result = expectCompiled(
			withRounds({
				label: "Verify and complete",
				rationale: "x",
				traits: soloTraits,
				steps: [
					"core.implementation",
					"core.triage",
					"core.verification",
					"core.completed",
					"core.closed",
				],
				edges: [
					{
						from: "core.implementation",
						outcome: "complete",
						to: "core.triage",
					},
					{
						from: "core.triage",
						outcome: "complete",
						to: "core.verification",
					},
					{
						from: "core.verification",
						outcome: "pass",
						to: "core.completed",
					},
					{
						from: "core.verification",
						outcome: "fix",
						to: "core.implementation",
						loop: { maxAttempts: 6 },
					},
					{
						from: "core.verification",
						outcome: "limit",
						to: "core.verification",
						loop: { maxAttempts: 1 },
					},
					{
						from: "core.verification",
						outcome: "blocked",
						to: "core.verification",
						loop: { maxAttempts: 6 },
					},
					{
						from: "core.verification",
						outcome: "failed",
						to: "core.implementation",
						loop: { maxAttempts: 6 },
					},
					{
						from: "core.implementation",
						outcome: "blocked",
						to: "core.implementation",
						loop: { maxAttempts: 6 },
					},
					{
						from: "core.implementation",
						outcome: "failed",
						to: "core.implementation",
						loop: { maxAttempts: 6 },
					},
					{ from: "core.completed", outcome: "close", to: "core.closed" },
				],
			}),
		);
		expect(
			result.manifest.edges.find(
				(edge) =>
					edge.from === "core.triage-route" &&
					edge.outcome === "skip-verification",
			),
		).toBeDefined();
	});

	test("gives each compiled manifest its own wiki-verify effect instance", () => {
		const first = expectCompiled(noOpenspecLogical());
		const second = expectCompiled(noOpenspecLogical());
		const effectsOf = (result: ReturnType<typeof expectCompiled>) => {
			const edge = result.manifest.edges.find(
				(candidate) =>
					candidate.from === "core.wiki-approval" &&
					candidate.outcome === "approve",
			);
			if (!edge) throw new Error("missing wiki-approval approve edge");
			return edge.effects;
		};
		expect(effectsOf(first)).not.toBe(effectsOf(second));
	});

	test("compiles the built-in families' logical graphs to the same steps and edges", () => {
		for (const [family, blueprint] of [
			["openspec", openspecLogical()],
			["openspec-apply", openspecApplyLogical()],
			["openspec-propose", openspecProposeLogical()],
			["openspec-fusion", fusionLogical()],
			["openspec-fusion-propose", fusionProposeLogical()],
			["no-openspec", noOpenspecLogical()],
			["solo", soloLogical()],
			["rebase", rebaseLogical()],
			["verify", verifyLogical()],
		] as const) {
			const result = expectCompiled(blueprint);
			const builtin = registry.definition(family, TIER);
			expect(result.summary.steps).toEqual(builtin.steps);
			expect(result.manifest.initial).toBe(builtin.initial);
			expect(canonicalEdges(result.manifest.edges)).toEqual(
				canonicalEdges(builtin.edges),
			);
			// The built-in carries the wiki.verify effect; the compiler mirrors it.
			const wikiApprove = result.manifest.edges.find(
				(edge) =>
					edge.from === "core.wiki-approval" && edge.outcome === "approve",
			);
			if (wikiApprove)
				expect(wikiApprove.effects).toEqual([
					{ kind: "wiki.verify", idempotencyKey: "wiki.verify", payload: {} },
				]);
		}
	});

	test("is deterministic: the same blueprint compiles to the same digest twice", () => {
		const first = expectCompiled(noOpenspecLogical());
		const second = expectCompiled(noOpenspecLogical());
		expect(second.digest).toBe(first.digest);
		expect(second.definitionId).toBe(first.definitionId);
		expect(second.identityDigest).toBe(first.identityDigest);
		// The stored row and the `custom.` identifier are keyed on the identity
		// digest, which is distinct from the pin digest.
		expect(customDefinitionId(first.identityDigest)).toBe(first.definitionId);
		expect(first.identityDigest).not.toBe(first.digest);
	});

	test("derives clean-tree for a delivering blueprint's start requirements", () => {
		const result = expectCompiled({
			...openspecLogical(),
			traits: { ...openspecTraits, startRequirements: ["openspec-project"] },
		});
		expect(result.manifest.policy?.traits?.startRequirements).toEqual([
			"openspec-project",
			"clean-tree",
		]);
		// A non-delivering graph passes its traits through unchanged.
		const verifying = expectCompiled(verifyLogical());
		expect(verifying.manifest.policy?.traits).toEqual({
			changeArtifacts: "none",
			planning: "none",
			changeIdentity: "none",
			delivery: "none",
			startRequirements: ["base-commit"],
			openspecVerifier: true,
		});
	});

	test("moves the entry onto a gate inserted in front of it", () => {
		// A wiki-only blueprint's entry is the gated stage itself; the inserted
		// gate becomes the run's entry rather than being left unreachable.
		const result = expectCompiled(
			withRounds({
				label: "Wiki only",
				rationale: "x",
				traits: {
					changeArtifacts: "none",
					planning: "none",
					changeIdentity: "none",
					delivery: "none",
					startRequirements: ["task"],
					openspecVerifier: false,
				},
				steps: [
					"core.wiki",
					"core.wiki-approval",
					"core.completed",
					"core.closed",
				],
				edges: [
					{
						from: "core.wiki",
						outcome: "complete",
						to: "core.wiki-approval",
					},
					{
						from: "core.wiki",
						outcome: "blocked",
						to: "core.wiki",
						loop: { maxAttempts: 3 },
					},
					{
						from: "core.wiki",
						outcome: "failed",
						to: "core.wiki",
						loop: { maxAttempts: 3 },
					},
					{
						from: "core.wiki-approval",
						outcome: "approve",
						to: "core.completed",
					},
					{
						from: "core.wiki-approval",
						outcome: "comments",
						to: "core.wiki",
						loop: { maxAttempts: 6 },
					},
					{ from: "core.completed", outcome: "close", to: "core.closed" },
				],
			}),
		);
		expect(result.manifest.initial).toBe("core.wiki-gate");
	});

	test("the compiled manifest satisfies the custom-definition invariants", () => {
		for (const blueprint of [
			openspecLogical(),
			noOpenspecLogical(),
			soloLogical(),
		]) {
			const result = expectCompiled(blueprint);
			expect(() => assertNewestTierInvariants(result.manifest)).not.toThrow();
			const compiled = registry.compileWorkflow(result.manifest);
			expect(compiled.id).toBe(result.definitionId);
			expect(compiled.id.startsWith("custom.")).toBe(true);
			expect(compiled.digest).toBe(result.digest);
		}
	});

	test("inserts the per-step routing and gate steps the built-in tier has", () => {
		const result = expectCompiled(noOpenspecLogical());
		for (const id of [
			"core.route-implementation",
			"core.route-triage",
			"core.route-verification",
			"core.route-wiki",
			"core.triage-route",
			"core.review-gate",
			"core.wiki-gate",
		])
			expect(result.summary.steps).toContain(id);
	});
});
