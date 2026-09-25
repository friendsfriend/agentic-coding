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
	classifierCommand,
	collectClassifierArtifacts,
} from "../src/workflow/classifier-runner.ts";
import {
	CLASSIFIER_INTEGRATIONS,
	classifierFor,
	complexityClassifier,
	parseCategoryAnswer,
	renderClassifierPrompt,
} from "../src/workflow/classifiers.ts";
import {
	definitionVersionForBehaviorPins,
	registerBuiltins,
} from "../src/workflow/definitions.ts";
import {
	type AgentsConfig,
	categoryProfile,
	parseAgentsConfig,
	resolvePreset,
	resolveRouting,
	rolesByStepFromRouting,
} from "../src/workflow/profiles.ts";
import { applyClassifierRouting } from "../src/workflow/runtime/reducers/effect-result.ts";
import { stepBehavior } from "../src/workflow/steps/index.ts";

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

describe("classifier integrations (domain)", () => {
	test("registers the complexity integration as the only builtin", () => {
		expect(CLASSIFIER_INTEGRATIONS.map((item) => item.id)).toEqual([
			"complexity",
		]);
		expect(classifierFor("complexity")).toBe(complexityClassifier);
		expect(() => classifierFor("missing")).toThrow(
			"unknown classifier integration: missing",
		);
	});

	test("parses only whole-word categories and fails closed otherwise", () => {
		expect(parseCategoryAnswer(["easy", "hard"], "This is hard.")).toBe("hard");
		expect(parseCategoryAnswer(["easy", "hard"], "HARD")).toBe("hard");
		expect(() => parseCategoryAnswer(["easy", "hard"], "not sure")).toThrow(
			"did not name one of",
		);
		// "harder" must not match the "hard" category.
		expect(() => parseCategoryAnswer(["easy", "hard"], "harder")).toThrow();
	});

	test("renders the instruction, categories, task, and artifacts", () => {
		const prompt = renderClassifierPrompt(complexityClassifier, {
			task: "add a button",
			changeId: "add-button",
			artifacts: [{ path: "proposal.md", content: "why we do this" }],
		});
		expect(prompt).toContain("easy, medium, hard, critical");
		expect(prompt).toContain("add-button");
		expect(prompt).toContain("add a button");
		expect(prompt).toContain('<artifact path="proposal.md">');
		expect(prompt).toContain("why we do this");
	});
});

describe("classifier runner (artifact collection + command)", () => {
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
		expect(collectClassifierArtifacts(worktree, "missing")).toEqual([]);
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

	test("builds a pi one-shot command with the integration default model", () => {
		const agents = { profiles: {} } as unknown as AgentsConfig;
		const command = classifierCommand(
			complexityClassifier,
			agents,
			"classify this",
			"/worktree",
		);
		expect(command.cwd).toBe("/worktree");
		expect(command.args[0]).toBe("pi");
		expect(command.args).toContain("--print");
		expect(command.args).toContain("--model");
		expect(command.args).toContain("opencode-go/jev-1.13");
		expect(command.args.at(-1)).toBe("classify this");
	});

	test("honours a configured classifier profile and runtime", () => {
		const agents = parseAgentsConfig({
			profiles: {
				"jev-classifier": {
					runtime: "pi",
					model: "opencode-go/other",
					thinking: "low",
				},
			},
		});
		const command = classifierCommand(
			complexityClassifier,
			agents,
			"prompt",
			"/worktree",
		);
		expect(command.args).toContain("opencode-go/other");
		expect(command.args).toEqual(expect.arrayContaining(["--thinking", "low"]));
	});
});

describe("preset category mapping (profiles)", () => {
	const config = parseAgentsConfig({
		profiles: {
			quick: { runtime: "pi" },
			strong: { runtime: "pi" },
		},
		presets: {
			auto: {
				default_profile: "quick",
				easy: "quick",
				medium: "quick",
				hard: "strong",
				critical: "strong",
			},
		},
	});

	test("serializes the flat category keys into the routing preset", () => {
		const preset = resolvePreset(config, "auto");
		expect(preset.easy).toBe("quick");
		expect(preset.hard).toBe("strong");
		expect(categoryProfile(preset, "critical")).toBe("strong");
		expect(categoryProfile(preset, "medium")).toBe("quick");
		expect(categoryProfile(undefined, "easy")).toBeUndefined();
	});

	test("rejects an unknown profile in a category slot", () => {
		expect(() =>
			parseAgentsConfig({
				profiles: { quick: { runtime: "pi" } },
				presets: { auto: { easy: "missing" } },
			}),
		).toThrow("unknown profile missing for category easy");
	});

	test("a category selection overrides the target route only", () => {
		const registry = registerBuiltins();
		const definition = registry.definition(
			"openspec-jev",
			definitionVersionForBehaviorPins(6),
		);
		const rolesByStep = { "core.implementation": ["worker"] };
		const base = resolveRouting(definition, rolesByStep, config);
		expect(
			base.routes.find((route) => route.stepId === "core.implementation")
				?.profile.name,
		).toBe("use-default-model");
		const selected = resolveRouting(
			definition,
			rolesByStepFromRouting(base),
			config,
			resolvePreset(config, "auto"),
			{ stepId: "core.implementation", role: "worker", profileName: "strong" },
		);
		expect(
			selected.routes.find((route) => route.stepId === "core.implementation")
				?.profile.name,
		).toBe("strong");
		// Every other pinned route is preserved.
		expect(selected.routes.length).toBe(base.routes.length);
	});
});

describe("model selection step behavior", () => {
	test("enqueues one classify effect on entry and advances on its result", () => {
		const behavior = stepBehavior("core.model-selection");
		const enqueued: Array<{ kind: string; key: string; payload: unknown }> = [];
		behavior.onEnter?.({
			snapshot: { workflowId: "wf", step: { attempt: 2 } } as never,
			enqueue: (kind, key, payload) =>
				enqueued.push({ kind, key, payload: payload as unknown }),
			hasLiveRun: () => false,
		});
		expect(enqueued).toHaveLength(1);
		expect(enqueued[0]?.kind).toBe("model.classify");
		expect(enqueued[0]?.payload).toEqual({ integration: "complexity" });

		const completion = behavior.onEffectComplete?.({
			snapshot: {} as never,
			effect: {
				kind: "model.classify",
				payload: {},
				data: { integration: "complexity", category: "hard" },
			},
		});
		expect(completion?.transition).toEqual({
			outcome: "complete",
			output: { integration: "complexity", category: "hard" },
		});
		expect(
			behavior.onEffectComplete?.({
				snapshot: {} as never,
				effect: { kind: "artifact.write", payload: {}, data: {} },
			}),
		).toBeUndefined();
	});
});

describe("openspec-jev graph wiring", () => {
	test("classifies before the worker and routes the classification result", () => {
		const definition = registerBuiltins().definition(
			"openspec-jev",
			definitionVersionForBehaviorPins(6),
		);
		expect(definition.steps).toContain("core.model-selection");
		expect(
			definition.edges.find(
				(edge) =>
					edge.from === "core.model-selection" && edge.outcome === "complete",
			)?.to,
		).toBe("core.implementation");
		expect(
			definition.edges.find(
				(edge) =>
					edge.from === "core.plan-approval" && edge.outcome === "approve",
			)?.to,
		).toBe("core.model-selection");
		// Reaching core.implementation from the implementation loop stays direct.
		expect(
			definition.edges.find(
				(edge) => edge.from === "core.verification" && edge.outcome === "fix",
			)?.to,
		).toBe("core.implementation");
	});

	test("rewrites the target route to the classified category profile", () => {
		const repo = tempDir();
		const configPath = path.join(repo, "config.toml");
		fs.writeFileSync(
			configPath,
			`[agents]
default_profile = "base"

[agents.profiles.base]
runtime = "pi"
executable = "/bin/true"

[agents.profiles.strong]
runtime = "pi"
executable = "/bin/true"

[agents.presets.auto]
default_profile = "base"
easy = "base"
medium = "base"
hard = "strong"
critical = "strong"
`,
		);
		const previous = process.env.HERDR_WORKFLOW_CONFIG;
		process.env.HERDR_WORKFLOW_CONFIG = configPath;
		try {
			const registry = registerBuiltins();
			const definition = registry.definition(
				"openspec-jev",
				definitionVersionForBehaviorPins(6),
			);
			const baseProfile = {
				name: "base",
				runtime: "pi",
				executable: "/bin/true",
				tools: [],
				extensions: [],
				readOnly: false,
				capabilities: ["prompt", "run-environment", "observe"],
				digest: "base",
			} as ResolvedProfile;
			const snapshot = {
				workflowId: "wf",
				revision: 1,
				currentStep: "core.model-selection",
				definition: {
					id: "openspec-jev",
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
					changeId: "add-thing",
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
							profile: baseProfile,
						},
					],
				},
				evidence: [],
				loopCounts: {},
				attention: [],
				developerDialogue: [],
			} as unknown as WorkflowSnapshot;
			applyClassifierRouting(snapshot, definition, registry, {
				integration: "complexity",
				category: "hard",
			});
			expect(snapshot.attention).toEqual([]);
			expect(
				snapshot.routing.routes.find(
					(route) => route.stepId === "core.implementation",
				)?.profile.name,
			).toBe("strong");

			const fallback = structuredClone(snapshot);
			fallback.attention = [];
			applyClassifierRouting(fallback, definition, registry, {
				integration: "complexity",
				category: "impossible",
			});
			expect(fallback.routing.routes[0]?.profile.name).toBe("strong");
			expect(fallback.attention.length).toBe(1);
		} finally {
			if (previous === undefined) delete process.env.HERDR_WORKFLOW_CONFIG;
			else process.env.HERDR_WORKFLOW_CONFIG = previous;
		}
	});
});
