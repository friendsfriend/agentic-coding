import { afterEach, describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type {
	ResolvedProfile,
	WorkflowSnapshot,
} from "../src/contracts/workflow.ts";
import {
	CLASSIFIER_ARTIFACT_CAP_BYTES,
	collectClassifierArtifacts,
	routingRequest,
} from "../src/workflow/classifier-runner.ts";
import {
	APPLY_PHASE_STEPS,
	parseClassifierAnswer,
	selectRosterEntries,
	selectSingleEntry,
} from "../src/workflow/classifiers.ts";
import {
	definitionVersionForBehaviorPins,
	registerBuiltins,
} from "../src/workflow/definitions.ts";
import {
	POOL_STEPS,
	parseAgentsConfig,
	resolvePreset,
} from "../src/workflow/profiles.ts";
import { applyClassifierRouting } from "../src/workflow/runtime/reducers/effect-result.ts";
import { STEP_BEHAVIORS, stepBehavior } from "../src/workflow/steps/index.ts";

const temps: string[] = [];
function tempDir(): string {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "workflow-classifier-"));
	temps.push(dir);
	return dir;
}
afterEach(() => {
	for (const dir of temps.splice(0))
		fs.rmSync(dir, { recursive: true, force: true });
});

const POOLS = {
	"core.plan": [
		{ label: "quick", profile: "base" },
		{ label: "thorough", profile: "strong", default: true },
	],
	"core.implementation": [
		{ label: "quick", profile: "base" },
		{ label: "thorough", profile: "strong", default: true },
	],
	"core.triage": [{ label: "quick", profile: "base", default: true }],
	"core.verification": [
		{ label: "quick", profile: "base" },
		{ label: "thorough", profile: "strong", default: true },
	],
	"core.wiki": [{ label: "quick", profile: "base", default: true }],
	"core.archive": [{ label: "quick", profile: "base", default: true }],
	"fusion.consolidate": [{ label: "quick", profile: "base", default: true }],
	"fusion.plan": [
		{ label: "strong", profile: "strong", default: true },
		{ label: "balanced", profile: "base", default: true },
	],
};

function writeAgentsConfig(dir: string, pools: unknown = POOLS): string {
	const file = path.join(dir, "config.json");
	fs.writeFileSync(
		file,
		JSON.stringify({
			agents: {
				default_profile: "base",
				profiles: {
					base: { runtime: "pi", executable: "/bin/true" },
					strong: { runtime: "pi", executable: "/bin/true" },
				},
				presets: { auto: { pools } },
			},
		}),
	);
	return file;
}

function baseProfile(name: string): ResolvedProfile {
	return {
		name,
		runtime: "pi",
		executable: "/bin/true",
		tools: [],
		extensions: [],
		readOnly: false,
		capabilities: ["prompt", "run-environment", "observe"],
		digest: name,
	} as ResolvedProfile;
}

describe("routing answer parsing", () => {
	test("keeps choice, probabilities, and confidence", () => {
		expect(
			parseClassifierAnswer({
				type: "choice",
				choice: "thorough",
				confidence: 0.9,
				probabilities: { quick: 0.1, thorough: 0.9 },
			}),
		).toEqual({
			type: "choice",
			choice: "thorough",
			confidence: 0.9,
			probabilities: { quick: 0.1, thorough: 0.9 },
		});
	});

	test("collapses missing or malformed answers to noul", () => {
		expect(parseClassifierAnswer(undefined)).toEqual({ type: "noul" });
		expect(parseClassifierAnswer({ type: "noul" })).toEqual({ type: "noul" });
		expect(parseClassifierAnswer({ confidence: 0.9 })).toEqual({
			type: "noul",
		});
	});

	test("selects a single entry above the confidence floor", () => {
		const entries = [
			{ label: "quick", profile: "base" },
			{ label: "thorough", profile: "strong", default: true },
		];
		expect(
			selectSingleEntry(entries, {
				type: "choice",
				choice: "quick",
				confidence: 0.8,
			}),
		).toEqual({ profile: "base" });
	});

	test("falls back to the tagged default below the confidence floor", () => {
		const entries = [
			{ label: "quick", profile: "base" },
			{ label: "thorough", profile: "strong", default: true },
		];
		const result = selectSingleEntry(entries, {
			type: "choice",
			choice: "quick",
			confidence: 0.2,
		});
		expect(result.profile).toBe("strong");
		expect(result.attention).toContain("confidence");
	});

	test("a choice without a confidence never clears the gate", () => {
		const entries = [
			{ label: "quick", profile: "base" },
			{ label: "thorough", profile: "strong", default: true },
		];
		const result = selectSingleEntry(entries, {
			type: "choice",
			choice: "quick",
		});
		expect(result.profile).toBe("strong");
		expect(result.attention).toContain("confidence");
	});

	test("an unknown label falls back to the tagged default", () => {
		const entries = [
			{ label: "quick", profile: "base" },
			{ label: "thorough", profile: "strong", default: true },
		];
		const result = selectSingleEntry(entries, {
			type: "choice",
			choice: "missing",
			confidence: 0.9,
		});
		expect(result.profile).toBe("strong");
		expect(result.attention).toContain("no usable choice");
	});

	test("thresholds, de-duplicates, and clamps a roster", () => {
		const entries = [
			{ label: "a", profile: "p1" },
			{ label: "b", profile: "p2" },
			{ label: "c", profile: "p3" },
			{ label: "d", profile: "p4" },
			{ label: "e", profile: "p5" },
			{ label: "f", profile: "p1" },
		];
		const result = selectRosterEntries(entries, {
			type: "choice",
			probabilities: {
				a: 0.9,
				b: 0.8,
				c: 0.7,
				d: 0.6,
				e: 0.5,
				f: 0.4,
				low: 0.05,
			},
		});
		expect(result.profiles).toEqual(["p1", "p2", "p3", "p4", "p5"]);
	});

	test("falls back to tagged defaults when the roster collapses", () => {
		const entries = [
			{ label: "a", profile: "p1", default: true },
			{ label: "b", profile: "p2", default: true },
		];
		const result = selectRosterEntries(entries, {
			type: "choice",
			probabilities: { a: 0.9 },
		});
		expect(result.profiles).toEqual(["p1", "p2"]);
		expect(result.attention).toContain("roster");
	});
});

describe("classifier runner (artifact collection + System One request)", () => {
	test("collects planning artifacts and specs in a stable order", () => {
		const worktree = tempDir();
		const root = path.join(worktree, "openspec", "changes", "add-thing");
		fs.mkdirSync(path.join(root, "specs", "beta"), { recursive: true });
		fs.mkdirSync(path.join(root, "specs", "alpha"), { recursive: true });
		fs.writeFileSync(path.join(root, "tasks.md"), "- [ ] do it\n");
		fs.writeFileSync(path.join(root, "proposal.md"), "proposal\n");
		fs.writeFileSync(path.join(root, "specs", "beta", "spec.md"), "beta\n");
		fs.writeFileSync(path.join(root, "specs", "alpha", "spec.md"), "alpha\n");
		const artifacts = collectClassifierArtifacts(worktree, "add-thing");
		expect(artifacts.map((item) => item.path)).toEqual([
			"proposal.md",
			"tasks.md",
			path.join("specs", "alpha", "spec.md"),
			path.join("specs", "beta", "spec.md"),
		]);
		expect(collectClassifierArtifacts(worktree, "")).toEqual([]);
	});

	test("bounds artifact content to the configured cap", () => {
		const worktree = tempDir();
		const root = path.join(worktree, "openspec", "changes", "big");
		fs.mkdirSync(root, { recursive: true });
		fs.writeFileSync(
			path.join(root, "proposal.md"),
			"x".repeat(CLASSIFIER_ARTIFACT_CAP_BYTES + 1024),
		);
		const [artifact] = collectClassifierArtifacts(worktree, "big");
		expect(Buffer.byteLength(artifact?.content ?? "")).toBe(
			CLASSIFIER_ARTIFACT_CAP_BYTES,
		);
	});

	test("builds one routing request with every step question in parallel", () => {
		const specs = APPLY_PHASE_STEPS.map((stepId) => ({
			stepId,
			mode: "single" as const,
			entries: [{ label: "quick", profile: "base", default: true }],
		}));
		const request = routingRequest(specs, "opencode/jev-1.13-free", "state");
		expect(request.url).toBe("https://opencode.ai/zen/v1/systemone");
		expect(request.body.model).toBe("jev-1.13-free");
		// Exactly the apply-phase questions, one per step, in the phase order.
		expect(Object.keys(request.body.questions)).toEqual([...APPLY_PHASE_STEPS]);
		expect(request.body.questions["core.implementation"]?.criteria).toEqual({
			quick: "quick",
		});
	});

	test("passes structured criteria through unchanged", () => {
		const request = routingRequest(
			[
				{
					stepId: "core.plan",
					mode: "single",
					entries: [
						{ label: "obj", profile: "a", criteria: { what: "small" } },
						{ label: "arr", profile: "b", criteria: ["a", "b"] },
						{ label: "nil", profile: "c", criteria: null },
						{ label: "str", profile: "d", criteria: "plain" },
					],
				},
			],
			"opencode/jev-1.13-free",
			"state",
		);
		expect(request.body.questions["core.plan"]?.criteria).toEqual({
			obj: { what: "small" },
			arr: ["a", "b"],
			nil: null,
			str: "plain",
		});
	});
});

describe("routing steps and graph wiring", () => {
	test("core.route-plan enqueues one routing classify effect and advances", () => {
		const behavior = stepBehavior("core.route-plan");
		const enqueued: Array<{ kind: string; key: string; payload: unknown }> = [];
		behavior.onEnter?.({
			snapshot: {
				workflowId: "wf",
				currentStep: "core.route-plan",
				step: { attempt: 2 },
			} as never,
			enqueue: (kind, key, payload) =>
				enqueued.push({ kind, key, payload: payload as unknown }),
			hasLiveRun: () => false,
		});
		expect(enqueued).toHaveLength(1);
		expect(enqueued[0]?.kind).toBe("model.classify");
		expect(enqueued[0]?.payload).toEqual({
			integration: "routing",
			phase: "plan",
		});
		const completion = behavior.onEffectComplete?.({
			snapshot: {} as never,
			effect: {
				kind: "model.classify",
				payload: { integration: "routing", phase: "plan" },
				data: { integration: "routing", phase: "plan", answers: {} },
			},
		});
		expect(completion?.transition?.outcome).toBe("complete");
	});

	test("openspec routes plan to route-apply after approval", () => {
		const definition = registerBuiltins().definition(
			"openspec",
			definitionVersionForBehaviorPins(6),
		);
		expect(definition.initial).toBe("core.route-plan");
		expect(
			definition.edges.find(
				(edge) =>
					edge.from === "core.plan-approval" && edge.outcome === "approve",
			)?.to,
		).toBe("core.route-apply");
		expect(
			definition.edges.find(
				(edge) =>
					edge.from === "core.route-apply" && edge.outcome === "complete",
			)?.to,
		).toBe("core.implementation");
	});
});

describe("applyClassifierRouting (reducer)", () => {
	test("replaces every route of a selected step and records no attention", () => {
		const repo = tempDir();
		const configPath = writeAgentsConfig(repo);
		const previous = process.env.HERDR_WORKFLOW_CONFIG;
		process.env.HERDR_WORKFLOW_CONFIG = configPath;
		try {
			const registry = registerBuiltins();
			const definition = registry.definition(
				"openspec",
				definitionVersionForBehaviorPins(6),
			);
			const snapshot = {
				workflowId: "wf",
				revision: 1,
				currentStep: "core.route-apply",
				definition: {
					id: "openspec",
					version: definition.version,
					digest: definition.digest,
				},
				status: "active",
				step: {
					attempt: 1,
					activeRunIds: [],
					completedRunIds: [],
					selectedRoles: [],
					testRunStarted: false,
					results: [],
				},
				metadata: {
					repository: "",
					worktree: repo,
					changeId: "",
					branch: "",
					baseBranch: "",
					baseCommit: "",
					createdAt: "",
					updatedAt: "",
					stepEnteredAt: "",
					selectedPreset: "auto",
				},
				routing: {
					defaultProfile: "base",
					routes: [
						{
							stepId: "core.implementation",
							role: "worker",
							profile: baseProfile("base"),
						},
						{
							stepId: "core.verification",
							role: "quality-verifier",
							profile: baseProfile("base"),
						},
						{
							stepId: "core.verification",
							role: "security-verifier",
							profile: baseProfile("base"),
						},
					],
				},
				evidence: [],
				loopCounts: {},
				attention: [],
				developerDialogue: [],
			} as unknown as WorkflowSnapshot;
			applyClassifierRouting(snapshot, definition, registry, {
				integration: "routing",
				phase: "apply",
				answers: {
					"core.implementation": {
						type: "choice",
						choice: "thorough",
						confidence: 0.9,
					},
					"core.verification": {
						type: "choice",
						choice: "quick",
						confidence: 0.9,
					},
					"core.triage": {
						type: "choice",
						choice: "quick",
						confidence: 0.9,
					},
					"core.wiki": {
						type: "choice",
						choice: "quick",
						confidence: 0.9,
					},
					"core.archive": {
						type: "choice",
						choice: "quick",
						confidence: 0.9,
					},
				},
			});
			expect(snapshot.attention).toEqual([]);
			expect(
				snapshot.routing.routes
					.filter((route) => route.stepId === "core.implementation")
					.map((route) => route.profile.name),
			).toEqual(["strong"]);
			expect(
				snapshot.routing.routes
					.filter((route) => route.stepId === "core.verification")
					.map((route) => route.profile.name),
			).toEqual(["base", "base"]);
		} finally {
			if (previous === undefined) delete process.env.HERDR_WORKFLOW_CONFIG;
			else process.env.HERDR_WORKFLOW_CONFIG = previous;
		}
	});

	test("keeps the tagged default and records attention on low confidence", () => {
		const repo = tempDir();
		const configPath = writeAgentsConfig(repo);
		const previous = process.env.HERDR_WORKFLOW_CONFIG;
		process.env.HERDR_WORKFLOW_CONFIG = configPath;
		try {
			const registry = registerBuiltins();
			const definition = registry.definition(
				"openspec",
				definitionVersionForBehaviorPins(6),
			);
			const snapshot = {
				workflowId: "wf",
				revision: 1,
				currentStep: "core.route-apply",
				definition: {
					id: "openspec",
					version: definition.version,
					digest: definition.digest,
				},
				status: "active",
				step: {
					attempt: 1,
					activeRunIds: [],
					completedRunIds: [],
					selectedRoles: [],
					testRunStarted: false,
					results: [],
				},
				metadata: {
					repository: "",
					worktree: repo,
					changeId: "",
					branch: "",
					baseBranch: "",
					baseCommit: "",
					createdAt: "",
					updatedAt: "",
					stepEnteredAt: "",
					selectedPreset: "auto",
				},
				routing: {
					defaultProfile: "base",
					routes: [
						{
							stepId: "core.implementation",
							role: "worker",
							profile: baseProfile("base"),
						},
					],
				},
				evidence: [],
				loopCounts: {},
				attention: [],
				developerDialogue: [],
			} as unknown as WorkflowSnapshot;
			applyClassifierRouting(snapshot, definition, registry, {
				integration: "routing",
				phase: "apply",
				answers: {
					"core.implementation": {
						type: "choice",
						choice: "quick",
						confidence: 0.2,
					},
				},
			});
			expect(
				snapshot.routing.routes.find(
					(route) => route.stepId === "core.implementation",
				)?.profile.name,
			).toBe("strong");
			expect(snapshot.attention.length).toBeGreaterThan(0);
		} finally {
			if (previous === undefined) delete process.env.HERDR_WORKFLOW_CONFIG;
			else process.env.HERDR_WORKFLOW_CONFIG = previous;
		}
	});

	test("a later apply pass preserves the plan pass's classification", () => {
		const repo = tempDir();
		const configPath = writeAgentsConfig(repo);
		const previous = process.env.HERDR_WORKFLOW_CONFIG;
		process.env.HERDR_WORKFLOW_CONFIG = configPath;
		try {
			const registry = registerBuiltins();
			const definition = registry.definition(
				"openspec",
				definitionVersionForBehaviorPins(6),
			);
			const snapshot = {
				workflowId: "wf",
				revision: 1,
				currentStep: "core.route-apply",
				definition: {
					id: "openspec",
					version: definition.version,
					digest: definition.digest,
				},
				status: "active",
				step: {
					attempt: 1,
					activeRunIds: [],
					completedRunIds: [],
					selectedRoles: [],
					testRunStarted: false,
					results: [],
				},
				metadata: {
					repository: "",
					worktree: repo,
					changeId: "",
					branch: "",
					baseBranch: "",
					baseCommit: "",
					createdAt: "",
					updatedAt: "",
					stepEnteredAt: "",
					selectedPreset: "auto",
				},
				routing: {
					defaultProfile: "base",
					routes: [
						{
							stepId: "core.plan",
							role: "planner",
							profile: baseProfile("base"),
						},
						{
							stepId: "core.implementation",
							role: "worker",
							profile: baseProfile("base"),
						},
						{
							stepId: "core.triage",
							role: "triage",
							profile: baseProfile("base"),
						},
						{
							stepId: "core.verification",
							role: "quality-verifier",
							profile: baseProfile("base"),
						},
					],
				},
				evidence: [],
				loopCounts: {},
				attention: [],
				developerDialogue: [],
			} as unknown as WorkflowSnapshot;
			// Plan pass selects the non-default `quick` entry (pool default is
			// `thorough`).
			applyClassifierRouting(snapshot, definition, registry, {
				integration: "routing",
				phase: "plan",
				answers: {
					"core.plan": { type: "choice", choice: "quick", confidence: 0.9 },
				},
			});
			expect(
				snapshot.routing.routes.find((route) => route.stepId === "core.plan")
					?.profile.name,
			).toBe("base");
			applyClassifierRouting(snapshot, definition, registry, {
				integration: "routing",
				phase: "apply",
				answers: {
					"core.implementation": {
						type: "choice",
						choice: "thorough",
						confidence: 0.9,
					},
					"core.triage": { type: "choice", choice: "quick", confidence: 0.9 },
					"core.verification": {
						type: "choice",
						choice: "quick",
						confidence: 0.9,
					},
					"core.wiki": { type: "choice", choice: "quick", confidence: 0.9 },
					"core.archive": { type: "choice", choice: "quick", confidence: 0.9 },
				},
			});
			// A rebuild-from-defaults regression would reset core.plan to `strong`.
			expect(
				snapshot.routing.routes.find((route) => route.stepId === "core.plan")
					?.profile.name,
			).toBe("base");
		} finally {
			if (previous === undefined) delete process.env.HERDR_WORKFLOW_CONFIG;
			else process.env.HERDR_WORKFLOW_CONFIG = previous;
		}
	});
});

describe("preset pool parsing", () => {
	test("resolvePreset exposes pools", () => {
		const config = parseAgentsConfig({
			profiles: {
				quick: { runtime: "pi" },
				strong: { runtime: "pi" },
			},
			presets: {
				auto: {
					pools: {
						"core.implementation": [
							{ label: "quick", profile: "quick" },
							{ label: "thorough", profile: "strong", default: true },
						],
					},
				},
			},
		});
		const preset = resolvePreset(config, "auto");
		expect(preset.pools?.["core.implementation"]?.length).toBe(2);
	});

	test("rejects a preset with no pools", () => {
		expect(() =>
			parseAgentsConfig({
				profiles: { quick: { runtime: "pi" } },
				presets: { auto: { default_profile: "quick" } },
			}),
		).toThrow("at least one model pool");
	});
});

// Keep APPLY_PHASE_STEPS referenced so the apply pass ordering is asserted.
test("apply phase asks implementation/triage/verification/wiki/archive", () => {
	expect(APPLY_PHASE_STEPS).toEqual([
		"core.implementation",
		"core.triage",
		"core.verification",
		"core.wiki",
		"core.archive",
	]);
});

test("every classifiable step declares its mode and matches POOL_STEPS", () => {
	for (const [stepId, mode] of Object.entries(POOL_STEPS))
		expect(stepBehavior(stepId).classification).toBe(mode);
	// Converse: no step may declare a classification outside the coverage/editor
	// table, or coverage and the editor would silently diverge from routing.
	for (const [stepId, behavior] of Object.entries(STEP_BEHAVIORS)) {
		if (behavior.classification === undefined) continue;
		expect(POOL_STEPS[stepId]).toBe(behavior.classification);
	}
	expect(stepBehavior("fusion.plan").classification).toBe("roster");
	expect(stepBehavior("core.route-plan").classification).toBeUndefined();
});

function fusionSnapshot(repo: string): WorkflowSnapshot {
	return {
		workflowId: "wf",
		revision: 1,
		currentStep: "core.route-plan",
		definition: { id: "openspec-fusion", version: 1, digest: "d" },
		status: "active",
		step: {
			attempt: 1,
			activeRunIds: [],
			completedRunIds: [],
			selectedRoles: [],
			testRunStarted: false,
			results: [],
		},
		metadata: {
			repository: "",
			worktree: repo,
			changeId: "",
			branch: "",
			baseBranch: "",
			baseCommit: "",
			createdAt: "",
			updatedAt: "",
			stepEnteredAt: "",
			selectedPreset: "auto",
		},
		routing: {
			defaultProfile: "base",
			routes: [
				{
					stepId: "fusion.plan",
					role: "planner-1",
					profile: baseProfile("base"),
				},
				{
					stepId: "fusion.plan",
					role: "planner-2",
					profile: baseProfile("base"),
				},
				{
					stepId: "fusion.consolidate",
					role: "consolidator",
					profile: baseProfile("base"),
				},
				{
					stepId: "core.implementation",
					role: "worker",
					profile: baseProfile("base"),
				},
				{
					stepId: "core.triage",
					role: "triage",
					profile: baseProfile("base"),
				},
				{
					stepId: "core.verification",
					role: "quality-verifier",
					profile: baseProfile("base"),
				},
			],
		},
		evidence: [],
		loopCounts: {},
		attention: [],
		developerDialogue: [],
	} as unknown as WorkflowSnapshot;
}

describe("fusion roster routing (reducer)", () => {
	const fusionAnswers = (probabilities: Record<string, number>) => ({
		"fusion.consolidate": { type: "choice", choice: "quick", confidence: 0.9 },
		"fusion.plan": { type: "choice", probabilities },
	});

	test("recomputes planner roles and profiles from the roster probabilities", () => {
		const repo = tempDir();
		// The core.implementation pool default is `strong`, so a rebuild-from-defaults
		// regression would overwrite the pinned `base` route.
		const configPath = writeAgentsConfig(repo, {
			...POOLS,
			"core.implementation": [
				{ label: "quick", profile: "base" },
				{ label: "thorough", profile: "strong", default: true },
			],
		});
		const previous = process.env.HERDR_WORKFLOW_CONFIG;
		process.env.HERDR_WORKFLOW_CONFIG = configPath;
		try {
			const registry = registerBuiltins();
			const definition = registry.definition(
				"openspec-fusion",
				definitionVersionForBehaviorPins(6),
			);
			const snapshot = fusionSnapshot(repo);
			applyClassifierRouting(snapshot, definition, registry, {
				integration: "routing",
				phase: "plan",
				answers: fusionAnswers({ strong: 0.9, balanced: 0.8 }),
			});
			expect(snapshot.attention).toEqual([]);
			expect(
				snapshot.routing.routes
					.filter((route) => route.stepId === "fusion.plan")
					.map((route) => [route.role, route.profile.name]),
			).toEqual([
				["planner-1", "strong"],
				["planner-2", "base"],
			]);
			// The plan pass only replaces its own steps: earlier-pinned routes stay.
			expect(
				snapshot.routing.routes.find(
					(route) => route.stepId === "core.implementation",
				)?.profile.name,
			).toBe("base");
			expect(
				snapshot.routing.routes.find(
					(route) => route.stepId === "core.verification",
				)?.profile.name,
			).toBe("base");
		} finally {
			if (previous === undefined) delete process.env.HERDR_WORKFLOW_CONFIG;
			else process.env.HERDR_WORKFLOW_CONFIG = previous;
		}
	});

	test("collapses a thin roster to the tagged defaults and records attention", () => {
		const repo = tempDir();
		const configPath = writeAgentsConfig(repo);
		const previous = process.env.HERDR_WORKFLOW_CONFIG;
		process.env.HERDR_WORKFLOW_CONFIG = configPath;
		try {
			const registry = registerBuiltins();
			const definition = registry.definition(
				"openspec-fusion",
				definitionVersionForBehaviorPins(6),
			);
			const snapshot = fusionSnapshot(repo);
			applyClassifierRouting(snapshot, definition, registry, {
				integration: "routing",
				phase: "plan",
				answers: fusionAnswers({ strong: 0.9 }),
			});
			expect(
				snapshot.routing.routes
					.filter((route) => route.stepId === "fusion.plan")
					.map((route) => route.profile.name),
			).toEqual(["strong", "base"]);
			expect(snapshot.attention.some((item) => item.includes("roster"))).toBe(
				true,
			);
		} finally {
			if (previous === undefined) delete process.env.HERDR_WORKFLOW_CONFIG;
			else process.env.HERDR_WORKFLOW_CONFIG = previous;
		}
	});
});
