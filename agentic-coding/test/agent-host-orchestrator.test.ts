// Orchestrator host mode (`agent host --orchestrator`): the host serves only
// the orchestrator policy, offers the orchestrator's workflow tools, and calls
// the unified server with the orchestrator capability from the run env.
import { describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
	createModels,
	fauxAssistantMessage,
	fauxProvider,
	fauxText,
	fauxToolCall,
} from "@earendil-works/pi-ai";
import { MemoryStorage } from "@earendil-works/pi-durable";
import { DurableHost } from "../src/agent-host/host.ts";
import { hostLayout } from "../src/agent-host/layout.ts";
import {
	createOrchestratorExtension,
	ORCHESTRATOR_PROMPT,
} from "../src/agent-host/orchestrator.ts";
import {
	ORCHESTRATOR_TOKEN_ENV,
	ORCHESTRATOR_URL_ENV,
} from "../src/agent-host/orchestrator-env.ts";
import { orchestratorTokenFor } from "../src/server/auth.ts";
import type { EnvironmentAuthority } from "../src/server/environment/private-api.ts";
import type { ServerOperations } from "../src/server/handlers.ts";
import { startWorkflowServer } from "../src/server/lifecycle.ts";
import { WorkflowRuntimeError } from "../src/workflow/contracts.ts";

function toolResults(entries: readonly unknown[]): string[] {
	const texts: string[] = [];
	for (const entry of entries) {
		const record = entry as { kind?: unknown; model?: unknown };
		if (record?.kind !== "pi.tool-result" || !Array.isArray(record.model))
			continue;
		const message = record.model[0] as { content?: unknown } | undefined;
		if (!Array.isArray(message?.content)) continue;
		texts.push(
			message.content
				.filter((block: { type?: unknown }) => block?.type === "text")
				.map((block: { text?: unknown }) => String(block.text ?? ""))
				.join(""),
		);
	}
	return texts;
}

async function waitForResults(
	host: DurableHost,
	runId: string,
	count: number,
): Promise<string[]> {
	for (let i = 0; i < 100; i++) {
		const texts = toolResults(await host.entriesForTest(runId));
		if (texts.length >= count) return texts;
		await new Promise((resolve) => setTimeout(resolve, 20));
	}
	return toolResults(await host.entriesForTest(runId));
}

describe("orchestrator host mode", () => {
	test("tool hints and the prompt carry the ordered workflow-start checklist", () => {
		const extension = createOrchestratorExtension(() => undefined);
		const tools = extension.tools ?? [];
		const descriptions = new Map(
			tools.map((tool) => [tool.name, tool.description]),
		);
		const start = descriptions.get("start_workflow") ?? "";
		const orderedItems = [
			"repository/project",
			"task (goal, constraints, acceptance)",
			"workflow type and why",
			"agent preset/model profile",
			"mode (worktree or checkout)",
			"branch/base",
			"ticket",
			"`app` for env-setup",
			"`stage` for stage-test",
		];
		for (const text of [start, ORCHESTRATOR_PROMPT]) {
			let previous = -1;
			for (const item of orderedItems) {
				const index = text.indexOf(item);
				expect(index).toBeGreaterThan(previous);
				previous = index;
			}
		}
		expect(start).toContain("list_agent_config");
		expect(start).toContain("developer default");
		expect(start).toContain("yourself");
		expect(start).toContain("validate blueprints first");
		expect(start).toContain("sourceBranch and targetBranch");
		expect(start).toContain("configured app for env-setup");
		expect(start).toContain("allow-listed stage for stage-test");
		expect(ORCHESTRATOR_PROMPT).toContain("stage-not-configured");
		expect(start).toContain("human reviews retained");
		expect(ORCHESTRATOR_PROMPT).toContain("Before you start a workflow");

		for (const name of [
			"list_projects",
			"list_workflow_types",
			"list_agent_config",
			"list_branches",
			"list_workflows",
			"list_steps",
			"validate_blueprint",
			"start_workflow",
			"workflow_status",
			"workflow_action",
			"drain_workflow",
			"sessions_report",
			"opencode_session",
		]) {
			const description = descriptions.get(name)?.toLowerCase() ?? "";
			expect(description).toContain("use");
			expect(description).toContain("return");
		}
		expect(descriptions.get("workflow_action")).toContain("current revision");
		expect(descriptions.get("workflow_action")).toContain(
			"belong to the developer",
		);
	});

	test("subscribe_events names the severity trap that hides completion events", () => {
		const extension = createOrchestratorExtension(() => undefined);
		const description =
			(extension.tools ?? []).find((tool) => tool.name === "subscribe_events")
				?.description ?? "";
		// The mistake that silenced the orchestrator: `minSeverity: "warning"`
		// excludes the `info` completion and progress events, so a "tell me when it
		// finishes" subscription must name the terminal ids instead (or read
		// everything).
		expect(description).toContain("minSeverity");
		expect(description).toContain("info");
		expect(description).toContain("EXCLUDES");
		expect(description).toContain("eventIds");
		for (const id of [
			"workflow.completed",
			"workflow.failed",
			"workflow.closed",
			"run.blocked",
		])
			expect(description).toContain(id);
		// `untilWorkflowClosed` prunes the record; it never widens the filter.
		expect(description).toContain("untilWorkflowClosed");
		expect(description).toContain("never widens");
		// The system prompt carries the same rule.
		expect(ORCHESTRATOR_PROMPT).toContain("minSeverity");
		expect(ORCHESTRATOR_PROMPT).toContain("workflow.completed");
	});
	test("serves only the orchestrator policy and calls the server with its capability", async () => {
		const observed: unknown[] = [];
		const server = await startWorkflowServer({
			operations: {
				runObservation: async (request: unknown) => {
					observed.push(request);
					return [
						{
							ident: "shop",
							name: "Shop",
							path: "/repos/shop",
							openspec: true,
							available: true,
						},
					];
				},
			} as unknown as ServerOperations,
		});
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), "orchestrator-host-"));
		const faux = fauxProvider();
		const models = createModels();
		models.setProvider(faux.provider);
		const host = await DurableHost.open({
			layout: hostLayout(dir),
			settings: {},
			globalAgentDir: dir,
			storage: new MemoryStorage(),
			models,
			orchestrator: true,
		});
		try {
			const runEnvPath = path.join(dir, "run.env");
			fs.writeFileSync(
				runEnvPath,
				`${ORCHESTRATOR_URL_ENV}='${server.url}'\n${ORCHESTRATOR_TOKEN_ENV}='${orchestratorTokenFor(server.token)}'\n`,
			);
			const model = `${faux.getModel().provider}/${faux.getModel().id}`;
			const base = {
				runId: "orchestrator",
				name: "orchestrator",
				cwd: dir,
				runEnvPath,
				model,
			};
			await expect(
				host.ensureRun({ ...base, toolPolicy: "default" }),
			).rejects.toThrow("only serves the orchestrator session");
			await host.ensureRun({ ...base, toolPolicy: "orchestrator" });

			faux.setResponses([
				fauxAssistantMessage([fauxToolCall("list_projects", {})], {
					stopReason: "toolUse",
				}),
				fauxAssistantMessage(
					[fauxToolCall("bash", { command: "echo shell-ran-here" })],
					{ stopReason: "toolUse" },
				),
				fauxAssistantMessage([fauxText("done")]),
			]);
			await host.submit("orchestrator", "what can I work on?", "req-1");
			const results = await waitForResults(host, "orchestrator", 2);
			expect(observed).toEqual([{ kind: "projects" }]);
			expect(results[0]).toContain("/repos/shop");
			// The orchestrator decides for itself whether to act directly or launch
			// a workflow, so it gets a real shell alongside its workflow tools.
			expect(results[1]).toContain("shell-ran-here");
		} finally {
			await host.shutdown();
			await server.stop();
		}
	});

	test("workflow reads report who started each workflow", async () => {
		// The session can only tell its own workflows from the developer's if the
		// tools carry `startedBy`, so both reads expose it.
		const startedBy = "orchestrator";
		const server = await startWorkflowServer({
			operations: {
				runObservation: async (request: unknown) =>
					(request as { kind?: string }).kind === "workflows"
						? [
								{
									target: "/repos/shop",
									startedBy,
									state: {
										workflowId: "wf-orch",
										status: "active",
										stepLabel: "Apply",
										branch: "main",
									},
									tasks: [0, 0],
									agents: [],
								},
							]
						: [],
				view: () => ({
					workflowId: "wf-orch",
					startedBy,
					currentStep: { id: "core.implementation", label: "Implementation" },
					runs: [],
					effects: [],
					availableActions: [],
				}),
			} as unknown as ServerOperations,
		});
		const dir = fs.mkdtempSync(
			path.join(os.tmpdir(), "orchestrator-attribution-"),
		);
		const faux = fauxProvider();
		const models = createModels();
		models.setProvider(faux.provider);
		const host = await DurableHost.open({
			layout: hostLayout(dir),
			settings: {},
			globalAgentDir: dir,
			storage: new MemoryStorage(),
			models,
			orchestrator: true,
		});
		try {
			const runEnvPath = path.join(dir, "run.env");
			fs.writeFileSync(
				runEnvPath,
				`${ORCHESTRATOR_URL_ENV}='${server.url}'\n${ORCHESTRATOR_TOKEN_ENV}='${orchestratorTokenFor(server.token)}'\n`,
			);
			await host.ensureRun({
				runId: "orchestrator",
				name: "orchestrator",
				cwd: dir,
				runEnvPath,
				model: `${faux.getModel().provider}/${faux.getModel().id}`,
				toolPolicy: "orchestrator",
			});
			faux.setResponses([
				fauxAssistantMessage([fauxToolCall("list_workflows", {})], {
					stopReason: "toolUse",
				}),
				fauxAssistantMessage(
					[
						fauxToolCall("workflow_status", {
							repo: "/repos/shop",
							workflowId: "wf-orch",
						}),
					],
					{ stopReason: "toolUse" },
				),
				fauxAssistantMessage([fauxText("done")]),
			]);
			await host.submit(
				"orchestrator",
				"what am I running?",
				"req-attribution",
			);
			const results = await waitForResults(host, "orchestrator", 2);
			expect(results[0]).toContain('"startedBy":"orchestrator"');
			expect(results[1]).toContain('"startedBy":"orchestrator"');
			// Compact JSON: the indentation of the pretty-printed envelope was
			// re-sent on every later turn of the conversation.
			expect(results[0]).not.toContain("\n");
			expect(results[1]).not.toContain("\n");
		} finally {
			await host.shutdown();
			await server.stop();
		}
	});

	test("workflow_status is a compact row by default, full on request and short when unchanged", async () => {
		// The three answers of the one tool: the default row (no task text, no run
		// history, no gate decisions), the whole view behind `detail: "full"`, and
		// the few-byte `unchanged` answer when `sinceRevision` is still current.
		const task = "T".repeat(4096);
		const view = {
			workflowId: "wf-compact",
			revision: 7,
			status: "active",
			repository: "/repos/shop",
			worktree: "/repos/shop/.herdr-workflow/wf-compact",
			branch: "feature/wf-compact",
			task,
			startedBy: "orchestrator",
			currentStep: { id: "core.implementation", label: "Implementation" },
			runs: [
				{
					id: "wf-compact-run-1",
					stepId: "core.implementation",
					role: "worker",
					attempt: 1,
					status: "completed",
					runtime: "pi",
					profile: "p",
					model: "m",
				},
			],
			effects: [],
			gateDecisions: [
				{
					stage: "developer-review",
					policy: "always",
					decidedBy: "developer",
					at: "now",
				},
			],
			pendingQuestions: [
				{ id: "q1", targetRole: "orchestrator", status: "pending" },
			],
			orchestratorQuestions: [
				{ id: "q1", targetRole: "orchestrator", status: "pending" },
			],
			availableActions: [
				{ id: "resume", label: "Resume", confirmation: "none" },
			],
		};
		const server = await startWorkflowServer({
			operations: { view: () => view } as unknown as ServerOperations,
		});
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), "orchestrator-compact-"));
		const faux = fauxProvider();
		const models = createModels();
		models.setProvider(faux.provider);
		const host = await DurableHost.open({
			layout: hostLayout(dir),
			settings: {},
			globalAgentDir: dir,
			storage: new MemoryStorage(),
			models,
			orchestrator: true,
		});
		try {
			const runEnvPath = path.join(dir, "run.env");
			fs.writeFileSync(
				runEnvPath,
				`${ORCHESTRATOR_URL_ENV}='${server.url}'\n${ORCHESTRATOR_TOKEN_ENV}='${orchestratorTokenFor(server.token)}'\n`,
			);
			await host.ensureRun({
				runId: "orchestrator",
				name: "orchestrator",
				cwd: dir,
				runEnvPath,
				model: `${faux.getModel().provider}/${faux.getModel().id}`,
				toolPolicy: "orchestrator",
			});
			const call = (args: Record<string, unknown>) => ({
				repo: "/repos/shop",
				workflowId: "wf-compact",
				...args,
			});
			faux.setResponses([
				fauxAssistantMessage([fauxToolCall("workflow_status", call({}))], {
					stopReason: "toolUse",
				}),
				fauxAssistantMessage(
					[fauxToolCall("workflow_status", call({ detail: "full" }))],
					{ stopReason: "toolUse" },
				),
				fauxAssistantMessage(
					[fauxToolCall("workflow_status", call({ sinceRevision: 7 }))],
					{ stopReason: "toolUse" },
				),
				fauxAssistantMessage([fauxText("done")]),
			]);
			await host.submit("orchestrator", "where is wf-compact?", "req-compact");
			const results = await waitForResults(host, "orchestrator", 3);
			// Default: the row, with the routed question once and no task text.
			expect(results[0]).not.toContain(task);
			expect(results[0]).not.toContain("gateDecisions");
			expect(results[0]).toContain('"pendingQuestions":[{"id":"q1"');
			expect(results[0]).toContain(
				'"availableActions":[{"id":"resume","label":"Resume"}]',
			);
			expect(results[0]).not.toContain("orchestratorQuestions");
			// Full: the task text and the gate decisions are back.
			expect(results[1]).toContain(task);
			expect(results[1]).toContain('"gateDecisions"');
			expect(results[1]).not.toContain("orchestratorQuestions");
			// Unchanged: a few bytes, not the row.
			expect(results[2]).toBe(
				'{"unchanged":true,"revision":7,"status":"active","step":{"id":"core.implementation","label":"Implementation"}}',
			);
		} finally {
			await host.shutdown();
			await server.stop();
		}
	});

	test("shapes a workflow: list_steps, validate_blueprint, then start_workflow", async () => {
		// The orchestrator validates a blueprint through the server, then starts it
		// as a blueprint instead of a built-in type. The stub server records both
		// calls so the tool bodies are visible without compiling a workflow.
		const seen: { validation?: unknown; start?: unknown } = {};
		const blueprint = {
			label: "Small fix",
			rationale: "One implementation agent, start to finish.",
			traits: {
				changeArtifacts: "none",
				planning: "none",
				changeIdentity: "none",
				delivery: "none",
				startRequirements: ["task"],
				openspecVerifier: false,
			},
			verificationRounds: 6,
			steps: ["core.implementation", "core.completed", "core.closed"],
			edges: [
				{
					from: "core.implementation",
					outcome: "complete",
					to: "core.completed",
				},
				{ from: "core.completed", outcome: "close", to: "core.closed" },
			],
		};
		const server = await startWorkflowServer({
			operations: {
				blueprintSteps: () => [
					{
						id: "core.implementation",
						label: "Implementation",
						actor: "agent",
						outcomes: ["complete", "blocked", "failed"],
						description: "The worker applies the approved change.",
					},
				],
				validateBlueprint: (value: unknown) => {
					seen.validation = value;
					return {
						ok: true,
						digest: "validated-digest",
						definitionId: "custom.abc123",
						summary: {
							label: "Small fix",
							rationale: "One implementation agent, start to finish.",
							steps: ["core.route-implementation"],
							initial: "core.route-implementation",
							terminal: ["core.closed"],
							stepCount: 1,
							edgeCount: 0,
							verificationRounds: 6,
						},
						diagnostics: [],
					};
				},
				start: async (request: unknown) => {
					seen.start = request;
					return "Workflow started: wf-blueprint";
				},
				loadAgents: () => ({
					agents: {},
				}),
			} as unknown as ServerOperations,
		});
		const dir = fs.mkdtempSync(
			path.join(os.tmpdir(), "orchestrator-blueprint-"),
		);
		const faux = fauxProvider();
		const models = createModels();
		models.setProvider(faux.provider);
		const host = await DurableHost.open({
			layout: hostLayout(dir),
			settings: {},
			globalAgentDir: dir,
			storage: new MemoryStorage(),
			models,
			orchestrator: true,
		});
		try {
			const runEnvPath = path.join(dir, "run.env");
			fs.writeFileSync(
				runEnvPath,
				`${ORCHESTRATOR_URL_ENV}='${server.url}'\n${ORCHESTRATOR_TOKEN_ENV}='${orchestratorTokenFor(server.token)}'\n`,
			);
			await host.ensureRun({
				runId: "orchestrator",
				name: "orchestrator",
				cwd: dir,
				runEnvPath,
				model: `${faux.getModel().provider}/${faux.getModel().id}`,
				toolPolicy: "orchestrator",
			});
			faux.setResponses([
				fauxAssistantMessage([fauxToolCall("list_steps", {})], {
					stopReason: "toolUse",
				}),
				fauxAssistantMessage(
					[fauxToolCall("validate_blueprint", { blueprint })],
					{ stopReason: "toolUse" },
				),
				fauxAssistantMessage(
					[
						fauxToolCall("start_workflow", {
							repo: "/repos/shop",
							workflowId: "wf-blueprint",
							task: "fix the flag",
							blueprint,
						}),
					],
					{ stopReason: "toolUse" },
				),
				fauxAssistantMessage([fauxText("done")]),
			]);
			await host.submit(
				"orchestrator",
				"shape a workflow for me",
				"req-blueprint",
			);
			const results = await waitForResults(host, "orchestrator", 3);
			expect(results[0]).toContain("core.implementation");
			expect(results[1]).toContain("validated-digest");
			expect(results[2]).toContain("wf-blueprint");
			expect(seen.validation).toEqual(blueprint);
			expect(seen.start).toMatchObject({
				repo: "/repos/shop",
				workflowId: "wf-blueprint",
				task: "fix the flag",
				mode: "worktree",
				blueprint,
			});
			// A blueprint start never also names a built-in type.
			expect(
				(seen.start as { workflowType?: unknown }).workflowType,
			).toBeUndefined();
		} finally {
			await host.shutdown();
			await server.stop();
		}
	});

	test("starts an env-setup workflow with the configured app the server validates", async () => {
		// The env-setup family drafts the environment of one configured
		// application, and the orchestrator has no other way to name it: the tool
		// forwards `app`, and the server refuses an ident no configuration knows
		// before a workflow exists (fix-env-tools-for-all-runs).
		const starts: unknown[] = [];
		const server = await startWorkflowServer({
			operations: {
				start: async (request: unknown) => {
					starts.push(request);
					return "Workflow started: wf-env-setup";
				},
				loadAgents: () => ({
					agents: {},
				}),
			} as unknown as ServerOperations,
			environment: {
				manager: {
					getAppByIdent: (ident: string) =>
						ident === "shop" ? { ident: "shop" } : undefined,
					getApps: () => [{ ident: "shop" }],
				},
			} as unknown as EnvironmentAuthority,
		});
		const dir = fs.mkdtempSync(
			path.join(os.tmpdir(), "orchestrator-env-setup-"),
		);
		const faux = fauxProvider();
		const models = createModels();
		models.setProvider(faux.provider);
		const host = await DurableHost.open({
			layout: hostLayout(dir),
			settings: {},
			globalAgentDir: dir,
			storage: new MemoryStorage(),
			models,
			orchestrator: true,
		});
		try {
			const runEnvPath = path.join(dir, "run.env");
			fs.writeFileSync(
				runEnvPath,
				`${ORCHESTRATOR_URL_ENV}='${server.url}'\n${ORCHESTRATOR_TOKEN_ENV}='${orchestratorTokenFor(server.token)}'\n`,
			);
			await host.ensureRun({
				runId: "orchestrator",
				name: "orchestrator",
				cwd: dir,
				runEnvPath,
				model: `${faux.getModel().provider}/${faux.getModel().id}`,
				toolPolicy: "orchestrator",
			});
			const start = (overrides: Record<string, unknown>) => ({
				repo: "/repos/shop",
				workflowId: "wf-env-setup",
				workflowType: "env-setup",
				task: "draft the environment definitions",
				mode: "checkout",
				app: "shop",
				...overrides,
			});
			faux.setResponses([
				fauxAssistantMessage([fauxToolCall("start_workflow", start({}))], {
					stopReason: "toolUse",
				}),
				fauxAssistantMessage(
					[
						fauxToolCall(
							"start_workflow",
							start({ workflowId: "wf-unknown-app", app: "nope" }),
						),
					],
					{ stopReason: "toolUse" },
				),
				fauxAssistantMessage([fauxText("done")]),
			]);
			await host.submit(
				"orchestrator",
				"set up the shop environment",
				"req-setup",
			);
			const results = await waitForResults(host, "orchestrator", 2);
			expect(results[0]).toContain("wf-env-setup");
			expect(starts[0]).toMatchObject({
				repo: "/repos/shop",
				workflowId: "wf-env-setup",
				workflowType: "env-setup",
				mode: "checkout",
				app: "shop",
			});
			// The unknown app never reaches the operation: the transport answers first.
			expect(results[1]).toContain("is not a configured application");
			expect(starts).toHaveLength(1);
		} finally {
			await host.shutdown();
			await server.stop();
		}
	});

	test("starts a stage-test workflow with the allow-listed stage and surfaces a refusal", async () => {
		// A stage test runs on exactly one allow-listed hosted stage, and the
		// orchestrator has no other way to name it: the tool forwards `stage`, and
		// the server refuses an ident that is not in the allow-list with
		// `stage-not-configured` before a workflow exists (`add-stage-test-launch`).
		// The allow-list check itself lives in prepareWorkflowStart
		// (test/workflow-startup.test.ts); here the operation raises the same coded
		// failure the route turns into a 409, so the tool result is what is asserted.
		const starts: unknown[] = [];
		const server = await startWorkflowServer({
			operations: {
				start: async (request: unknown) => {
					const stage = (request as { stage?: string }).stage;
					if (stage === "nope")
						throw new WorkflowRuntimeError(
							"stage-not-configured",
							'stage-test stage "nope" is not in the configured allow-list',
						);
					starts.push(request);
					return "Workflow started: wf-stage-test";
				},
				loadAgents: () => ({
					agents: {},
				}),
			} as unknown as ServerOperations,
		});
		const dir = fs.mkdtempSync(
			path.join(os.tmpdir(), "orchestrator-stage-test-"),
		);
		const faux = fauxProvider();
		const models = createModels();
		models.setProvider(faux.provider);
		const host = await DurableHost.open({
			layout: hostLayout(dir),
			settings: {},
			globalAgentDir: dir,
			storage: new MemoryStorage(),
			models,
			orchestrator: true,
		});
		try {
			const runEnvPath = path.join(dir, "run.env");
			fs.writeFileSync(
				runEnvPath,
				`${ORCHESTRATOR_URL_ENV}='${server.url}'\n${ORCHESTRATOR_TOKEN_ENV}='${orchestratorTokenFor(server.token)}'\n`,
			);
			await host.ensureRun({
				runId: "orchestrator",
				name: "orchestrator",
				cwd: dir,
				runEnvPath,
				model: `${faux.getModel().provider}/${faux.getModel().id}`,
				toolPolicy: "orchestrator",
			});
			const start = (overrides: Record<string, unknown>) => ({
				repo: "/repos/grid",
				workflowId: "wf-stage-test",
				workflowType: "stage-test",
				task: "checkout rejects an expired card",
				ticket: "GRID-1234",
				mode: "worktree",
				stage: "grid-int",
				...overrides,
			});
			faux.setResponses([
				fauxAssistantMessage([fauxToolCall("start_workflow", start({}))], {
					stopReason: "toolUse",
				}),
				fauxAssistantMessage(
					[
						fauxToolCall(
							"start_workflow",
							start({ workflowId: "wf-unknown-stage", stage: "nope" }),
						),
					],
					{ stopReason: "toolUse" },
				),
				fauxAssistantMessage([fauxText("done")]),
			]);
			await host.submit(
				"orchestrator",
				"verify the grid stage test",
				"req-stage",
			);
			const results = await waitForResults(host, "orchestrator", 2);
			expect(results[0]).toContain("wf-stage-test");
			expect(starts[0]).toMatchObject({
				repo: "/repos/grid",
				workflowId: "wf-stage-test",
				workflowType: "stage-test",
				mode: "worktree",
				ticket: "GRID-1234",
				stage: "grid-int",
			});
			// The refused ident reports the server's own code, and no workflow was
			// started for it.
			expect(results[1]).toContain("is not in the configured allow-list");
			expect(results[1]).toContain("[stage-not-configured]");
			expect(starts).toHaveLength(1);
		} finally {
			await host.shutdown();
			await server.stop();
		}
	});

	test("a monitor note is never the previous developer message", async () => {
		// The orchestrator's own delivered notes reach the session through the same
		// submit path a developer message does, so `taskRef.previousMessage` must
		// not turn one into a task: the reference is refused instead.
		const starts: Array<{ task?: string; taskRef?: unknown }> = [];
		const server = await startWorkflowServer({
			operations: {
				runObservation: async () => [],
				start: async (request: unknown) => {
					starts.push(request as { task?: string });
					return "started wf-1";
				},
			} as unknown as ServerOperations,
		});
		const dir = fs.mkdtempSync(
			path.join(os.tmpdir(), "orchestrator-previous-"),
		);
		const faux = fauxProvider();
		const models = createModels();
		models.setProvider(faux.provider);
		const host = await DurableHost.open({
			layout: hostLayout(dir),
			settings: {},
			globalAgentDir: dir,
			storage: new MemoryStorage(),
			models,
			orchestrator: true,
		});
		try {
			const runEnvPath = path.join(dir, "run.env");
			fs.writeFileSync(
				runEnvPath,
				`${ORCHESTRATOR_URL_ENV}='${server.url}'\n${ORCHESTRATOR_TOKEN_ENV}='${orchestratorTokenFor(server.token)}'\n`,
			);
			await host.ensureRun({
				runId: "orchestrator",
				name: "orchestrator",
				cwd: dir,
				runEnvPath,
				model: `${faux.getModel().provider}/${faux.getModel().id}`,
				toolPolicy: "orchestrator",
			});
			const startByReference = () =>
				fauxAssistantMessage(
					[
						fauxToolCall("start_workflow", {
							repo: "/repos/shop",
							workflowId: "wf-1",
							workflowType: "solo",
							taskRef: { previousMessage: true },
						}),
					],
					{ stopReason: "toolUse" },
				);
			faux.setResponses([
				startByReference(),
				fauxAssistantMessage([fauxText("done")]),
			]);
			await host.submit(
				"orchestrator",
				"[workflow-monitor] wf-1 now waits for your review",
				"req-note",
			);
			const results = await waitForResults(host, "orchestrator", 1);
			expect(results[0]).toContain("no developer message yet");
			expect(starts).toHaveLength(0);
		} finally {
			await host.shutdown();
			await server.stop();
		}
	});

	test("the developer's own message is what a task reference reuses", async () => {
		const starts: Array<{ task?: string; taskRef?: unknown }> = [];
		const server = await startWorkflowServer({
			operations: {
				runObservation: async () => [],
				start: async (request: unknown) => {
					starts.push(request as { task?: string });
					return "started wf-1";
				},
			} as unknown as ServerOperations,
		});
		const dir = fs.mkdtempSync(
			path.join(os.tmpdir(), "orchestrator-previous-message-"),
		);
		const faux = fauxProvider();
		const models = createModels();
		models.setProvider(faux.provider);
		const host = await DurableHost.open({
			layout: hostLayout(dir),
			settings: {},
			globalAgentDir: dir,
			storage: new MemoryStorage(),
			models,
			orchestrator: true,
		});
		try {
			const runEnvPath = path.join(dir, "run.env");
			fs.writeFileSync(
				runEnvPath,
				`${ORCHESTRATOR_URL_ENV}='${server.url}'\n${ORCHESTRATOR_TOKEN_ENV}='${orchestratorTokenFor(server.token)}'\n`,
			);
			await host.ensureRun({
				runId: "orchestrator",
				name: "orchestrator",
				cwd: dir,
				runEnvPath,
				model: `${faux.getModel().provider}/${faux.getModel().id}`,
				toolPolicy: "orchestrator",
			});
			faux.setResponses([
				fauxAssistantMessage(
					[
						fauxToolCall("start_workflow", {
							repo: "/repos/shop",
							workflowId: "wf-1",
							workflowType: "solo",
							taskRef: { previousMessage: true },
						}),
					],
					{ stopReason: "toolUse" },
				),
				fauxAssistantMessage([fauxText("done")]),
			]);
			await host.submit(
				"orchestrator",
				"make the flag configurable per preset",
				"req-developer",
			);
			const results = await waitForResults(host, "orchestrator", 1);
			// The host resolves the message (the server holds no conversation), so
			// the wire carries the developer's own words as the task text.
			expect(starts[0]?.task).toBe("make the flag configurable per preset");
			expect(starts[0]?.taskRef).toBeUndefined();
			expect(results[0]).toContain("task from the previous developer message");
		} finally {
			await host.shutdown();
			await server.stop();
		}
	});

	test("a message queued behind the running turn never becomes its task", async () => {
		// `submit` records the message as soon as it is admitted, but a turn that
		// is already running answers an earlier message. A `previousMessage` start
		// inside that turn must substitute the message it is answering, not the one
		// the developer typed while it worked.
		const starts: Array<{ task?: string }> = [];
		let releaseObservations: (() => void) | undefined;
		const gated = new Promise<void>((resolve) => {
			releaseObservations = resolve;
		});
		let reachedGate = false;
		const server = await startWorkflowServer({
			operations: {
				runObservation: async () => {
					reachedGate = true;
					await gated;
					return [];
				},
				start: async (request: unknown) => {
					starts.push(request as { task?: string });
					return "started wf-1";
				},
			} as unknown as ServerOperations,
		});
		const dir = fs.mkdtempSync(
			path.join(os.tmpdir(), "orchestrator-queued-message-"),
		);
		const faux = fauxProvider();
		const models = createModels();
		models.setProvider(faux.provider);
		const host = await DurableHost.open({
			layout: hostLayout(dir),
			settings: {},
			globalAgentDir: dir,
			storage: new MemoryStorage(),
			models,
			orchestrator: true,
		});
		try {
			const runEnvPath = path.join(dir, "run.env");
			fs.writeFileSync(
				runEnvPath,
				`${ORCHESTRATOR_URL_ENV}='${server.url}'\n${ORCHESTRATOR_TOKEN_ENV}='${orchestratorTokenFor(server.token)}'\n`,
			);
			await host.ensureRun({
				runId: "orchestrator",
				name: "orchestrator",
				cwd: dir,
				runEnvPath,
				model: `${faux.getModel().provider}/${faux.getModel().id}`,
				toolPolicy: "orchestrator",
			});
			faux.setResponses([
				fauxAssistantMessage([fauxToolCall("list_workflows", {})], {
					stopReason: "toolUse",
				}),
				fauxAssistantMessage(
					[
						fauxToolCall("start_workflow", {
							repo: "/repos/shop",
							workflowId: "wf-1",
							workflowType: "solo",
							taskRef: { previousMessage: true },
						}),
					],
					{ stopReason: "toolUse" },
				),
				fauxAssistantMessage([fauxText("done")]),
				// The queued message's own turn: it is now the one being answered.
				fauxAssistantMessage(
					[
						fauxToolCall("start_workflow", {
							repo: "/repos/shop",
							workflowId: "wf-2",
							workflowType: "solo",
							taskRef: { previousMessage: true },
						}),
					],
					{ stopReason: "toolUse" },
				),
				fauxAssistantMessage([fauxText("queued message answered")]),
			]);
			await host.submit("orchestrator", "start the flag work", "req-first");
			for (let i = 0; i < 100 && !reachedGate; i++)
				await new Promise((resolve) => setTimeout(resolve, 20));
			expect(reachedGate).toBe(true);
			// Typed while the first turn is still working: queued, not answered.
			await host.submit(
				"orchestrator",
				"also bump the changelog",
				"req-queued",
				"followUp",
			);
			releaseObservations?.();
			await waitForResults(host, "orchestrator", 3);
			expect(starts[0]?.task).toBe("start the flag work");
			// Once its own turn runs, the queued message is the answered one: the
			// queue is promoted on the evidence that it left the inbox.
			expect(starts[1]?.task).toBe("also bump the changelog");
		} finally {
			releaseObservations?.();
			await host.shutdown();
			await server.stop();
		}
	});
});
