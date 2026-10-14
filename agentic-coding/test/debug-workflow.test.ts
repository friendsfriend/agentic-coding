// The debug family (`add-debug-workflow`, tasks 1.1-3.4): the graph's bounded
// follow-up loop, the single agent role and its brief, the developer gate's
// actions, the report contract's required headings, and the routing fallback
// that lets a preset without a `debug.investigate` pool run the family on its
// default profile.
import { describe, expect, test } from "bun:test";
import type { WorkflowSnapshot } from "../src/contracts/workflow.ts";
import {
	DEBUG_REPORT_HEADINGS,
	debugReport,
} from "../src/workflow/definitions/contracts.ts";
import {
	definitionVersionForFamilyTraits,
	effectiveFamilyTraits,
} from "../src/workflow/definitions/manifest-policy.ts";
import { registerBuiltins } from "../src/workflow/definitions/registerBuiltins.ts";
import {
	parseAgentsConfig,
	resolvePreset,
	resolveRouting,
	validatePresetCoverage,
} from "../src/workflow/profiles.ts";
import { outcomeForActionId } from "../src/workflow/runtime/reducers/developer-action.ts";
import { rolesForDefinition } from "../src/workflow/startup.ts";
import { DEBUG_ROLE, debugBehaviors } from "../src/workflow/steps/debug.ts";
import type { StepBehavior } from "../src/workflow/steps/types.ts";

function behavior(stepId: string): StepBehavior {
	const entry = debugBehaviors[stepId];
	if (!entry) throw new Error(`missing ${stepId} behavior`);
	return entry;
}

function reportMarkdown(): string {
	return DEBUG_REPORT_HEADINGS.map((heading) => `# ${heading}\n\ncontent`).join(
		"\n\n",
	);
}

const registry = registerBuiltins(undefined, 6);
const version = definitionVersionForFamilyTraits(6);
const definition = registry.definition("debug", version);

function snapshot(overrides: Partial<WorkflowSnapshot> = {}): WorkflowSnapshot {
	return {
		schemaVersion: 1,
		workflowId: "wf-debug-1",
		revision: 3,
		definition: { id: "debug", version, digest: "d" },
		status: "active",
		currentStep: "debug.investigate",
		step: {
			attempt: 1,
			mode: "apply",
			activeRunIds: [],
			completedRunIds: [],
			selectedRoles: [],
			testRunStarted: false,
			results: [],
		},
		metadata: {
			repository: "/repo/shop",
			worktree: "/worktrees/shop/shop.feature",
			changeId: "",
			branch: "feature/x",
			baseBranch: "",
			baseCommit: "",
			createdAt: "2026-01-01T00:00:00.000Z",
			updatedAt: "2026-01-01T00:00:00.000Z",
			stepEnteredAt: "2026-01-01T00:00:00.000Z",
			task: "the search returns nothing",
		},
		routing: { defaultProfile: "default", routes: [] },
		evidence: [],
		loopCounts: {},
		attention: [],
		developerDialogue: [],
		...overrides,
	} as WorkflowSnapshot;
}

describe("debug family registration", () => {
	test("the family is registered at the newest tier on a detached worktree", () => {
		expect(definition?.id).toBe("debug");
		expect(definition?.steps).toEqual([
			"core.route-debug",
			"debug.investigate",
			"debug.review",
			"core.completed",
			"core.closed",
		]);
		// The route step is the entry; the agent step follows it.
		expect(definition?.initial).toBe("core.route-debug");
		expect(definition?.policy?.checkoutRequired).toBe(false);
	});

	test("it declares the branch requirement and delivers nothing", () => {
		const traits = effectiveFamilyTraits(definition);
		expect(traits?.startRequirements).toEqual(["branch", "task"]);
		expect(traits?.delivery).toBe("none");
		expect(traits?.changeArtifacts).toBe("none");
	});

	test("completion offers close only, and never a delivery or archive step", () => {
		expect(definition?.allowedOutcomes).toEqual({
			"core.completed": ["close"],
		});
		for (const stepId of ["core.delivery", "core.archive", "core.wiki"])
			expect(definition?.steps ?? []).not.toContain(stepId);
	});

	test("the follow-up cycle is bounded to five investigation rounds", () => {
		const edge = definition?.edges.find(
			(candidate) =>
				candidate.from === "debug.review" && candidate.outcome === "comments",
		);
		// Per-step routing redirects the review's follow-up into the agent's
		// route step, so the loop budget rides on that edge.
		expect(edge?.to).toBe("core.route-debug");
		expect(edge?.loop?.maxAttempts).toBe(5);
	});

	test("only the investigate step runs an agent, and its brief is debug.md", () => {
		const agentSteps = (definition?.steps ?? []).filter(
			(stepId) => registry.step(stepId, 1).actor === "agent",
		);
		expect(agentSteps).toEqual(["debug.investigate"]);
		expect(
			behavior("debug.investigate").instructionAssetForRole?.({
				role: DEBUG_ROLE,
			}),
		).toBe("debug.md");
		expect(registry.step("debug.investigate", 1).instructionAssets).toContain(
			"debug.md",
		);
		expect(registry.step("debug.investigate", 1).output.id).toBe(
			"core.debug-report",
		);
	});
});

describe("debug step behaviors", () => {
	test("the investigation renders the branch and task and carries the comment", () => {
		const entry = behavior("debug.investigate");
		expect(entry.roles?.({ snapshot: snapshot() })).toEqual([DEBUG_ROLE]);
		expect(entry.carriesOutputContext).toBe(true);
		expect(entry.acceptsCommentsContext).toBe(true);
		const inputs = entry.assignmentInputs?.({
			snapshot: snapshot(),
			run: {
				stepId: "debug.investigate",
				role: DEBUG_ROLE,
				profile: { readOnly: false },
			},
		});
		expect(inputs?.objective).toContain("feature/x");
		expect(inputs?.objective).toContain("the search returns nothing");
	});

	test("the review gate offers approve and a comment-bearing follow-up", () => {
		const actions = behavior("debug.review").developerActions?.({
			snapshot: snapshot(),
		});
		expect(actions?.map((action) => action.id)).toEqual([
			"approve-review",
			"review-comments",
		]);
		const step = registry.step("debug.review", 1);
		for (const action of actions ?? [])
			expect(step.outcomes).toContain(outcomeForActionId(action.id));
	});
});

describe("debug report contract", () => {
	test("accepts a report that carries every required heading", () => {
		expect(debugReport.parse({ report: reportMarkdown() })).toEqual({
			report: reportMarkdown().trim(),
		});
	});

	test("rejects an empty report and one missing a heading", () => {
		expect(() => debugReport.parse({ report: "" })).toThrow(/non-empty/);
		expect(() => debugReport.parse({})).toThrow(/non-empty/);
		const missing = DEBUG_REPORT_HEADINGS.filter(
			(heading) => heading !== "Findings",
		)
			.map((heading) => `# ${heading}\n\ncontent`)
			.join("\n\n");
		expect(() => debugReport.parse({ report: missing })).toThrow(/Findings/);
	});
});

describe("debug routing", () => {
	test("a preset without a debug pool falls back to its default profile", () => {
		const agents = parseAgentsConfig({
			profiles: { p: { runtime: "pi-durable" } },
			presets: {
				debug: {
					default_profile: "p",
					pools: {
						"core.implementation": [
							{ label: "only", profile: "p", default: true },
						],
					},
				},
			},
		});
		const preset = resolvePreset(agents, "debug");
		// No `debug.investigate` pool is declared; coverage still passes because
		// the preset names a default profile.
		expect(() =>
			validatePresetCoverage(preset, definition, ["debug.investigate"], agents),
		).not.toThrow();
		const roles = rolesForDefinition(
			"debug",
			definition?.steps ?? [],
			registry,
			0,
			definition,
		);
		const routing = resolveRouting(definition, roles, agents, preset);
		const route = routing.routes.find(
			(candidate) => candidate.stepId === "debug.investigate",
		);
		expect(route?.profile.name).toBe("p");
	});
});
