import { describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { parseFusionProfiles } from "../src/workflow/cli.ts";
import type {
	ResolvedProfile,
	WorkflowRouting,
	WorkflowView,
} from "../src/workflow/contracts.ts";
import { registerBuiltins } from "../src/workflow/definitions.ts";
import { effectRunnerTest } from "../src/workflow/effect-runner.ts";
import { AGENT_DEFINITIONS } from "../src/workflow/embedded.generated.ts";
import { canonicalStorePath, WorkflowEngine } from "../src/workflow/runtime.ts";

function requireDefined<T>(value: T | null | undefined, what: string): T {
	if (value === undefined || value === null)
		throw new Error(`expected ${what} to exist`);
	return value;
}

function repository(root: string): string {
	fs.mkdirSync(root, { recursive: true });
	execFileSync("git", ["init", "-q", "-b", "main"], { cwd: root });
	execFileSync("git", ["config", "user.email", "test@example.com"], {
		cwd: root,
	});
	execFileSync("git", ["config", "user.name", "Test"], { cwd: root });
	fs.writeFileSync(path.join(root, "README.md"), "test\n");
	fs.mkdirSync(path.join(root, "openspec"));
	fs.writeFileSync(
		path.join(root, "openspec", "config.yaml"),
		"schema: spec-driven\n",
	);
	execFileSync("git", ["add", "."], { cwd: root });
	execFileSync("git", ["commit", "-qm", "base"], { cwd: root });
	return root;
}
const tailProfile = (): ResolvedProfile => ({
	name: "tail",
	runtime: "pi",
	executable: process.execPath,
	tools: [],
	extensions: [],
	readOnly: false,
	capabilities: ["prompt", "run-environment", "observe"],
	digest: "tail",
});
const plannerProfile = (index: number): ResolvedProfile => ({
	name: `planner-model-${index}`,
	runtime: "pi",
	executable: process.execPath,
	tools: [],
	extensions: [],
	readOnly: false,
	capabilities: ["prompt", "run-environment", "observe"],
	digest: `planner-model-${index}`,
});
function fusionRouting(n: number): WorkflowRouting {
	return {
		defaultProfile: "tail",
		routes: [
			...Array.from({ length: n }, (_, index) => ({
				stepId: "fusion.plan",
				role: `planner-${index + 1}`,
				profile: plannerProfile(index + 1),
			})),
			{ stepId: "fusion.consolidate", profile: tailProfile() },
			...["core.implementation", "core.triage", "core.verification"].map(
				(stepId) => ({ stepId, profile: tailProfile() }),
			),
			{ stepId: "core.archive", profile: tailProfile() },
		],
	};
}
function draft(
	overrides: Record<string, unknown> = {},
): Record<string, unknown> {
	return {
		approach: "add a module behind the existing registry seam",
		files: [{ path: "src/thing.ts", change: "create the module" }],
		risks: [{ detail: "may regress pinning" }],
		questions: [{ detail: "which version pin?" }],
		...overrides,
	};
}
function start(
	engine: WorkflowEngine,
	repo: string,
	changeId: string,
	n: number,
): WorkflowView {
	return engine.start({
		repo,
		changeId,
		definitionId: "openspec-fusion-full",
		metadata: {
			branch: "main",
			baseBranch: "main",
			baseCommit: "base",
			task: "build the thing",
		},
		routing: fusionRouting(n),
	}).view;
}
function tokenCache(engine: WorkflowEngine, repo: string) {
	const tokens = new Map<string, string>();
	return () => {
		for (const effect of engine.claimEffects(repo, 100))
			if (effect.kind === "agent.launch" && effect.runToken)
				tokens.set(
					String((effect.payload as { runId?: string }).runId),
					effect.runToken,
				);
		return tokens;
	};
}
/** Builds a complete handoff command for the given role's active run. */
function handoffCommand(
	engine: WorkflowEngine,
	repo: string,
	view: WorkflowView,
	role: string,
	payload: Record<string, unknown>,
	cache: ReturnType<typeof tokenCache>,
): Extract<
	import("../src/workflow/contracts.ts").WorkflowCommand,
	{ type: "agent.handoff" }
> {
	const summary = requireDefined(
		view.runs.find(
			(run) => run.role === role && ["pending", "working"].includes(run.status),
		),
		`${role} run`,
	);
	const run = engine.getRun(repo, summary.id);
	const token = requireDefined(
		cache().get(run.id),
		`launch token for ${run.id}`,
	);
	fs.mkdirSync(path.dirname(requireDefined(run.outputPath, "output path")), {
		recursive: true,
	});
	fs.writeFileSync(
		requireDefined(run.outputPath, "output path"),
		JSON.stringify({
			runId: run.id,
			schemaId: run.outputSchema?.id,
			schemaVersion: run.outputSchema?.version,
			payload,
		}),
	);
	return {
		type: "agent.handoff",
		runId: run.id,
		generation: run.generation,
		token,
		outcome: "complete",
		artifact: requireDefined(run.outputPath, "output path"),
	};
}
function handoff(
	engine: WorkflowEngine,
	repo: string,
	view: WorkflowView,
	role: string,
	payload: Record<string, unknown>,
	cache: ReturnType<typeof tokenCache>,
): WorkflowView {
	return engine.dispatch(
		repo,
		handoffCommand(engine, repo, view, role, payload, cache),
	).view;
}
function seedChangeArtifacts(repo: string, changeId: string): void {
	const change = path.join(repo, "openspec", "changes", changeId);
	fs.mkdirSync(path.join(change, "specs", "feature"), { recursive: true });
	for (const file of ["proposal.md", "design.md", "tasks.md"])
		fs.writeFileSync(path.join(change, file), "- [x] task\n");
	fs.writeFileSync(
		path.join(change, "specs", "feature", "spec.md"),
		"#### Scenario: works\n",
	);
}

describe("openspec-fusion-full workflow", () => {
	test("core.plan-draft contract rejects malformed drafts without consuming the capability", () => {
		const tmp = fs.mkdtempSync(
			path.join(os.tmpdir(), "openspec-fusion-full-draft-"),
		);
		try {
			const repo = repository(path.join(tmp, "repo"));
			const engine = new WorkflowEngine(registerBuiltins());
			let view = start(engine, repo, "drafts", 3);
			expect(view.currentStep.id).toBe("fusion.plan");
			expect(
				view.runs
					.filter((run) => run.stepId === "fusion.plan")
					.map((run) => run.role),
			).toEqual(["planner-1", "planner-2", "planner-3"]);
			const cache = tokenCache(engine, repo);
			// Invalid drafts are rejected without consuming the run capability:
			// the same cached token completes the run on retry.
			for (const [role, payload] of [
				["planner-1", draft({ risks: "none" })],
				["planner-1", draft({ files: [] })],
				["planner-2", draft({ files: [{ path: "/etc/passwd", change: "x" }] })],
				[
					"planner-2",
					draft({ files: [{ path: "../escape.ts", change: "x" }] }),
				],
				["planner-3", draft({ approach: "x".repeat(8193) })],
			] as Array<[string, Record<string, unknown>]>)
				expect(() =>
					engine.dispatch(
						repo,
						handoffCommand(engine, repo, view, role, payload, cache),
					),
				).toThrow(/expected/);
			// Valid drafts complete in interleaved order and trigger consolidation.
			view = handoff(engine, repo, view, "planner-3", draft(), cache);
			view = handoff(engine, repo, view, "planner-1", draft(), cache);
			view = handoff(engine, repo, view, "planner-2", draft(), cache);
			expect(view.currentStep.id).toBe("fusion.consolidate");
			const snapshot = engine.getSnapshot(repo, view.workflowId);
			const drafts = (
				snapshot.step.context as {
					drafts: Array<{ role: string; digest: string }>;
				}
			).drafts;
			expect(drafts.map((item) => item.role)).toEqual([
				"planner-1",
				"planner-2",
				"planner-3",
			]);
		} finally {
			fs.rmSync(tmp, { recursive: true, force: true });
		}
	});
	test("out-of-range counts and duplicate profiles are rejected before any launch", () => {
		const tmp = fs.mkdtempSync(
			path.join(os.tmpdir(), "openspec-fusion-full-bounds-"),
		);
		try {
			const repo = repository(path.join(tmp, "repo"));
			const engine = new WorkflowEngine(registerBuiltins());
			const routingWith = (
				roles: Array<{ role?: string; digest: string }>,
			): WorkflowRouting => ({
				defaultProfile: "tail",
				routes: [
					...roles.map((entry, index) => ({
						stepId: "fusion.plan",
						...(entry.role ? { role: entry.role } : {}),
						profile: { ...plannerProfile(index + 1), digest: entry.digest },
					})),
					{ stepId: "fusion.consolidate", profile: tailProfile() },
					...["core.implementation", "core.triage", "core.verification"].map(
						(stepId) => ({ stepId, profile: tailProfile() }),
					),
					{ stepId: "core.archive", profile: tailProfile() },
				],
			});
			for (const bad of [
				routingWith([{ role: "planner-1", digest: "d1" }]),
				routingWith([
					{ role: "planner-1", digest: "d1" },
					{ role: "planner-3", digest: "d2" },
				]),
				routingWith([
					{ role: "planner-1", digest: "d1" },
					{ role: "planner-1", digest: "d2" },
					{ role: "planner-2", digest: "d3" },
				]),
				routingWith([
					{ role: "planner-1", digest: "same" },
					{ role: "planner-2", digest: "same" },
				]),
			])
				expect(() =>
					engine.start({
						repo,
						changeId: "bounds",
						definitionId: "openspec-fusion-full",
						metadata: {
							branch: "main",
							baseBranch: "main",
							baseCommit: "base",
							task: "task",
						},
						routing: bad,
					}),
				).toThrow(/openspec-fusion-full requires/);
			expect(fs.existsSync(canonicalStorePath(repo))).toBe(false);
		} finally {
			fs.rmSync(tmp, { recursive: true, force: true });
		}
	});
	test("fan-out assignments are byte-identical across planners except the role field", () => {
		const tmp = fs.mkdtempSync(
			path.join(os.tmpdir(), "openspec-fusion-full-render-"),
		);
		try {
			const repo = repository(path.join(tmp, "repo"));
			const registry = registerBuiltins();
			const engine = new WorkflowEngine(registry);
			const view = start(engine, repo, "render", 3);
			const plannerRuns = view.runs.filter((run) =>
				run.role.startsWith("planner-"),
			);
			const rendered = plannerRuns.map(
				(run) =>
					effectRunnerTest.renderedAssignment(
						engine,
						repo,
						registry,
						run.id,
						"",
					).rendered.prompt,
			);
			expect(rendered.length).toBe(3);
			const normalize = (prompt: string, runId: string) =>
				prompt
					.split("\n")
					.filter((line) => !/^(Run|Role|Path): /.test(line))
					.join("\n")
					.replaceAll(runId, "<run>");
			for (const index of [1, 2])
				expect(normalize(rendered[index], plannerRuns[index].id)).toBe(
					normalize(rendered[0], plannerRuns[0].id),
				);
			// Shared prompt-engineering asset renders after the pinned protocol.
			expect(rendered[0].indexOf("# Managed workflow protocol")).toBeLessThan(
				rendered[0].indexOf("# Fusion planning"),
			);
			expect(rendered[0]).toContain("core.plan-draft@1");
			expect(rendered[0]).toContain("focused, change-relevant checks");
			expect(rendered[0]).toContain("complete repository test suite");
			expect(rendered[0]).toContain("workflow-owned `test-verifier`");
			expect(rendered[0]).toContain("Do not require the worker");
		} finally {
			fs.rmSync(tmp, { recursive: true, force: true });
		}
	});
	test("failed planner retries only missing roles while preserving surviving drafts", () => {
		const tmp = fs.mkdtempSync(
			path.join(os.tmpdir(), "openspec-fusion-full-retry-"),
		);
		try {
			const repo = repository(path.join(tmp, "repo"));
			const engine = new WorkflowEngine(registerBuiltins());
			let view = start(engine, repo, "retry", 3);
			const cache = tokenCache(engine, repo);
			view = handoff(engine, repo, view, "planner-2", draft(), cache);
			const survivingDraft = engine.getRun(
				repo,
				requireDefined(
					view.runs.find((run) => run.role === "planner-2"),
					"planner-2",
				).id,
			).outputDigest;
			// planner-1 fails; the step loops back and relaunches only roles that
			// have not yet handed off a validated draft.
			const failed = requireDefined(
				view.runs.find((run) => run.role === "planner-1"),
				"planner-1",
			);
			engine.dispatch(repo, {
				type: "agent.handoff",
				runId: failed.id,
				generation: engine.getRun(repo, failed.id).generation,
				token: requireDefined(cache().get(failed.id), "failed run token"),
				outcome: "failed",
				message: "model unavailable",
			});
			view = engine.status(repo, "retry");
			expect(view.currentStep.id).toBe("fusion.plan");
			const activeRoles = view.runs
				.filter(
					(run) =>
						run.stepId === "fusion.plan" &&
						["pending", "working"].includes(run.status),
				)
				.map((run) => run.role)
				.sort();
			expect(activeRoles).toEqual(["planner-1", "planner-3"]);
			expect(view.runs.find((run) => run.role === "planner-2")?.status).toBe(
				"completed",
			);
			expect(
				engine.getRun(
					repo,
					requireDefined(
						view.runs.find((run) => run.role === "planner-2"),
						"p2",
					).id,
				).outputDigest,
			).toBe(survivingDraft);
			view = handoff(engine, repo, view, "planner-3", draft(), cache);
			view = handoff(engine, repo, view, "planner-1", draft(), cache);
			expect(view.currentStep.id).toBe("fusion.consolidate");
			const drafts = (
				engine.getSnapshot(repo, view.workflowId).step.context as {
					drafts: Array<{ role: string }>;
				}
			).drafts;
			expect(drafts.map((item) => item.role)).toEqual([
				"planner-1",
				"planner-2",
				"planner-3",
			]);
		} finally {
			fs.rmSync(tmp, { recursive: true, force: true });
		}
	});
	test("consolidation inputs list every validated draft for N=2 and N=5", () => {
		const tmp = fs.mkdtempSync(
			path.join(os.tmpdir(), "openspec-fusion-full-inputs-"),
		);
		try {
			const registry = registerBuiltins();
			for (const n of [2, 5]) {
				const iterationRepo = repository(path.join(tmp, `repo-${n}`));
				const engine = new WorkflowEngine(registry);
				const cache = tokenCache(engine, iterationRepo);
				let view = start(engine, iterationRepo, `inputs-${n}`, n);
				for (let index = n; index >= 1; index--)
					view = handoff(
						engine,
						iterationRepo,
						view,
						`planner-${index}`,
						draft(),
						cache,
					);
				expect(view.currentStep.id).toBe("fusion.consolidate");
				const consolidator = requireDefined(
					view.runs.find((run) => run.stepId === "fusion.consolidate"),
					"consolidator run",
				);
				const prompt = effectRunnerTest.renderedAssignment(
					engine,
					iterationRepo,
					registry,
					consolidator.id,
					"",
				).rendered.prompt;
				const inputs = prompt.slice(
					prompt.indexOf("## Inputs"),
					prompt.indexOf("## Permissions"),
				);
				let position = -1;
				for (let index = 1; index <= n; index++) {
					const found = inputs.indexOf(`planner-${index}`);
					expect(found).toBeGreaterThan(position);
					position = found;
				}
				for (const digest of (
					engine.getSnapshot(iterationRepo, view.workflowId).step.context as {
						drafts: Array<{ digest: string }>;
					}
				).drafts)
					expect(inputs).toContain(digest.digest);
				expect(prompt).toContain("# Plan fusion");
				expect(prompt).toContain("focused, change-relevant checks");
				expect(prompt).toContain("complete repository test suite");
				expect(prompt).toContain("workflow-owned `test-verifier`");
				expect(prompt).toContain("Do not require the worker");
			}
		} finally {
			fs.rmSync(tmp, { recursive: true, force: true });
		}
	});
	test("openspec-fusion-full reaches terminal through registered commands with one retry", () => {
		const tmp = fs.mkdtempSync(
			path.join(os.tmpdir(), "openspec-fusion-full-e2e-"),
		);
		try {
			const repo = repository(path.join(tmp, "repo"));
			const engine = new WorkflowEngine(registerBuiltins());
			let view = start(engine, repo, "fusion-e2e", 3);
			const cache = tokenCache(engine, repo);
			const visited = [view.currentStep.id];
			view = handoff(engine, repo, view, "planner-2", draft(), cache);
			const failed = requireDefined(
				view.runs.find((run) => run.role === "planner-1"),
				"planner-1",
			);
			engine.dispatch(repo, {
				type: "agent.handoff",
				runId: failed.id,
				generation: engine.getRun(repo, failed.id).generation,
				token: requireDefined(cache().get(failed.id), "failed run token"),
				outcome: "failed",
				message: "rate limited",
			});
			view = engine.status(repo, "fusion-e2e");
			view = handoff(engine, repo, view, "planner-3", draft(), cache);
			view = handoff(engine, repo, view, "planner-1", draft(), cache);
			expect(view.currentStep.id).toBe("fusion.consolidate");
			visited.push("fusion.consolidate");
			seedChangeArtifacts(repo, "fusion-e2e");
			view = handoff(
				engine,
				repo,
				view,
				"consolidator",
				{
					consolidated: true,
				},
				cache,
			);
			expect(view.currentStep.id).toBe("fusion.consolidate");
			const validation = requireDefined(
				engine
					.claimEffects(repo, 100)
					.find((effect) => effect.kind === "openspec.validate"),
				"openspec.validate effect",
			);
			view = engine.dispatch(repo, {
				type: "effect.result",
				effectId: validation.id,
				lease: requireDefined(validation.lease, "effect lease"),
				outcome: "complete",
			}).view;
			expect(view.currentStep.id).toBe("core.plan-approval");
			visited.push(view.currentStep.id);
			view = engine.dispatch(repo, {
				type: "developer.action",
				workflowId: view.workflowId,
				revision: view.revision,
				actionId: "approve-plan",
			}).view;
			visited.push(view.currentStep.id);
			fs.writeFileSync(path.join(repo, "impl.txt"), "changed\n");
			view = handoff(engine, repo, view, "worker", { changed: true }, cache);
			visited.push(view.currentStep.id);
			view = handoff(
				engine,
				repo,
				view,
				"triage",
				{
					roles: [
						{
							role: "quality-verifier",
							reason: "code changed",
							files: ["impl.txt"],
						},
					],
				},
				cache,
			);
			visited.push(view.currentStep.id);
			view = handoff(
				engine,
				repo,
				view,
				"quality-verifier",
				{
					findings: [],
				},
				cache,
			);
			view = handoff(
				engine,
				repo,
				view,
				"test-verifier",
				{ findings: [] },
				cache,
			);
			visited.push(view.currentStep.id);
			view = engine.dispatch(repo, {
				type: "developer.action",
				workflowId: view.workflowId,
				revision: view.revision,
				actionId: "approve-review",
			}).view;
			visited.push(view.currentStep.id);
			const active = path.join(repo, "openspec", "changes", "fusion-e2e");
			const archived = path.join(
				repo,
				"openspec",
				"changes",
				"archive",
				"fusion-e2e",
			);
			fs.mkdirSync(path.dirname(archived), { recursive: true });
			fs.renameSync(active, archived);
			view = handoff(engine, repo, view, "archive", { archived: true }, cache);
			visited.push(view.currentStep.id);
			for (const kind of ["delivery.commit", "delivery.push"]) {
				const effect = requireDefined(
					engine.claimEffects(repo, 100).find((item) => item.kind === kind),
					kind,
				);
				view = engine.dispatch(repo, {
					type: "effect.result",
					effectId: effect.id,
					lease: requireDefined(effect.lease, "effect lease"),
					outcome: "complete",
				}).view;
			}
			visited.push(view.currentStep.id);
			view = engine.dispatch(repo, {
				type: "developer.action",
				workflowId: view.workflowId,
				revision: view.revision,
				actionId: "close",
			}).view;
			visited.push(view.currentStep.id);
			expect(visited.at(-1)).toBe("core.closed");
			// Every transition matches the pinned definition's step order.
			const definition = registerBuiltins().definition(
				"openspec-fusion-full",
				1,
			);
			for (const step of visited) expect(definition.steps).toContain(step);
			expect(definition.initial).toBe("fusion.plan");
		} finally {
			fs.rmSync(tmp, { recursive: true, force: true });
		}
	});
	test("openspec-fusion-propose waits for approval and closes explicitly without downstream work", () => {
		const tmp = fs.mkdtempSync(
			path.join(os.tmpdir(), "openspec-fusion-propose-e2e-"),
		);
		try {
			const repo = repository(path.join(tmp, "repo"));
			const engine = new WorkflowEngine(registerBuiltins());
			let view = engine.start({
				repo,
				mode: "checkout",
				changeId: "openspec-fusion-propose",
				definitionId: "openspec-fusion-propose",
				metadata: {
					branch: "main",
					baseBranch: "main",
					baseCommit: "base",
					task: "compare plans",
				},
				routing: fusionRouting(2),
			}).view;
			const setup = requireDefined(
				engine
					.claimEffects(repo, 100)
					.find((effect) => effect.kind === "workspace.setup"),
				"workspace setup effect",
			);
			view = engine.dispatch(repo, {
				type: "effect.result",
				effectId: setup.id,
				lease: requireDefined(setup.lease, "setup lease"),
				outcome: "complete",
				data: { workspace: "workspace", worktree: repo, branch: "main" },
			}).view;
			const cache = tokenCache(engine, repo);
			view = handoff(engine, repo, view, "planner-1", draft(), cache);
			view = handoff(engine, repo, view, "planner-2", draft(), cache);
			expect(view.currentStep.id).toBe("fusion.consolidate");
			seedChangeArtifacts(repo, "openspec-fusion-propose");
			view = handoff(
				engine,
				repo,
				view,
				"consolidator",
				{ consolidated: true },
				cache,
			);
			const validation = requireDefined(
				engine
					.claimEffects(repo, 100)
					.find((effect) => effect.kind === "openspec.validate"),
				"openspec validation effect",
			);
			view = engine.dispatch(repo, {
				type: "effect.result",
				effectId: validation.id,
				lease: requireDefined(validation.lease, "validation lease"),
				outcome: "complete",
			}).view;
			expect(view.currentStep.id).toBe("core.plan-approval");
			expect(view.status).toBe("active");
			expect(view.effects.map((effect) => effect.kind)).not.toContain(
				"workspace.close",
			);
			expect(view.effects.map((effect) => effect.kind)).not.toContain(
				"workspace.cleanup",
			);
			view = engine.dispatch(repo, {
				type: "developer.action",
				workflowId: view.workflowId,
				revision: view.revision,
				actionId: "approve-plan",
			}).view;
			expect(view.currentStep.id).toBe("core.completed");
			expect(view.status).toBe("completed");
			expect(view.availableActions.map((action) => action.id)).toEqual([
				"close",
			]);
			expect(view.effects.map((effect) => effect.kind)).not.toContain(
				"delivery.commit",
			);
			expect(view.effects.map((effect) => effect.kind)).not.toContain(
				"pull-request.create",
			);
			view = engine.dispatch(repo, {
				type: "developer.action",
				workflowId: view.workflowId,
				revision: view.revision,
				actionId: "close",
			}).view;
			expect(view.currentStep.id).toBe("core.closed");
			expect(view.status).toBe("closed");
			expect(view.effects.map((effect) => effect.kind)).toContain(
				"workspace.close",
			);
		} finally {
			fs.rmSync(tmp, { recursive: true, force: true });
		}
	});
	test("existing built-in definitions keep identifiers, versions, graphs, and pins", () => {
		const registry = registerBuiltins();
		const standard = registry.definition("openspec-full", 1);
		expect(standard.steps[0]).toBe("core.plan");
		expect(
			standard.edges.find(
				(edge) =>
					edge.from === "core.plan-approval" && edge.outcome === "reject",
			)?.to,
		).toBe("core.plan");
		for (const id of ["openspec-full", "openspec-apply", "no-openspec"])
			expect(registry.definition(id, 1).version).toBe(1);
	});
	test("--fusion-profiles parses an ordered unique 2-5 profile list", () => {
		expect(parseFusionProfiles(" a , b ,c")).toEqual(["a", "b", "c"]);
		expect(parseFusionProfiles("a,b,c,d,e").length).toBe(5);
		for (const bad of [undefined, "a", "a,b,c,d,e,f", "a,b,a", " , , "])
			expect(() => parseFusionProfiles(bad)).toThrow(/fusion-profiles/);
	});
	test("embedded fusion assets match on-disk instructions and pin via rendering", () => {
		const diskRoot = path.resolve(
			import.meta.dir,
			"..",
			"..",
			"agent-definitions",
			"instructions",
		);
		for (const name of [
			"planning.md",
			"planning-fusion.md",
			"fusion-consolidation.md",
		]) {
			const embedded = AGENT_DEFINITIONS[`instructions/${name}`];
			expect(embedded).toBeTruthy();
			expect(createHash("sha256").update(embedded).digest("hex")).toBe(
				createHash("sha256")
					.update(fs.readFileSync(path.join(diskRoot, name)))
					.digest("hex"),
			);
		}
	});
});
