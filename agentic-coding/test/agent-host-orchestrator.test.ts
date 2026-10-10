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
	ORCHESTRATOR_TOKEN_ENV,
	ORCHESTRATOR_URL_ENV,
} from "../src/agent-host/orchestrator-env.ts";
import { orchestratorTokenFor } from "../src/server/auth.ts";
import type { ServerOperations } from "../src/server/handlers.ts";
import { startWorkflowServer } from "../src/server/lifecycle.ts";

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
			expect(results[0]).toContain('"startedBy": "orchestrator"');
			expect(results[1]).toContain('"startedBy": "orchestrator"');
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
					orchestratorLimits: { maxActive: 3, maxStartsPerDay: 20 },
					orchestratorLimitsConfigured: false,
				}),
				orchestratorLaunches: () => ({ active: [], recent: [], skipped: [] }),
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
});
