import { afterEach, describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Effect } from "effect";
import type {
	ResolvedProfile,
	WorkflowSnapshot,
} from "../src/contracts/workflow.ts";
import {
	CLASSIFIER_ARTIFACT_CAP_BYTES,
	classifierRequest,
	collectClassifierArtifacts,
	invokeClassifier,
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

	test("builds a direct OpenCode Zen System One request", () => {
		const request = classifierRequest(
			complexityClassifier,
			complexityClassifier.model,
			"classify this",
		);
		expect(request.url).toBe("https://opencode.ai/zen/v1/systemone");
		expect(request.body.model).toBe("jev-1.13-free");
		expect(request.body.state).toBe("classify this");
		expect(request.body.questions.complexity).toEqual({
			type: "choice",
			instructions: "Which complexity class fits this planned change?",
			criteria: {
				easy: "A tiny, low-risk change scoped to one or two files",
				medium:
					"A normal change touching a few modules with clear requirements",
				hard: "A broad or subtle change with many moving parts or integration risk",
				critical:
					"A high-risk change with architectural, migration, security, or cross-cutting consequences",
			},
		});
	});

	test("uses configured OpenCode model and config-root env-file key", async () => {
		const agents = parseAgentsConfig({
			profiles: {
				"jev-classifier": {
					runtime: "opencode",
					model: "opencode/jev-1.13-free",
				},
			},
		});
		const configDir = tempDir();
		fs.writeFileSync(
			path.join(configDir, ".env"),
			"OPENCODE_API_KEY=test-key\n",
		);
		const previousKey = process.env.OPENCODE_API_KEY;
		const previousConfigDir = process.env.AGENTIC_CODING_CONFIG_DIR;
		const previousFetch = globalThis.fetch;
		let sent: { url: string; init?: RequestInit } | undefined;
		delete process.env.OPENCODE_API_KEY;
		process.env.AGENTIC_CODING_CONFIG_DIR = configDir;
		globalThis.fetch = (async (url, init) => {
			sent = { url: String(url), init };
			return new Response(
				JSON.stringify({
					answers: {
						complexity: {
							type: "choice",
							choice: "hard",
						},
					},
				}),
				{ status: 200 },
			);
		}) as typeof fetch;
		try {
			expect(
				await Effect.runPromise(
					invokeClassifier(complexityClassifier, agents, {
						task: "task",
						changeId: "change",
						artifacts: [],
					}),
				),
			).toBe("hard");
			expect(sent?.url).toBe("https://opencode.ai/zen/v1/systemone");
			expect(sent?.init?.headers).toEqual({
				Authorization: "Bearer test-key",
				"Content-Type": "application/json",
			});
			const body = JSON.parse(String(sent?.init?.body));
			expect(body.model).toBe("jev-1.13-free");
			expect(body.questions.complexity.type).toBe("choice");
		} finally {
			globalThis.fetch = previousFetch;
			if (previousKey === undefined) delete process.env.OPENCODE_API_KEY;
			else process.env.OPENCODE_API_KEY = previousKey;
			if (previousConfigDir === undefined)
				delete process.env.AGENTIC_CODING_CONFIG_DIR;
			else process.env.AGENTIC_CODING_CONFIG_DIR = previousConfigDir;
		}
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
