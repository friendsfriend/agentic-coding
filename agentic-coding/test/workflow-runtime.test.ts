import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
	commandContract,
	parseSnapshot,
	type ResolvedProfile,
	type WorkflowRouting,
} from "../src/workflow/contracts.ts";
import {
	definitionVersionForPolicy,
	registerBuiltins,
	researchHandoffContract,
} from "../src/workflow/definitions.ts";
import {
	canonicalStorePath,
	researchWorkflowTarget,
	validateChangeId,
	WorkflowEngine,
	WorkflowRuntimeError,
	wikiWorkflowDataRoot,
} from "../src/workflow/runtime.ts";
import { listConcepts } from "../src/workflow/wiki.ts";

// Replaces non-null assertions: fail loudly with a clear message instead of
// asserting away `undefined`.
function requireDefined<T>(value: T | null | undefined, what: string): T {
	if (value === undefined || value === null)
		throw new Error(`expected ${what} to exist`);
	return value;
}

function requireToken(
	launches: ReturnType<WorkflowEngine["claimEffects"]>,
	runId: string,
): string {
	const launch = launches.find(
		(effect) =>
			effect.kind === "agent.launch" &&
			(effect.payload as { runId?: string }).runId === runId,
	);
	if (!launch?.runToken) throw new Error(`expected run token for ${runId}`);
	return launch.runToken;
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
const profile: ResolvedProfile = {
	name: "test",
	runtime: "pi",
	executable: process.execPath,
	tools: ["read", "bash", "edit", "write"],
	extensions: [],
	readOnly: false,
	capabilities: ["prompt", "run-environment", "observe", "edit"],
	digest: "profile-digest",
};
function routing(): WorkflowRouting {
	return {
		defaultProfile: "test",
		routes: [
			"core.plan",
			"core.implementation",
			"core.triage",
			"core.verification",
			"core.archive",
		].map((stepId) => ({ stepId, profile })),
	};
}

describe("transactional workflow runtime", () => {
	test("research setup remains claimable after an intervening revision", () => {
		const tmp = fs.mkdtempSync(
			path.join(os.tmpdir(), "workflow-research-setup-"),
		);
		const previousWikiRoot = process.env.HERDR_WIKI_DIR;
		process.env.HERDR_WIKI_DIR = path.join(tmp, "wiki");
		try {
			let now = new Date("2026-01-01T00:00:00Z");
			const engine = new WorkflowEngine(
				registerBuiltins(undefined, 6),
				() => now,
			);
			const version = definitionVersionForPolicy(6);
			const researchProfile: ResolvedProfile = {
				...profile,
				tools: ["read"],
				capabilities: [
					"interactive",
					"prompt",
					"persistent-session",
					"run-environment",
					"observe",
					"read-only",
				],
			};
			const started = engine.start({
				repo: researchWorkflowTarget(),
				workflowId: "research-setup-retry",
				definitionId: "research",
				definitionVersion: version,
				metadata: {
					branch: "",
					baseBranch: "",
					baseCommit: "",
					task: "research",
				},
				routing: {
					defaultProfile: researchProfile.name,
					routes: [
						{
							stepId: "core.research",
							role: "researcher",
							profile: researchProfile,
						},
					],
				},
			});
			const setup = requireDefined(
				engine
					.claimEffects(researchWorkflowTarget())
					.find((effect) => effect.kind === "workspace.setup"),
				"research workspace setup effect",
			);
			engine.dispatch(researchWorkflowTarget(), {
				type: "effect.result",
				effectId: setup.id,
				lease: requireDefined(setup.lease, "setup lease"),
				outcome: "retry",
				data: "runtime temporarily unavailable",
			});
			now = new Date("2026-01-01T00:00:02Z");
			const retried = engine
				.claimEffects(researchWorkflowTarget())
				.find((effect) => effect.kind === "workspace.setup");
			expect(retried?.status).toBe("running");
			expect(
				engine.getSnapshot(
					researchWorkflowTarget(),
					started.snapshot.workflowId,
				).currentStep,
			).toBe("core.research");
		} finally {
			if (previousWikiRoot === undefined) delete process.env.HERDR_WIKI_DIR;
			else process.env.HERDR_WIKI_DIR = previousWikiRoot;
			fs.rmSync(tmp, { recursive: true, force: true });
		}
	});
	test("research accepts trusted integrations but rejects source mutations", () => {
		const tmp = fs.mkdtempSync(
			path.join(os.tmpdir(), "workflow-research-source-isolation-"),
		);
		const previousWikiRoot = process.env.HERDR_WIKI_DIR;
		process.env.HERDR_WIKI_DIR = path.join(tmp, "wiki");
		try {
			const source = repository(path.join(tmp, "source"));
			const engine = new WorkflowEngine(registerBuiltins());
			const researchProfile: ResolvedProfile = {
				...profile,
				// Even with a widened research tool surface (mutating tool names
				// present, matching an unrestricted launch), source-isolation
				// validation - not tool-name gating - must still catch a mutation.
				tools: ["read", "web_search", "bash", "edit", "write"],
				extensions: ["/tmp/research-extension.ts"],
				capabilities: [
					"interactive",
					"prompt",
					"persistent-session",
					"run-environment",
					"observe",
					"read-only",
				],
			};
			const started = engine.start({
				repo: researchWorkflowTarget(),
				repositoryContext: source,
				workflowId: "research-source-isolation",
				definitionId: "research",
				definitionVersion: definitionVersionForPolicy(6),
				metadata: {
					branch: "",
					baseBranch: "",
					baseCommit: "",
					task: "research",
				},
				routing: {
					defaultProfile: researchProfile.name,
					routes: [
						{
							stepId: "core.research",
							role: "researcher",
							profile: researchProfile,
						},
					],
				},
			});
			expect(() =>
				engine.start({
					repo: researchWorkflowTarget(),
					repositoryContext: source,
					workflowId: "research-invalid-capabilities",
					definitionId: "research",
					definitionVersion: definitionVersionForPolicy(6),
					metadata: {
						branch: "",
						baseBranch: "",
						baseCommit: "",
						task: "research",
					},
					routing: {
						defaultProfile: researchProfile.name,
						routes: [
							{
								stepId: "core.research",
								role: "researcher",
								profile: {
									...researchProfile,
									capabilities: [...researchProfile.capabilities, "shell"],
								},
							},
						],
					},
				}),
			).toThrow(/without shell or edit/);
			fs.writeFileSync(path.join(source, "README.md"), "mutated\n");
			expect(() =>
				engine.dispatch(researchWorkflowTarget(), {
					type: "developer.action",
					workflowId: started.snapshot.workflowId,
					revision: started.snapshot.revision,
					actionId: "close-research",
				}),
			).toThrow(/source repository changed/);
			expect(
				engine.getSnapshot(
					researchWorkflowTarget(),
					started.snapshot.workflowId,
				).currentStep,
			).toBe("core.research");
		} finally {
			if (previousWikiRoot === undefined) delete process.env.HERDR_WIKI_DIR;
			else process.env.HERDR_WIKI_DIR = previousWikiRoot;
			fs.rmSync(tmp, { recursive: true, force: true });
		}
	});
	test("close-research remains available for a purely conversational Q&A session with nothing to document", () => {
		const tmp = fs.mkdtempSync(
			path.join(os.tmpdir(), "workflow-research-qa-close-"),
		);
		const previousWikiRoot = process.env.HERDR_WIKI_DIR;
		process.env.HERDR_WIKI_DIR = path.join(tmp, "wiki");
		try {
			const engine = new WorkflowEngine(registerBuiltins());
			const researchProfile: ResolvedProfile = {
				...profile,
				tools: ["read"],
				capabilities: [
					"interactive",
					"prompt",
					"persistent-session",
					"run-environment",
					"observe",
					"read-only",
				],
			};
			const started = engine.start({
				repo: researchWorkflowTarget(),
				workflowId: "research-qa-close",
				definitionId: "research",
				definitionVersion: definitionVersionForPolicy(6),
				metadata: {
					branch: "",
					baseBranch: "",
					baseCommit: "",
					task: "research",
				},
				routing: {
					defaultProfile: researchProfile.name,
					routes: [
						{
							stepId: "core.research",
							role: "researcher",
							profile: researchProfile,
						},
					],
				},
			});
			const setup = requireDefined(
				engine
					.claimEffects(researchWorkflowTarget())
					.find((effect) => effect.kind === "workspace.setup"),
				"research setup",
			);
			const view = engine.dispatch(researchWorkflowTarget(), {
				type: "effect.result",
				effectId: setup.id,
				lease: requireDefined(setup.lease, "setup lease"),
				outcome: "complete",
				data: { workspace: "research-workspace" },
			}).view;
			expect(view.availableActions.map((action) => action.id)).toContain(
				"close-research",
			);
			const closed = engine.dispatch(researchWorkflowTarget(), {
				type: "developer.action",
				workflowId: started.snapshot.workflowId,
				revision: view.revision,
				actionId: "close-research",
			}).view;
			expect(closed.currentStep.id).toBe("core.closed");
		} finally {
			if (previousWikiRoot === undefined) delete process.env.HERDR_WIKI_DIR;
			else process.env.HERDR_WIKI_DIR = previousWikiRoot;
			fs.rmSync(tmp, { recursive: true, force: true });
		}
	});
	test("research hands off to wiki approval, requires approval before close, and closes only via the completed gate", () => {
		const tmp = fs.mkdtempSync(
			path.join(os.tmpdir(), "workflow-research-life-"),
		);
		const previousWikiRoot = process.env.HERDR_WIKI_DIR;
		process.env.HERDR_WIKI_DIR = path.join(tmp, "wiki");
		try {
			const engine = new WorkflowEngine(registerBuiltins());
			const researchProfile: ResolvedProfile = {
				...profile,
				tools: ["read"],
				capabilities: [
					"interactive",
					"prompt",
					"persistent-session",
					"run-environment",
					"observe",
					"read-only",
				],
			};
			const started = engine.start({
				repo: researchWorkflowTarget(),
				workflowId: "research-lifecycle",
				definitionId: "research",
				definitionVersion: definitionVersionForPolicy(6),
				metadata: {
					branch: "",
					baseBranch: "",
					baseCommit: "",
					task: "research",
				},
				routing: {
					defaultProfile: researchProfile.name,
					routes: [
						{
							stepId: "core.research",
							role: "researcher",
							profile: researchProfile,
						},
						{
							stepId: "core.wiki",
							role: "research-wiki",
							profile: researchProfile,
						},
					],
				},
			});
			const setup = requireDefined(
				engine
					.claimEffects(researchWorkflowTarget())
					.find((effect) => effect.kind === "workspace.setup"),
				"research setup",
			);
			engine.dispatch(researchWorkflowTarget(), {
				type: "effect.result",
				effectId: setup.id,
				lease: requireDefined(setup.lease, "setup lease"),
				outcome: "complete",
				data: { workspace: "research-workspace" },
			});
			let view = engine.status(researchWorkflowTarget(), "research-lifecycle");
			const researcherSummary = requireDefined(view.runs[0], "researcher run");
			const researcher = engine.getRun(
				researchWorkflowTarget(),
				researcherSummary.id,
			);
			expect(researcher.allowedOutcomes).toEqual(["blocked", "failed"]);
			// There is no developer dashboard trigger for wiki drafting: the
			// action is not offered, and dispatching it is rejected outright.
			expect(view.availableActions.map((action) => action.id)).not.toContain(
				"request-research-wiki",
			);
			expect(() =>
				engine.dispatch(researchWorkflowTarget(), {
					type: "developer.action",
					workflowId: started.snapshot.workflowId,
					revision: view.revision,
					actionId: "request-research-wiki",
				}),
			).toThrow(/action unavailable/);

			const researcherToken = engine.issueRunCapability(
				researchWorkflowTarget(),
				researcher.id,
			);
			// An invalid handoff (no documentation directives) is rejected, does
			// not expire the researcher run, and leaves the workflow at
			// core.research.
			expect(() =>
				engine.dispatch(researchWorkflowTarget(), {
					type: "agent.research-handoff",
					workflowId: started.snapshot.workflowId,
					runId: researcher.id,
					stepId: "core.research",
					role: "researcher",
					token: researcherToken,
					handoff: {
						subject: "widget subsystem",
						findings: "widgets are assembled by the widget factory",
						citations: ["src/widget.ts"],
						noSourcesUsed: false,
					},
				}),
			).toThrow(/documentation directive/);
			expect(
				engine.getSnapshot(
					researchWorkflowTarget(),
					started.snapshot.workflowId,
				).currentStep,
			).toBe("core.research");
			expect(
				engine.getRun(researchWorkflowTarget(), researcher.id).status,
			).not.toBe("expired");
			// Recording is rejected, so no wiki write happened as a side effect.
			expect(listConcepts()).toEqual([]);

			// A valid handoff both records and transitions in one step: the
			// researcher run is expired and the workflow enters core.wiki.
			view = engine.dispatch(researchWorkflowTarget(), {
				type: "agent.research-handoff",
				workflowId: started.snapshot.workflowId,
				runId: researcher.id,
				stepId: "core.research",
				role: "researcher",
				token: researcherToken,
				handoff: {
					subject: "widget subsystem (revised)",
					canonicalTarget: "projects/demo/widget-subsystem",
					findings: "open question: naming for the sub-assembly stage",
					directives: [
						{
							target: "projects/demo/widget-subsystem",
							intent: "update",
							claims: ["widgets are produced by the widget factory"],
							citations: ["src/widget.ts"],
						},
					],
					citations: ["src/widget.ts"],
					noSourcesUsed: false,
				},
			}).view;
			expect(view.currentStep.id).toBe("core.wiki");
			// close-research is no longer offered once the wiki step is entered:
			// the wiki entry is now mandatory once drafting begins.
			expect(view.availableActions.map((action) => action.id)).not.toContain(
				"close-research",
			);
			expect(() =>
				engine.dispatch(researchWorkflowTarget(), {
					type: "developer.action",
					workflowId: started.snapshot.workflowId,
					revision: view.revision,
					actionId: "close-research",
				}),
			).toThrow(/unavailable/);
			expect(
				engine.getRun(researchWorkflowTarget(), researcher.id).status,
			).toBe("expired");
			const wikiContext = engine.getSnapshot(
				researchWorkflowTarget(),
				started.snapshot.workflowId,
			).step.context as {
				task: string;
				handoff: {
					subject: string;
					findings: string;
					directives: Array<{
						target: string;
						intent: string;
						claims: string[];
						citations: string[];
					}>;
					noSourcesUsed: boolean;
				};
			};
			expect(wikiContext.handoff.subject).toBe("widget subsystem (revised)");
			expect(wikiContext.handoff.findings).toBe(
				"open question: naming for the sub-assembly stage",
			);
			expect(wikiContext.handoff.directives).toEqual([
				{
					target: "projects/demo/widget-subsystem",
					intent: "update",
					claims: ["widgets are produced by the widget factory"],
					citations: ["src/widget.ts"],
				},
			]);
			expect(wikiContext.handoff.noSourcesUsed).toBe(false);
			expect(view.runs.some((run) => run.role === "research-wiki")).toBe(true);
			const wikiSummary = requireDefined(
				view.runs.find((run) => run.role === "research-wiki"),
				"wiki run",
			);
			const wiki = engine.getRun(researchWorkflowTarget(), wikiSummary.id);
			const wikiLaunches = engine.claimEffects(researchWorkflowTarget(), 20);
			const wikiOutput = requireDefined(wiki.outputPath, "wiki output");
			fs.mkdirSync(path.dirname(wikiOutput), { recursive: true });
			fs.writeFileSync(
				wikiOutput,
				JSON.stringify({
					runId: wiki.id,
					schemaId: wiki.outputSchema?.id,
					schemaVersion: wiki.outputSchema?.version,
					payload: { draft: true },
				}),
			);
			view = engine.dispatch(researchWorkflowTarget(), {
				type: "agent.handoff",
				runId: wiki.id,
				generation: wiki.generation,
				token: requireToken(wikiLaunches, wiki.id),
				outcome: "complete",
				artifact: wikiOutput,
			}).view;
			expect(view.currentStep.id).toBe("core.wiki-approval");
			// close-research remains unavailable at wiki-approval: the developer
			// must resolve the draft (approve or request changes) first.
			expect(view.availableActions.map((action) => action.id)).not.toContain(
				"close-research",
			);
			expect(() =>
				engine.dispatch(researchWorkflowTarget(), {
					type: "developer.action",
					workflowId: started.snapshot.workflowId,
					revision: view.revision,
					actionId: "close-research",
				}),
			).toThrow(/unavailable/);
			view = engine.dispatch(researchWorkflowTarget(), {
				type: "developer.action",
				workflowId: started.snapshot.workflowId,
				revision: view.revision,
				actionId: "approve-wiki",
			}).view;
			// Approval routes through the completed close gate, not straight to
			// closed: the developer must take an explicit close action.
			expect(view.currentStep.id).toBe("core.completed");
			expect(view.effects.some((effect) => effect.kind === "wiki.verify")).toBe(
				true,
			);
			expect(view.availableActions.map((action) => action.id)).toEqual([
				"close",
			]);
			view = engine.dispatch(researchWorkflowTarget(), {
				type: "developer.action",
				workflowId: started.snapshot.workflowId,
				revision: view.revision,
				actionId: "close",
			}).view;
			expect(view.currentStep.id).toBe("core.closed");
		} finally {
			if (previousWikiRoot === undefined) delete process.env.HERDR_WIKI_DIR;
			else process.env.HERDR_WIKI_DIR = previousWikiRoot;
			fs.rmSync(tmp, { recursive: true, force: true });
		}
	});
	test("research handoff recording is rejected for any run other than the active core.research researcher", () => {
		const tmp = fs.mkdtempSync(
			path.join(os.tmpdir(), "workflow-research-handoff-auth-"),
		);
		const previousWikiRoot = process.env.HERDR_WIKI_DIR;
		process.env.HERDR_WIKI_DIR = path.join(tmp, "wiki");
		try {
			const engine = new WorkflowEngine(registerBuiltins());
			const researchProfile: ResolvedProfile = {
				...profile,
				tools: ["read"],
				capabilities: [
					"interactive",
					"prompt",
					"persistent-session",
					"run-environment",
					"observe",
					"read-only",
				],
			};
			const started = engine.start({
				repo: researchWorkflowTarget(),
				workflowId: "research-handoff-auth",
				definitionId: "research",
				definitionVersion: definitionVersionForPolicy(6),
				metadata: {
					branch: "",
					baseBranch: "",
					baseCommit: "",
					task: "research",
				},
				routing: {
					defaultProfile: researchProfile.name,
					routes: [
						{
							stepId: "core.research",
							role: "researcher",
							profile: researchProfile,
						},
						{
							stepId: "core.wiki",
							role: "research-wiki",
							profile: researchProfile,
						},
					],
				},
			});
			const setup = requireDefined(
				engine
					.claimEffects(researchWorkflowTarget())
					.find((effect) => effect.kind === "workspace.setup"),
				"research setup",
			);
			engine.dispatch(researchWorkflowTarget(), {
				type: "effect.result",
				effectId: setup.id,
				lease: requireDefined(setup.lease, "setup lease"),
				outcome: "complete",
				data: { workspace: "research-workspace" },
			});
			const view = engine.status(
				researchWorkflowTarget(),
				"research-handoff-auth",
			);
			const researcherSummary = requireDefined(view.runs[0], "researcher run");
			const researcher = engine.getRun(
				researchWorkflowTarget(),
				researcherSummary.id,
			);
			const token = engine.issueRunCapability(
				researchWorkflowTarget(),
				researcher.id,
			);
			const validHandoff = {
				subject: "x",
				findings: "y",
				directives: [
					{
						target: "x",
						intent: "create",
						claims: ["y"],
					},
				],
				noSourcesUsed: true,
			};
			// Wrong role is rejected even with the correct run id, step, and token.
			expect(() =>
				engine.dispatch(researchWorkflowTarget(), {
					type: "agent.research-handoff",
					workflowId: started.snapshot.workflowId,
					runId: researcher.id,
					stepId: "core.research",
					role: "not-the-researcher",
					token,
					handoff: validHandoff,
				}),
			).toThrow();
			// Wrong step is rejected.
			expect(() =>
				engine.dispatch(researchWorkflowTarget(), {
					type: "agent.research-handoff",
					workflowId: started.snapshot.workflowId,
					runId: researcher.id,
					stepId: "core.wiki",
					role: "researcher",
					token,
					handoff: validHandoff,
				}),
			).toThrow();
			// An invalid token is rejected.
			expect(() =>
				engine.dispatch(researchWorkflowTarget(), {
					type: "agent.research-handoff",
					workflowId: started.snapshot.workflowId,
					runId: researcher.id,
					stepId: "core.research",
					role: "researcher",
					token: "wrong-token",
					handoff: validHandoff,
				}),
			).toThrow(/invalid or inactive run capability/);
			// An invalid handoff payload (missing subject/findings, no citations and
			// no explicit no-sources statement) is rejected.
			for (const invalid of [
				{ findings: "y", noSourcesUsed: true },
				{ subject: "x", noSourcesUsed: true },
				{ subject: "x", findings: "y" },
			])
				expect(() =>
					engine.dispatch(researchWorkflowTarget(), {
						type: "agent.research-handoff",
						workflowId: started.snapshot.workflowId,
						runId: researcher.id,
						stepId: "core.research",
						role: "researcher",
						token,
						handoff: invalid,
					}),
				).toThrow();
			// The valid handoff still succeeds through the same authenticated path
			// and drives the transition into core.wiki.
			const recorded = engine.dispatch(researchWorkflowTarget(), {
				type: "agent.research-handoff",
				workflowId: started.snapshot.workflowId,
				runId: researcher.id,
				stepId: "core.research",
				role: "researcher",
				token,
				handoff: validHandoff,
			});
			expect(recorded.snapshot.currentStep).toBe("core.wiki");
		} finally {
			if (previousWikiRoot === undefined) delete process.env.HERDR_WIKI_DIR;
			else process.env.HERDR_WIKI_DIR = previousWikiRoot;
			fs.rmSync(tmp, { recursive: true, force: true });
		}
	});
	test("research handoff contract requires subject, at least one valid documentation directive, and either citations or an explicit no-sources statement", () => {
		expect(() =>
			researchHandoffContract.parse({
				subject: "widget subsystem",
				findings: "widgets are produced by the widget factory",
				directives: [
					{
						target: "projects/demo/widget-subsystem",
						intent: "update",
						claims: ["widgets are produced by the widget factory"],
						citations: ["src/widget.ts"],
					},
				],
				citations: ["src/widget.ts"],
				noSourcesUsed: false,
			}),
		).not.toThrow();
		expect(() =>
			researchHandoffContract.parse({
				subject: "widget subsystem",
				directives: [
					{
						target: "projects/demo/widget-subsystem",
						intent: "create",
						claims: ["widgets are produced by the widget factory"],
					},
				],
				noSourcesUsed: true,
			}),
		).not.toThrow();
		const validDirective = {
			target: "x",
			intent: "create",
			claims: ["y"],
		};
		for (const invalid of [
			{ directives: [validDirective], noSourcesUsed: true }, // missing subject
			{ subject: "", directives: [validDirective], noSourcesUsed: true }, // empty subject
			{ subject: "x", noSourcesUsed: true }, // missing directives
			{ subject: "x", directives: [], noSourcesUsed: true }, // empty directives array
			{
				subject: "x",
				directives: [{ intent: "create", claims: ["y"] }],
				noSourcesUsed: true,
			}, // missing target
			{
				subject: "x",
				directives: [{ target: "x", claims: ["y"] }],
				noSourcesUsed: true,
			}, // missing intent
			{
				subject: "x",
				directives: [{ target: "x", intent: "delete", claims: ["y"] }],
				noSourcesUsed: true,
			}, // invalid intent
			{
				subject: "x",
				directives: [{ target: "x", intent: "create", claims: [] }],
				noSourcesUsed: true,
			}, // empty claims
			{
				subject: "x",
				directives: [validDirective],
				citations: [],
				noSourcesUsed: false,
			}, // no citations, not no-sources
		])
			expect(() => researchHandoffContract.parse(invalid)).toThrow();
		const parsed = researchHandoffContract.parse({
			subject: "widget subsystem",
			canonicalTarget: "projects/demo/widget-subsystem",
			directives: [
				{
					target: "projects/demo/widget-subsystem",
					intent: "update",
					claims: ["widgets are produced by the widget factory"],
				},
			],
			citations: ["src/widget.ts"],
			noSourcesUsed: false,
		});
		expect(parsed.canonicalTarget).toBe("projects/demo/widget-subsystem");
		expect(parsed.findings).toBe("");
	});
	test("research handoff contract bounds citation, directive, and claim counts and total serialized size", () => {
		const directive = { target: "x", intent: "create" as const, claims: ["y"] };
		expect(() =>
			researchHandoffContract.parse({
				subject: "x",
				directives: [directive],
				citations: Array.from({ length: 32 }, (_, index) => `source-${index}`),
				noSourcesUsed: false,
			}),
		).not.toThrow();
		expect(() =>
			researchHandoffContract.parse({
				subject: "x",
				directives: [directive],
				citations: Array.from({ length: 33 }, (_, index) => `source-${index}`),
				noSourcesUsed: false,
			}),
		).toThrow(/at most 32 source citations/);
		expect(() =>
			researchHandoffContract.parse({
				subject: "x",
				directives: Array.from({ length: 16 }, (_, index) => ({
					target: `x-${index}`,
					intent: "create",
					claims: ["y"],
				})),
				noSourcesUsed: true,
			}),
		).not.toThrow();
		expect(() =>
			researchHandoffContract.parse({
				subject: "x",
				directives: Array.from({ length: 17 }, (_, index) => ({
					target: `x-${index}`,
					intent: "create",
					claims: ["y"],
				})),
				noSourcesUsed: true,
			}),
		).toThrow(/at most 16 documentation directives/);
		expect(() =>
			researchHandoffContract.parse({
				subject: "x",
				directives: [
					{
						target: "x",
						intent: "create",
						claims: Array.from({ length: 17 }, (_, index) => `claim-${index}`),
					},
				],
				noSourcesUsed: true,
			}),
		).toThrow(/at most 16 claims/);
		expect(() =>
			researchHandoffContract.parse({
				subject: "x",
				findings: "y".repeat(16384),
				directives: [directive],
				citations: Array.from({ length: 32 }, () => "s".repeat(1024)),
				noSourcesUsed: false,
			}),
		).toThrow(/exceeds 49152 bytes/);
	});
	test("recording a research handoff emits telemetry identified by the researcher run id", () => {
		const tmp = fs.mkdtempSync(
			path.join(os.tmpdir(), "workflow-research-handoff-telemetry-"),
		);
		const previousWikiRoot = process.env.HERDR_WIKI_DIR;
		process.env.HERDR_WIKI_DIR = path.join(tmp, "wiki");
		try {
			const engine = new WorkflowEngine(registerBuiltins());
			const researchProfile: ResolvedProfile = {
				...profile,
				tools: ["read"],
				capabilities: [
					"interactive",
					"prompt",
					"persistent-session",
					"run-environment",
					"observe",
					"read-only",
				],
			};
			const started = engine.start({
				repo: researchWorkflowTarget(),
				workflowId: "research-handoff-telemetry",
				definitionId: "research",
				definitionVersion: definitionVersionForPolicy(6),
				metadata: {
					branch: "",
					baseBranch: "",
					baseCommit: "",
					task: "research",
				},
				routing: {
					defaultProfile: researchProfile.name,
					routes: [
						{
							stepId: "core.research",
							role: "researcher",
							profile: researchProfile,
						},
						{
							stepId: "core.wiki",
							role: "research-wiki",
							profile: researchProfile,
						},
					],
				},
			});
			const setup = requireDefined(
				engine
					.claimEffects(researchWorkflowTarget())
					.find((effect) => effect.kind === "workspace.setup"),
				"research setup",
			);
			engine.dispatch(researchWorkflowTarget(), {
				type: "effect.result",
				effectId: setup.id,
				lease: requireDefined(setup.lease, "setup lease"),
				outcome: "complete",
				data: { workspace: "research-workspace" },
			});
			const view = engine.status(
				researchWorkflowTarget(),
				"research-handoff-telemetry",
			);
			const researcherSummary = requireDefined(view.runs[0], "researcher run");
			const researcher = engine.getRun(
				researchWorkflowTarget(),
				researcherSummary.id,
			);
			const token = engine.issueRunCapability(
				researchWorkflowTarget(),
				researcher.id,
			);
			engine.dispatch(researchWorkflowTarget(), {
				type: "agent.research-handoff",
				workflowId: started.snapshot.workflowId,
				runId: researcher.id,
				stepId: "core.research",
				role: "researcher",
				token,
				handoff: {
					subject: "x",
					findings: "y",
					directives: [{ target: "x", intent: "create", claims: ["y"] }],
					noSourcesUsed: true,
				},
			});
			const telemetryPath = path.join(
				wikiWorkflowDataRoot(),
				".herdr-workflow",
				"research-handoff-telemetry",
				"telemetry.jsonl",
			);
			const events = fs
				.readFileSync(telemetryPath, "utf8")
				.trim()
				.split("\n")
				.map((line) => JSON.parse(line) as { event: string; runId?: string });
			const recorded = events.find(
				(item) => item.event === "research.handoff.recorded",
			);
			expect(recorded?.runId).toBe(researcher.id);
		} finally {
			if (previousWikiRoot === undefined) delete process.env.HERDR_WIKI_DIR;
			else process.env.HERDR_WIKI_DIR = previousWikiRoot;
			fs.rmSync(tmp, { recursive: true, force: true });
		}
	});
	test("change identifiers are bounded before paths are derived", () => {
		expect(validateChangeId("safe-change")).toBe("safe-change");
		for (const value of ["../escape", "a/b", "UPPER", "", `a${"b".repeat(80)}`])
			expect(() => validateChangeId(value)).toThrow("change ID");
	});
	test("main checkout and linked worktree resolve one canonical store", () => {
		const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "workflow-canonical-"));
		try {
			const repo = repository(path.join(tmp, "repo"));
			const linked = path.join(tmp, "linked");
			execFileSync("git", ["worktree", "add", "-q", "-b", "linked", linked], {
				cwd: repo,
			});
			expect(canonicalStorePath(linked)).toBe(canonicalStorePath(repo));
			const engine = new WorkflowEngine(registerBuiltins());
			engine.start({
				repo,
				worktree: linked,
				workflowId: "linked",
				definitionId: "no-openspec",
				metadata: {
					branch: "linked",
					baseBranch: "main",
					baseCommit: "base",
					task: "task",
				},
				routing: routing(),
			});
			expect(engine.status(repo, "linked").worktree).toBe(linked);
			expect(engine.status(linked, "linked").workflowId).toBe(
				engine.status(repo, "linked").workflowId,
			);
		} finally {
			fs.rmSync(tmp, { recursive: true, force: true });
		}
	});
	test("uses canonical store, consumes capability once, and validates exact artifact", () => {
		const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "workflow-runtime-"));
		try {
			const repo = repository(path.join(tmp, "repo"));
			const engine = new WorkflowEngine(
				registerBuiltins(),
				() => new Date("2026-01-01T00:00:00Z"),
			);
			const started = engine.start({
				repo,
				workflowId: "change",
				definitionId: "no-openspec",
				metadata: {
					branch: "main",
					baseBranch: "main",
					baseCommit: execFileSync("git", ["rev-parse", "HEAD"], {
						cwd: repo,
						encoding: "utf8",
					}).trim(),
					task: "do work",
				},
				routing: routing(),
			});
			expect(fs.existsSync(canonicalStorePath(repo))).toBe(true);
			expect(started.view.currentStep.id).toBe("core.implementation");
			const run = engine.getRun(repo, started.view.runs[0]?.id);
			const claimed = engine.claimEffects(repo);
			const launch = requireDefined(
				claimed.find((effect) => effect.kind === "agent.launch"),
				"launch effect",
			);
			expect(launch.runToken).toBeTruthy();
			fs.mkdirSync(
				path.dirname(requireDefined(run.outputPath, "output path")),
				{ recursive: true },
			);
			fs.writeFileSync(
				requireDefined(run.outputPath, "output path"),
				JSON.stringify({
					runId: run.id,
					schemaId: run.outputSchema?.id,
					schemaVersion: run.outputSchema?.version,
					payload: { changed: true },
				}),
			);
			expect(() =>
				engine.dispatch(repo, {
					type: "agent.handoff",
					runId: run.id,
					generation: run.generation,
					token: "forged",
					outcome: "complete",
					artifact: run.outputPath,
				}),
			).toThrow(/capability/);
			const before = new Database(canonicalStorePath(repo))
				.query("SELECT COUNT(*) AS count FROM workflow_events")
				.get() as { count: number };
			expect(() =>
				engine.dispatch(repo, {
					type: "agent.handoff",
					runId: run.id,
					generation: run.generation,
					token: launch.runToken,
					outcome: "complete",
					artifact: path.join(tmp, "wrong.json"),
				}),
			).toThrow(/artifact path/);
			const after = new Database(canonicalStorePath(repo))
				.query("SELECT COUNT(*) AS count FROM workflow_events")
				.get() as { count: number };
			expect(after.count).toBe(before.count);
			const completed = engine.dispatch(repo, {
				type: "agent.handoff",
				runId: run.id,
				generation: run.generation,
				token: launch.runToken,
				outcome: "complete",
				artifact: run.outputPath,
			});
			expect(completed.view.currentStep.id).toBe("core.triage");
			expect(() =>
				engine.dispatch(repo, {
					type: "agent.handoff",
					runId: run.id,
					generation: run.generation,
					token: launch.runToken,
					outcome: "complete",
					artifact: run.outputPath,
				}),
			).toThrow(/stale/);
		} finally {
			fs.rmSync(tmp, { recursive: true, force: true });
		}
	});
	test("malformed persisted snapshot fails closed before command or effect", () => {
		const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "workflow-malformed-"));
		try {
			const repo = repository(path.join(tmp, "repo"));
			const engine = new WorkflowEngine(registerBuiltins());
			const started = engine.start({
				repo,
				workflowId: "malformed",
				definitionId: "no-openspec",
				metadata: {
					branch: "main",
					baseBranch: "main",
					baseCommit: "base",
					task: "task",
				},
				routing: routing(),
			});
			const db = new Database(canonicalStorePath(repo));
			const row = db
				.query("SELECT snapshot_json FROM workflow_instances WHERE id=?")
				.get(started.view.workflowId) as { snapshot_json: string };
			const snapshot = JSON.parse(row.snapshot_json);
			snapshot.currentStep = "unknown.step";
			db.query(
				"UPDATE workflow_instances SET snapshot_json=?,current_step=? WHERE id=?",
			).run(JSON.stringify(snapshot), "unknown.step", started.view.workflowId);
			db.close();
			const view = engine.status(repo, "malformed");
			expect(view.health.valid).toBe(false);
			expect(view.health.diagnostic).toContain("step not in pinned definition");
			expect(() => engine.claimEffects(repo)).toThrow(
				/step not in pinned definition/,
			);
			expect(() =>
				engine.dispatch(repo, {
					type: "operator.repair",
					workflowId: started.view.workflowId,
					revision: 0,
					targetStep: "core.implementation",
					reason: "repair",
				}),
			).toThrow(/step not in pinned definition/);
		} finally {
			fs.rmSync(tmp, { recursive: true, force: true });
		}
	});
	test("snapshot parser rejects malformed required collection and boolean fields", () => {
		const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "workflow-contract-"));
		try {
			const repo = repository(path.join(tmp, "repo"));
			const engine = new WorkflowEngine(registerBuiltins());
			const snapshot = engine.start({
				repo,
				workflowId: "contract",
				definitionId: "no-openspec",
				metadata: {
					branch: "main",
					baseBranch: "main",
					baseCommit: "base",
					task: "task",
				},
				routing: routing(),
			}).snapshot;
			// Mutators intentionally write invalid values into the snapshot; the
			// envelope is untyped on purpose so any field can be corrupted.
			for (const mutate of [
				// biome-ignore lint/suspicious/noExplicitAny: deliberately malformed snapshot
				(value: any) => (value.step.testRunStarted = "false"),
				// biome-ignore lint/suspicious/noExplicitAny: deliberately malformed snapshot
				(value: any) => (value.step.results = {}),
				// biome-ignore lint/suspicious/noExplicitAny: deliberately malformed snapshot
				(value: any) => (value.routing.routes = {}),
				// biome-ignore lint/suspicious/noExplicitAny: deliberately malformed snapshot
				(value: any) => (value.evidence = {}),
			]) {
				const malformed = structuredClone(snapshot);
				mutate(malformed);
				expect(() => parseSnapshot(malformed)).toThrow();
			}
		} finally {
			fs.rmSync(tmp, { recursive: true, force: true });
		}
	});
	test("proposal planning waits for approval and explicit close before cleanup", () => {
		const tmp = fs.mkdtempSync(
			path.join(os.tmpdir(), "workflow-proposal-lifecycle-"),
		);
		try {
			const repo = repository(path.join(tmp, "repo"));
			const changeRoot = path.join(
				repo,
				"openspec",
				"changes",
				"proposal-lifecycle",
			);
			fs.mkdirSync(path.join(changeRoot, "specs", "proposal"), {
				recursive: true,
			});
			for (const file of ["proposal.md", "design.md", "tasks.md"])
				fs.writeFileSync(path.join(changeRoot, file), "# proposal\n");
			fs.writeFileSync(
				path.join(changeRoot, "specs", "proposal", "spec.md"),
				"#### Scenario: proposal remains open\n",
			);
			const engine = new WorkflowEngine(registerBuiltins());
			let view = engine.start({
				repo,
				mode: "checkout",
				workflowId: "proposal-lifecycle",
				definitionId: "openspec-propose",
				metadata: {
					branch: "main",
					baseBranch: "main",
					baseCommit: "base",
					task: "propose a change",
				},
				routing: routing(),
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
				data: { workspace: "proposal", worktree: repo, branch: "main" },
			}).view;
			const run = requireDefined(view.runs[0], "planner run");
			const launch = engine
				.claimEffects(repo, 100)
				.find(
					(effect) =>
						effect.kind === "agent.launch" &&
						(effect.payload as { runId?: string }).runId === run.id,
				);
			const token = requireDefined(launch?.runToken, "planner token");
			const stored = engine.getRun(repo, run.id);
			const outputPath = requireDefined(
				stored.outputPath,
				"planner output path",
			);
			fs.mkdirSync(path.dirname(outputPath), { recursive: true });
			// The planner owns the change id: it authors the change directory and
			// declares it as the primary change in its handoff payload.
			const declaredPrimaryRoot = path.join(
				repo,
				"openspec",
				"changes",
				"proposal",
			);
			fs.mkdirSync(path.join(declaredPrimaryRoot, "specs", "feature"), {
				recursive: true,
			});
			for (const file of ["proposal.md", "design.md", "tasks.md"])
				fs.writeFileSync(path.join(declaredPrimaryRoot, file), "- [x] task\n");
			fs.writeFileSync(
				path.join(declaredPrimaryRoot, "specs", "feature", "spec.md"),
				"#### Scenario: works\n",
			);
			fs.writeFileSync(
				outputPath,
				JSON.stringify({
					runId: run.id,
					schemaId: stored.outputSchema?.id,
					schemaVersion: stored.outputSchema?.version,
					payload: { primaryChangeId: "proposal", planned: true },
				}),
			);
			view = engine.dispatch(repo, {
				type: "agent.handoff",
				runId: run.id,
				generation: stored.generation,
				token,
				outcome: "complete",
				artifact: outputPath,
			}).view;
			const validation = requireDefined(
				engine
					.claimEffects(repo, 100)
					.find((effect) => effect.kind === "openspec.validate"),
				"OpenSpec validation effect",
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
			expect(view.availableActions.map((action) => action.id)).toEqual([
				"approve-plan",
				"review-comments",
				"reject-plan",
			]);
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
			for (const kind of [
				"delivery.commit",
				"delivery.push",
				"pull-request.create",
			] as const)
				expect(view.effects.map((effect) => effect.kind)).not.toContain(kind);
			expect(
				view.runs.some((run) =>
					["core.implementation", "core.verification", "core.archive"].includes(
						run.stepId,
					),
				),
			).toBe(false);
			expect(() =>
				engine.dispatch(repo, {
					type: "developer.action",
					workflowId: view.workflowId,
					revision: view.revision,
					actionId: "create-pr",
				}),
			).toThrow(/unavailable/);
			view = engine.dispatch(repo, {
				type: "developer.action",
				workflowId: view.workflowId,
				revision: view.revision,
				actionId: "close",
			}).view;
			expect(view.currentStep.id).toBe("core.closed");
			const close = requireDefined(
				engine
					.claimEffects(repo, 100)
					.find((effect) => effect.kind === "workspace.close"),
				"workspace close effect",
			);
			expect(
				engine
					.claimEffects(repo, 100)
					.some((effect) => effect.kind === "workspace.cleanup"),
			).toBe(false);
			engine.dispatch(repo, {
				type: "effect.result",
				effectId: close.id,
				lease: requireDefined(close.lease, "close lease"),
				outcome: "complete",
			});
			expect(
				engine
					.claimEffects(repo, 100)
					.some((effect) => effect.kind === "workspace.cleanup"),
			).toBe(true);
		} finally {
			fs.rmSync(tmp, { recursive: true, force: true });
		}
	});
	test("proposal plan rejection and comments return to planning", () => {
		const tmp = fs.mkdtempSync(
			path.join(os.tmpdir(), "workflow-proposal-review-"),
		);
		try {
			const repo = repository(path.join(tmp, "repo"));
			const engine = new WorkflowEngine(registerBuiltins());
			const started = engine.start({
				repo,
				mode: "checkout",
				workflowId: "proposal-review",
				definitionId: "openspec-propose",
				metadata: { branch: "main", baseBranch: "main", baseCommit: "base" },
				routing: routing(),
			});
			const gate = engine.dispatch(repo, {
				type: "operator.repair",
				workflowId: started.view.workflowId,
				revision: started.view.revision,
				targetStep: "core.plan-approval",
				reason: "review proposal",
			});
			const rejected = engine.dispatch(repo, {
				type: "developer.action",
				workflowId: started.view.workflowId,
				revision: gate.view.revision,
				actionId: "reject-plan",
				input: { reason: "needs more detail" },
			});
			expect(rejected.view.currentStep.id).toBe("core.plan");
			const commentsGate = engine.dispatch(repo, {
				type: "operator.repair",
				workflowId: started.view.workflowId,
				revision: rejected.view.revision,
				targetStep: "core.plan-approval",
				reason: "review again",
			});
			const comments = [
				{ comment: "clarify scope", file: "proposal.md", line: 1 },
			];
			const returned = engine.dispatch(repo, {
				type: "developer.action",
				workflowId: started.view.workflowId,
				revision: commentsGate.view.revision,
				actionId: "review-comments",
				input: { comments },
			});
			expect(returned.view.currentStep.id).toBe("core.plan");
			expect(returned.snapshot.step.mode).toBe("review-fix");
			expect(returned.snapshot.step.context).toEqual({ comments });
			expect(returned.view.effects.map((effect) => effect.kind)).not.toContain(
				"workspace.close",
			);
		} finally {
			fs.rmSync(tmp, { recursive: true, force: true });
		}
	});
	test("developer CAS and repair invalidate runs and retrigger target step", () => {
		const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "workflow-repair-"));
		try {
			const repo = repository(path.join(tmp, "repo"));
			const engine = new WorkflowEngine(registerBuiltins());
			const result = engine.start({
				repo,
				workflowId: "repair",
				definitionId: "openspec-full",
				metadata: { branch: "main", baseBranch: "main", baseCommit: "base" },
				routing: routing(),
			});
			const oldRun = requireDefined(result.view.runs[0], "first run");
			const repaired = engine.dispatch(repo, {
				type: "operator.repair",
				workflowId: result.view.workflowId,
				revision: 0,
				targetStep: "core.plan-approval",
				reason: "operator confirmed evidence",
			});
			expect(repaired.view.status).toBe("active");
			expect(repaired.view.currentStep.id).toBe("core.plan-approval");
			expect(engine.getRun(repo, oldRun.id).status).toBe("expired");
			expect(repaired.view.availableActions.map((item) => item.id)).toEqual([
				"approve-plan",
				"review-comments",
				"reject-plan",
			]);
			expect(() =>
				engine.dispatch(repo, {
					type: "operator.resume",
					workflowId: result.view.workflowId,
					revision: repaired.view.revision,
				}),
			).toThrow(WorkflowRuntimeError);
			expect(() =>
				engine.dispatch(repo, {
					type: "developer.action",
					workflowId: result.view.workflowId,
					revision: 0,
					actionId: "approve-plan",
				}),
			).toThrow(/stale revision/);
			const approved = engine.dispatch(repo, {
				type: "developer.action",
				workflowId: result.view.workflowId,
				revision: repaired.view.revision,
				actionId: "approve-plan",
			});
			expect(approved.view.currentStep.id).toBe("core.implementation");
			expect(() =>
				engine.dispatch(repo, {
					type: "developer.action",
					workflowId: result.view.workflowId,
					revision: repaired.view.revision,
					actionId: "approve-plan",
				}),
			).toThrow(/stale revision/);
		} finally {
			fs.rmSync(tmp, { recursive: true, force: true });
		}
	});
	test("repair accepts omitted and empty reasons", () => {
		const tmp = fs.mkdtempSync(
			path.join(os.tmpdir(), "workflow-repair-empty-reason-"),
		);
		try {
			const repo = repository(path.join(tmp, "repo"));
			const engine = new WorkflowEngine(registerBuiltins());
			const started = engine.start({
				repo,
				workflowId: "repair-empty",
				definitionId: "no-openspec",
				metadata: {
					branch: "main",
					baseBranch: "main",
					baseCommit: "base",
					task: "task",
				},
				routing: routing(),
			});
			const omitted = commandContract.parse({
				type: "operator.repair",
				workflowId: started.view.workflowId,
				revision: started.view.revision,
				targetStep: "core.implementation",
			}) as Extract<
				import("../src/workflow/contracts.ts").WorkflowCommand,
				{ type: "operator.repair" }
			>;
			expect(omitted.reason).toBe("");
			const repaired = engine.dispatch(repo, { ...omitted });
			expect(repaired.snapshot.repaired?.reason).toBe("");
			const parsed = parseSnapshot({
				...repaired.snapshot,
				repaired: {
					...requireDefined(repaired.snapshot.repaired, "repaired metadata"),
					reason: "",
				},
			});
			expect(parsed.repaired?.reason).toBe("");
			const empty = engine.dispatch(repo, {
				type: "operator.repair",
				workflowId: started.view.workflowId,
				revision: repaired.view.revision,
				targetStep: "core.implementation",
				reason: "",
			});
			expect(empty.snapshot.repaired?.reason).toBe("");
		} finally {
			fs.rmSync(tmp, { recursive: true, force: true });
		}
	});
	test("review-comments at plan approval returns to planning with feedback and review-fix mode", () => {
		const tmp = fs.mkdtempSync(
			path.join(os.tmpdir(), "workflow-plan-comments-"),
		);
		try {
			const repo = repository(path.join(tmp, "repo"));
			const engine = new WorkflowEngine(registerBuiltins());
			const result = engine.start({
				repo,
				workflowId: "plan-comments",
				definitionId: "openspec-full",
				metadata: { branch: "main", baseBranch: "main", baseCommit: "base" },
				routing: routing(),
			});
			const atGate = engine.dispatch(repo, {
				type: "operator.repair",
				workflowId: result.view.workflowId,
				revision: 0,
				targetStep: "core.plan-approval",
				reason: "operator confirmed evidence",
			});
			const comments = [
				{ comment: "clarify scope", file: "proposal.md", line: 3 },
				{
					comment: "design needs a diagram",
					file: "design.md",
					line: 7,
					startLine: 7,
					endLine: 9,
				},
			];
			const reentered = engine.dispatch(repo, {
				type: "developer.action",
				workflowId: result.view.workflowId,
				revision: atGate.view.revision,
				actionId: "review-comments",
				input: { comments },
			});
			expect(reentered.view.currentStep.id).toBe("core.plan");
			expect(reentered.snapshot.step.mode).toBe("review-fix");
			expect(reentered.snapshot.step.context).toEqual(
				JSON.parse(JSON.stringify({ comments })),
			);
			expect(engine.getRun(repo, result.view.runs[0]?.id).status).toBe(
				"expired",
			);
		} finally {
			fs.rmSync(tmp, { recursive: true, force: true });
		}
	});
	test("plan gate rejects malformed or unbounded review-comments without mutation", () => {
		const tmp = fs.mkdtempSync(
			path.join(os.tmpdir(), "workflow-plan-comments-invalid-"),
		);
		try {
			const repo = repository(path.join(tmp, "repo"));
			const engine = new WorkflowEngine(registerBuiltins());
			const result = engine.start({
				repo,
				workflowId: "plan-comments-invalid",
				definitionId: "openspec-full",
				metadata: { branch: "main", baseBranch: "main", baseCommit: "base" },
				routing: routing(),
			});
			const atGate = engine.dispatch(repo, {
				type: "operator.repair",
				workflowId: result.view.workflowId,
				revision: 0,
				targetStep: "core.plan-approval",
				reason: "operator confirmed evidence",
			});
			const revision = atGate.view.revision;
			const before = new Database(canonicalStorePath(repo))
				.query("SELECT COUNT(*) AS count FROM workflow_events")
				.get() as { count: number };
			for (const input of [
				{ comments: [] },
				{ comments: [{}] },
				{ comments: [{ comment: "   ", file: "x.md", line: 1 }] },
				{ comments: [{ comment: "x".repeat(4097), file: "x.md", line: 1 }] },
				{ comments: "nope" },
				{},
			]) {
				expect(() =>
					engine.dispatch(repo, {
						type: "developer.action",
						workflowId: result.view.workflowId,
						revision,
						actionId: "review-comments",
						input,
					}),
				).toThrow(WorkflowRuntimeError);
			}
			const after = new Database(canonicalStorePath(repo))
				.query("SELECT COUNT(*) AS count FROM workflow_events")
				.get() as { count: number };
			expect(after.count).toBe(before.count);
			expect(engine.status(repo, "plan-comments-invalid").currentStep.id).toBe(
				"core.plan-approval",
			);
		} finally {
			fs.rmSync(tmp, { recursive: true, force: true });
		}
	});
	test("approve-plan and reject-plan at the plan gate still transition as before", () => {
		const tmp = fs.mkdtempSync(
			path.join(os.tmpdir(), "workflow-plan-gate-regress-"),
		);
		try {
			const repo = repository(path.join(tmp, "repo"));
			const engine = new WorkflowEngine(registerBuiltins());
			const result = engine.start({
				repo,
				workflowId: "plan-gate",
				definitionId: "openspec-full",
				metadata: { branch: "main", baseBranch: "main", baseCommit: "base" },
				routing: routing(),
			});
			const atGate = engine.dispatch(repo, {
				type: "operator.repair",
				workflowId: result.view.workflowId,
				revision: 0,
				targetStep: "core.plan-approval",
				reason: "operator confirmed evidence",
			});
			const approved = engine.dispatch(repo, {
				type: "developer.action",
				workflowId: result.view.workflowId,
				revision: atGate.view.revision,
				actionId: "approve-plan",
			});
			expect(approved.view.currentStep.id).toBe("core.implementation");
			const rejectedRepo = repository(path.join(tmp, "rejected-repo"));
			const rejectedEngine = new WorkflowEngine(registerBuiltins());
			const rejected = rejectedEngine.start({
				repo: rejectedRepo,
				workflowId: "plan-reject",
				definitionId: "openspec-full",
				metadata: { branch: "main", baseBranch: "main", baseCommit: "base" },
				routing: routing(),
			});
			const rejectedGate = rejectedEngine.dispatch(rejectedRepo, {
				type: "operator.repair",
				workflowId: rejected.view.workflowId,
				revision: 0,
				targetStep: "core.plan-approval",
				reason: "operator confirmed evidence",
			});
			const rejectedBack = rejectedEngine.dispatch(rejectedRepo, {
				type: "developer.action",
				workflowId: rejected.view.workflowId,
				revision: rejectedGate.view.revision,
				actionId: "reject-plan",
				input: { reason: "needs more detail" },
			});
			expect(rejectedBack.view.currentStep.id).toBe("core.plan");
			expect(rejectedBack.snapshot.step.mode).toBeUndefined();
		} finally {
			fs.rmSync(tmp, { recursive: true, force: true });
		}
	});
	test("parallel handoffs merge across intervening revisions without overwrite", () => {
		const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "workflow-parallel-"));
		try {
			const repo = repository(path.join(tmp, "repo"));
			const engine = new WorkflowEngine(registerBuiltins());
			let view = engine.start({
				repo,
				workflowId: "parallel",
				definitionId: "no-openspec",
				metadata: {
					branch: "main",
					baseBranch: "main",
					baseCommit: "base",
					task: "task",
				},
				routing: routing(),
			}).view;
			const complete = (runId: string, token: string, body: unknown) => {
				const run = engine.getRun(repo, runId);
				fs.mkdirSync(
					path.dirname(requireDefined(run.outputPath, "output path")),
					{ recursive: true },
				);
				fs.writeFileSync(
					requireDefined(run.outputPath, "output path"),
					JSON.stringify({
						runId,
						schemaId: run.outputSchema?.id,
						schemaVersion: run.outputSchema?.version,
						payload: body,
					}),
				);
				return engine.dispatch(repo, {
					type: "agent.handoff",
					runId,
					generation: run.generation,
					token,
					outcome: "complete",
					artifact: run.outputPath,
				}).view;
			};
			let launches = engine.claimEffects(repo, 100);
			let run = requireDefined(view.runs[0], "first run");
			fs.appendFileSync(path.join(repo, "README.md"), "changed\n");
			view = complete(run.id, requireToken(launches, run.id), {
				changed: true,
			});
			launches = engine.claimEffects(repo, 100);
			run = requireDefined(
				view.runs.find((item) => item.role === "triage"),
				"triage run",
			);
			view = complete(run.id, requireToken(launches, run.id), {
				roles: [
					{
						role: "quality-verifier",
						reason: "quality",
						files: ["README.md"],
					},
					{
						role: "security-verifier",
						reason: "security",
						files: ["README.md"],
					},
				],
			});
			launches = engine.claimEffects(repo, 100);
			const quality = requireDefined(
				view.runs.find((item) => item.role === "quality-verifier"),
				"run",
			);
			const security = requireDefined(
				view.runs.find((item) => item.role === "security-verifier"),
				"run",
			);
			view = complete(quality.id, requireToken(launches, quality.id), {
				findings: [],
			});
			const afterFirst = view.revision;
			view = complete(security.id, requireToken(launches, security.id), {
				findings: [],
			});
			expect(view.revision).toBe(afterFirst + 1);
			expect(
				view.runs
					.filter((item) => [quality.id, security.id].includes(item.id))
					.map((item) => item.status),
			).toEqual(["completed", "completed"]);
			expect(
				view.runs.some(
					(item) => item.role === "test-verifier" && item.status === "pending",
				),
			).toBe(true);
		} finally {
			fs.rmSync(tmp, { recursive: true, force: true });
		}
	});
	test("triage scope accepts files inside untracked directories (openspec change dir)", () => {
		const tmp = fs.mkdtempSync(
			path.join(os.tmpdir(), "workflow-triage-scope-"),
		);
		try {
			const repo = repository(path.join(tmp, "repo"));
			const engine = new WorkflowEngine(registerBuiltins());
			let view = engine.start({
				repo,
				workflowId: "scope",
				definitionId: "no-openspec",
				metadata: {
					branch: "main",
					baseBranch: "main",
					baseCommit: execFileSync("git", ["rev-parse", "HEAD"], {
						cwd: repo,
						encoding: "utf8",
					}).trim(),
					task: "task",
				},
				routing: routing(),
			}).view;
			const handoff = (role: string, payload: unknown) => {
				const runView = requireDefined(
					view.runs.find((item) => item.role === role),
					`${role} run`,
				);
				const launch = requireDefined(
					engine
						.claimEffects(repo, 100)
						.find(
							(effect) =>
								effect.kind === "agent.launch" &&
								(effect.payload as { runId?: string }).runId === runView.id,
						),
					"launch effect",
				);
				const run = engine.getRun(repo, runView.id);
				fs.mkdirSync(
					path.dirname(requireDefined(run.outputPath, "output path")),
					{ recursive: true },
				);
				fs.writeFileSync(
					requireDefined(run.outputPath, "output path"),
					JSON.stringify({
						runId: run.id,
						schemaId: run.outputSchema?.id,
						schemaVersion: run.outputSchema?.version,
						payload,
					}),
				);
				view = engine.dispatch(repo, {
					type: "agent.handoff",
					runId: run.id,
					generation: run.generation,
					token: requireDefined(launch.runToken, "run token"),
					outcome: "complete",
					artifact: run.outputPath,
				}).view;
			};
			handoff("worker", { changed: true });
			fs.mkdirSync(
				path.join(
					repo,
					"openspec",
					"changes",
					"scope",
					"specs",
					"credential-popup",
				),
				{ recursive: true },
			);
			for (const file of [
				"proposal.md",
				"design.md",
				"tasks.md",
				"specs/credential-popup/spec.md",
			])
				fs.writeFileSync(
					path.join(repo, "openspec", "changes", "scope", file),
					"# x\n",
				);
			expect(() =>
				handoff("triage", {
					roles: [
						{
							role: "quality-verifier",
							reason: "review",
							files: [
								"openspec/changes/scope/proposal.md",
								"openspec/changes/scope/specs/credential-popup/spec.md",
							],
						},
					],
				}),
			).not.toThrow();
			expect(view.currentStep.id).toBe("core.verification");
			expect(
				engine
					.status(repo, "scope")
					.runs.some(
						(run) =>
							run.role === "quality-verifier" && run.status === "pending",
					),
			).toBe(true);
		} finally {
			fs.rmSync(tmp, { recursive: true, force: true });
		}
	});
	test("failed parallel verifier expires and stops siblings", () => {
		const tmp = fs.mkdtempSync(
			path.join(os.tmpdir(), "workflow-sibling-stop-"),
		);
		try {
			const repo = repository(path.join(tmp, "repo"));
			const engine = new WorkflowEngine(registerBuiltins());
			let view = engine.start({
				repo,
				workflowId: "siblings",
				definitionId: "no-openspec",
				metadata: {
					branch: "main",
					baseBranch: "main",
					baseCommit: "base",
					task: "task",
				},
				routing: routing(),
			}).view;
			const complete = (role: string, payload: unknown) => {
				const runView = requireDefined(
					view.runs.find((item) => item.role === role),
					`${role} run`,
				);
				const launch = requireDefined(
					engine
						.claimEffects(repo, 100)
						.find(
							(effect) =>
								effect.kind === "agent.launch" &&
								(effect.payload as { runId?: string }).runId === runView.id,
						),
					"launch effect",
				);
				const run = engine.getRun(repo, runView.id);
				fs.mkdirSync(
					path.dirname(requireDefined(run.outputPath, "output path")),
					{ recursive: true },
				);
				fs.writeFileSync(
					requireDefined(run.outputPath, "output path"),
					JSON.stringify({
						runId: run.id,
						schemaId: run.outputSchema?.id,
						schemaVersion: run.outputSchema?.version,
						payload,
					}),
				);
				view = engine.dispatch(repo, {
					type: "agent.handoff",
					runId: run.id,
					generation: run.generation,
					token: requireDefined(launch.runToken, "run token"),
					outcome: "complete",
					artifact: run.outputPath,
				}).view;
			};
			complete("worker", { changed: true });
			fs.appendFileSync(path.join(repo, "README.md"), "scope\n");
			complete("triage", {
				roles: [
					{ role: "quality-verifier", reason: "quality", files: ["README.md"] },
					{
						role: "security-verifier",
						reason: "security",
						files: ["README.md"],
					},
				],
			});
			const launches = engine
				.claimEffects(repo, 100)
				.filter((effect) => effect.kind === "agent.launch");
			for (const effect of launches)
				engine.dispatch(repo, {
					type: "effect.result",
					effectId: effect.id,
					lease: requireDefined(effect.lease, "effect lease"),
					outcome: "complete",
					data: {
						runtime: "pi",
						name: String((effect.payload as { runId: string }).runId),
						paneId: `pane-${(effect.payload as { runId: string }).runId}`,
					},
				});
			view = engine.status(repo, "siblings");
			const quality = requireDefined(
				view.runs.find((run) => run.role === "quality-verifier"),
				"run",
			);
			const qualityRun = engine.getRun(repo, quality.id);
			const token = requireDefined(
				launches.find(
					(effect) =>
						(effect.payload as { runId: string }).runId === quality.id,
				)?.runToken,
				"run token",
			);
			view = engine.dispatch(repo, {
				type: "agent.handoff",
				runId: quality.id,
				generation: qualityRun.generation,
				token,
				outcome: "failed",
				message: "failed",
			}).view;
			const security = requireDefined(
				view.runs.find((run) => run.role === "security-verifier"),
				"run",
			);
			expect(security.status).toBe("expired");
			expect(
				view.effects.some(
					(effect) =>
						effect.kind === "agent.stop" && effect.status === "pending",
				),
			).toBe(true);
		} finally {
			fs.rmSync(tmp, { recursive: true, force: true });
		}
	});
	test("empty triage selection launches mandatory test verifier directly", () => {
		const tmp = fs.mkdtempSync(
			path.join(os.tmpdir(), "workflow-empty-triage-"),
		);
		try {
			const repo = repository(path.join(tmp, "repo"));
			const engine = new WorkflowEngine(registerBuiltins());
			let view = engine.start({
				repo,
				workflowId: "empty",
				definitionId: "no-openspec",
				metadata: {
					branch: "main",
					baseBranch: "main",
					baseCommit: "base",
					task: "task",
				},
				routing: routing(),
			}).view;
			const handoff = (role: string, payload: unknown) => {
				const run = requireDefined(
					view.runs.find((item) => item.role === role),
					`${role} run`,
				);
				const launch = requireDefined(
					engine
						.claimEffects(repo, 100)
						.find(
							(effect) =>
								effect.kind === "agent.launch" &&
								(effect.payload as { runId?: string }).runId === run.id,
						),
					"launch effect",
				);
				const stored = engine.getRun(repo, run.id);
				fs.mkdirSync(
					path.dirname(requireDefined(stored.outputPath, "output path")),
					{ recursive: true },
				);
				fs.writeFileSync(
					requireDefined(stored.outputPath, "output path"),
					JSON.stringify({
						runId: run.id,
						schemaId: stored.outputSchema?.id,
						schemaVersion: stored.outputSchema?.version,
						payload,
					}),
				);
				view = engine.dispatch(repo, {
					type: "agent.handoff",
					runId: run.id,
					generation: stored.generation,
					token: requireDefined(launch.runToken, "run token"),
					outcome: "complete",
					artifact: stored.outputPath,
				}).view;
			};
			handoff("worker", { changed: true });
			handoff("triage", { roles: [] });
			expect(
				view.runs
					.filter((run) => run.status === "pending")
					.map((run) => run.role),
			).toEqual(["test-verifier"]);
		} finally {
			fs.rmSync(tmp, { recursive: true, force: true });
		}
	});
	test("verification round agents are stopped once the round passes, including the triage agent", () => {
		const tmp = fs.mkdtempSync(
			path.join(os.tmpdir(), "workflow-round-stop-pass-"),
		);
		try {
			const repo = repository(path.join(tmp, "repo"));
			const engine = new WorkflowEngine(registerBuiltins());
			let view = engine.start({
				repo,
				workflowId: "round-pass",
				definitionId: "no-openspec",
				metadata: {
					branch: "main",
					baseBranch: "main",
					baseCommit: "base",
					task: "task",
				},
				routing: routing(),
			}).view;
			// Gives a run's agent a real pane handle (like a live `pi` process)
			// before completing it, so a leaked agent.stop gap is observable.
			const completeWithHandle = (role: string, payload: unknown) => {
				const runView = requireDefined(
					view.runs.find((item) => item.role === role),
					`${role} run`,
				);
				const launch = requireDefined(
					engine
						.claimEffects(repo, 100)
						.find(
							(effect) =>
								effect.kind === "agent.launch" &&
								(effect.payload as { runId?: string }).runId === runView.id,
						),
					"launch effect",
				);
				view = engine.dispatch(repo, {
					type: "effect.result",
					effectId: launch.id,
					lease: requireDefined(launch.lease, "effect lease"),
					outcome: "complete",
					data: {
						runtime: "pi",
						name: runView.id,
						paneId: `pane-${runView.id}`,
					},
				}).view;
				const run = engine.getRun(repo, runView.id);
				fs.mkdirSync(
					path.dirname(requireDefined(run.outputPath, "output path")),
					{ recursive: true },
				);
				fs.writeFileSync(
					requireDefined(run.outputPath, "output path"),
					JSON.stringify({
						runId: run.id,
						schemaId: run.outputSchema?.id,
						schemaVersion: run.outputSchema?.version,
						payload,
					}),
				);
				view = engine.dispatch(repo, {
					type: "agent.handoff",
					runId: run.id,
					generation: run.generation,
					token: requireDefined(launch.runToken, "run token"),
					outcome: "complete",
					artifact: run.outputPath,
				}).view;
				return run;
			};
			completeWithHandle("worker", { changed: true });
			const triageRun = completeWithHandle("triage", { roles: [] });
			const testVerifierRun = completeWithHandle("test-verifier", {
				findings: [],
			});
			expect(
				view.runs.find((run) => run.id === testVerifierRun.id)?.status,
			).toBe("completed");
			const stoppedRunIds = engine
				.claimEffects(repo, 100)
				.filter((effect) => effect.kind === "agent.stop")
				.map((effect) => (effect.payload as { runId?: string }).runId);
			expect(stoppedRunIds).toEqual(
				expect.arrayContaining([triageRun.id, testVerifierRun.id]),
			);
		} finally {
			fs.rmSync(tmp, { recursive: true, force: true });
		}
	});
	test("verification round agents are stopped when a critical finding sends the round back for fixes", () => {
		const tmp = fs.mkdtempSync(
			path.join(os.tmpdir(), "workflow-round-stop-fix-"),
		);
		try {
			const repo = repository(path.join(tmp, "repo"));
			const engine = new WorkflowEngine(registerBuiltins());
			let view = engine.start({
				repo,
				workflowId: "round-fix",
				definitionId: "no-openspec",
				metadata: {
					branch: "main",
					baseBranch: "main",
					baseCommit: "base",
					task: "task",
				},
				routing: routing(),
			}).view;
			const completeWithHandle = (role: string, payload: unknown) => {
				const runView = requireDefined(
					view.runs.find((item) => item.role === role),
					`${role} run`,
				);
				const launch = requireDefined(
					engine
						.claimEffects(repo, 100)
						.find(
							(effect) =>
								effect.kind === "agent.launch" &&
								(effect.payload as { runId?: string }).runId === runView.id,
						),
					"launch effect",
				);
				view = engine.dispatch(repo, {
					type: "effect.result",
					effectId: launch.id,
					lease: requireDefined(launch.lease, "effect lease"),
					outcome: "complete",
					data: {
						runtime: "pi",
						name: runView.id,
						paneId: `pane-${runView.id}`,
					},
				}).view;
				const run = engine.getRun(repo, runView.id);
				fs.mkdirSync(
					path.dirname(requireDefined(run.outputPath, "output path")),
					{ recursive: true },
				);
				fs.writeFileSync(
					requireDefined(run.outputPath, "output path"),
					JSON.stringify({
						runId: run.id,
						schemaId: run.outputSchema?.id,
						schemaVersion: run.outputSchema?.version,
						payload,
					}),
				);
				view = engine.dispatch(repo, {
					type: "agent.handoff",
					runId: run.id,
					generation: run.generation,
					token: requireDefined(launch.runToken, "run token"),
					outcome: "complete",
					artifact: run.outputPath,
				}).view;
				return run;
			};
			completeWithHandle("worker", { changed: true });
			fs.appendFileSync(path.join(repo, "README.md"), "scope\n");
			const triageRun = completeWithHandle("triage", {
				roles: [
					{
						role: "quality-verifier",
						reason: "quality",
						files: ["README.md"],
					},
				],
			});
			const qualityRun = completeWithHandle("quality-verifier", {
				findings: [
					{
						id: "Q-1",
						severity: "critical",
						detail: "bad",
						path: "README.md",
						line: 1,
					},
				],
			});
			expect(view.currentStep.id).toBe("core.implementation");
			const stoppedRunIds = engine
				.claimEffects(repo, 100)
				.filter((effect) => effect.kind === "agent.stop")
				.map((effect) => (effect.payload as { runId?: string }).runId);
			expect(stoppedRunIds).toEqual(
				expect.arrayContaining([triageRun.id, qualityRun.id]),
			);
		} finally {
			fs.rmSync(tmp, { recursive: true, force: true });
		}
	});
	test("operator.repin re-pins a workflow whose definition digest changed, with revision gate", () => {
		const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "workflow-repin-"));
		try {
			const repo = repository(path.join(tmp, "repo"));
			const engine = new WorkflowEngine(registerBuiltins());
			const started = engine.start({
				repo,
				workflowId: "repin",
				definitionId: "no-openspec",
				metadata: {
					branch: "main",
					baseBranch: "main",
					baseCommit: execFileSync("git", ["rev-parse", "HEAD"], {
						cwd: repo,
						encoding: "utf8",
					}).trim(),
					task: "task",
				},
				routing: routing(),
			}).view;
			const db = new Database(canonicalStorePath(repo));
			const row = db
				.query("SELECT snapshot_json FROM workflow_instances WHERE id='repin'")
				.get() as { snapshot_json: string };
			const snapshot = JSON.parse(row.snapshot_json);
			snapshot.definition.digest =
				"deadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef";
			db.query("UPDATE workflow_instances SET snapshot_json=? WHERE id=?").run(
				JSON.stringify(snapshot),
				"repin",
			);
			db.close();
			const stale = engine.status(repo, "repin");
			expect(stale.health.valid).toBe(false);
			expect(String(stale.health.diagnostic)).toMatch(/pin mismatch/);
			expect(
				stale.availableActions.some((action) => action.id === "re-pin"),
			).toBe(true);
			expect(() =>
				engine.dispatch(repo, {
					type: "operator.repin",
					workflowId: started.workflowId,
					revision: started.revision + 1,
				}),
			).toThrow(/stale revision/);
			const current = registerBuiltins().definition("no-openspec", 1);
			const repinned = engine.dispatch(repo, {
				type: "operator.repin",
				workflowId: started.workflowId,
				revision: started.revision,
			}).view;
			expect(repinned.health.valid).toBe(true);
			expect(repinned.definition.digest).toBe(current.digest);
			expect(engine.status(repo, "repin").health.valid).toBe(true);
		} finally {
			fs.rmSync(tmp, { recursive: true, force: true });
		}
	});
	test("blocked handoff routes attention and verification attempt limit fails closed", () => {
		const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "workflow-outcomes-"));
		try {
			const repo = repository(path.join(tmp, "repo"));
			const blockedEngine = new WorkflowEngine(registerBuiltins());
			const blocked = blockedEngine.start({
				repo,
				workflowId: "blocked",
				definitionId: "no-openspec",
				metadata: {
					branch: "main",
					baseBranch: "main",
					baseCommit: "base",
					task: "task",
				},
				routing: routing(),
			});
			const blockedRun = requireDefined(blocked.view.runs[0], "first run");
			const blockedToken = requireDefined(
				blockedEngine
					.claimEffects(repo, 100)
					.find((effect) => effect.kind === "agent.launch")?.runToken,
				"run token",
			);
			expect(
				blockedEngine.dispatch(repo, {
					type: "agent.handoff",
					runId: blockedRun.id,
					generation: 1,
					token: blockedToken,
					outcome: "blocked",
					message: "need input",
				}).view.status,
			).toBe("attention-required");
			const db = new Database(canonicalStorePath(repo));
			const profileJson = JSON.stringify(profile);
			const definition = registerBuiltins().definition("no-openspec", 1);
			const workflowId = randomUUID();
			const runId = randomUUID();
			const at = new Date().toISOString();
			const snapshot = {
				schemaVersion: 1,
				workflowId,
				revision: 1,
				definition: {
					id: definition.id,
					version: 1,
					digest: definition.digest,
				},
				status: "active",
				currentStep: "core.verification",
				step: {
					attempt: 6,
					activeRunIds: [runId],
					completedRunIds: [],
					selectedRoles: ["quality-verifier"],
					testRunStarted: false,
					results: [],
				},
				metadata: {
					repository: repo,
					worktree: repo,
					workflowId: "limit",
					branch: "main",
					baseBranch: "main",
					baseCommit: "base",
					createdAt: at,
					updatedAt: at,
					stepEnteredAt: at,
				},
				routing: routing(),
				evidence: [],
				loopCounts: { "core.verification:fix": 5 },
				attention: [],
			};
			db.query(
				"INSERT INTO workflow_instances VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)",
			).run(
				workflowId,
				"limit",
				repo,
				repo,
				definition.id,
				1,
				definition.digest,
				1,
				"active",
				"core.verification",
				JSON.stringify(snapshot),
				at,
				at,
			);
			db.query(
				"INSERT INTO workflow_runs(id,workflow_id,step_id,role,generation,attempt,status,profile_json,issued_revision,allowed_outcomes_json,capability_hash,capability_expires_at,assignment_path,output_path,output_schema_id,output_schema_version,output_digest,handle_json,created_at,completed_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
			).run(
				runId,
				workflowId,
				"core.verification",
				"quality-verifier",
				6,
				6,
				"pending",
				profileJson,
				1,
				JSON.stringify(["complete", "blocked", "failed"]),
				"",
				"2999-01-01T00:00:00Z",
				path.join(repo, ".herdr-workflow/limit/runs/a.md"),
				path.join(repo, ".herdr-workflow/limit/runs/a.json"),
				"core.findings",
				1,
				null,
				null,
				at,
				null,
			);
			db.close();
			const engine = new WorkflowEngine(registerBuiltins());
			const launch = engine.claimEffects(repo, 100);
			if (!launch.length) {
				const store = new Database(canonicalStorePath(repo));
				store
					.query(
						"INSERT INTO workflow_outbox VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)",
					)
					.run(
						randomUUID(),
						workflowId,
						1,
						"agent.launch",
						`run:${runId}:launch`,
						JSON.stringify({ runId }),
						"pending",
						0,
						5,
						null,
						null,
						null,
						null,
					);
				store.close();
			}
			const token = requireDefined(
				engine
					.claimEffects(repo, 100)
					.find((effect) => effect.kind === "agent.launch")?.runToken,
				"run token",
			);
			const run = engine.getRun(repo, runId);
			fs.mkdirSync(
				path.dirname(requireDefined(run.outputPath, "output path")),
				{ recursive: true },
			);
			fs.writeFileSync(
				requireDefined(run.outputPath, "output path"),
				JSON.stringify({
					runId,
					schemaId: "core.findings",
					schemaVersion: 1,
					payload: {
						findings: [
							{
								id: "Q-1",
								severity: "critical",
								detail: "bad",
								path: "src/a.ts",
								line: 3,
							},
						],
					},
				}),
			);
			expect(
				engine.dispatch(repo, {
					type: "agent.handoff",
					runId,
					generation: 6,
					token,
					outcome: "complete",
					artifact: run.outputPath,
				}).view.status,
			).toBe("attention-required");
		} finally {
			fs.rmSync(tmp, { recursive: true, force: true });
		}
	});
	test("outbox lease is durable and stale lease result is rejected", () => {
		const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "workflow-outbox-"));
		try {
			const repo = repository(path.join(tmp, "repo"));
			let time = Date.parse("2026-01-01T00:00:00Z");
			const engine = new WorkflowEngine(
				registerBuiltins(),
				() => new Date(time),
			);
			const _started = engine.start({
				repo,
				workflowId: "outbox",
				definitionId: "no-openspec",
				metadata: {
					branch: "main",
					baseBranch: "main",
					baseCommit: "base",
					task: "task",
				},
				routing: routing(),
			});
			const effect = requireDefined(
				engine.claimEffects(repo, 1, 1000)[0],
				"claimed effect",
			);
			time += 2000;
			expect(() =>
				engine.dispatch(repo, {
					type: "effect.result",
					effectId: effect.id,
					lease: effect.lease,
					outcome: "complete",
				}),
			).toThrow(/expired/);
			const reclaimed = requireDefined(
				engine.claimEffects(repo, 1, 1000)[0],
				"claimed effect",
			);
			expect(reclaimed.id).toBe(effect.id);
			expect(reclaimed.lease).not.toBe(effect.lease);
			const done = engine.dispatch(repo, {
				type: "effect.result",
				effectId: reclaimed.id,
				lease: reclaimed.lease,
				outcome: "complete",
			});
			expect(
				done.view.effects.find((item) => item.id === reclaimed.id)?.status,
			).toBe("completed");
			expect(done.snapshot.revision).toBe(1);
		} finally {
			fs.rmSync(tmp, { recursive: true, force: true });
		}
	});
});
