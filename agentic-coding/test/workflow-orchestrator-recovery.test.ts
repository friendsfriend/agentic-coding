// Run with isolated HOME/config/pi/wiki roots before imports (the workflow
// test runner also supplies isolated roots). No adapters, models or apps run.
import { Database } from "bun:sqlite";
import { afterEach, describe, expect, test } from "bun:test";
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
import { Effect } from "effect";
import { DurableHost } from "../src/agent-host/host.ts";
import { hostLayout } from "../src/agent-host/layout.ts";
import { summarizeWorkflowView } from "../src/agent-host/orchestrator.ts";
import {
	compactWorkflowStatus,
	compactWorkflowStatusView,
} from "../src/agent-host/orchestrator-compact.ts";
import type {
	WorkflowCommand,
	WorkflowRecoveryPreview,
	WorkflowSnapshot,
} from "../src/contracts/workflow.ts";
import { createServerApp } from "../src/server/app.ts";
import {
	createInstanceAuthority,
	orchestratorTokenFor,
} from "../src/server/auth.ts";
import { CredentialRegistry } from "../src/server/credentials.ts";
import { EventBroker } from "../src/server/events.ts";
import type { ServerOperations } from "../src/server/handlers.ts";
import type { AgentAdapter, LaunchContext } from "../src/workflow/adapters.ts";
import { registerBuiltins } from "../src/workflow/definitions.ts";
import {
	agentEffectHandlers,
	EffectRunner,
} from "../src/workflow/effect-runner.ts";
import { recoveryAssignmentInput } from "../src/workflow/runtime/recovery.ts";
import { writeSnapshot } from "../src/workflow/runtime/store.ts";
import { canonicalStorePath, WorkflowEngine } from "../src/workflow/runtime.ts";
import { createRepoFixture, repoPreset } from "./support/git-fixture.ts";

const roots: string[] = [];
afterEach(() => {
	for (const root of roots.splice(0))
		fs.rmSync(root, { recursive: true, force: true });
});

function fixture(structural = false, definitionId = "solo") {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "recovery-proof-"));
	roots.push(root);
	const repo = createRepoFixture(
		path.join(root, "repo"),
		repoPreset.specDriven,
	);
	let engine = new WorkflowEngine(registerBuiltins());
	const profile = {
		name: "test",
		runtime: "pi-durable" as const,
		executable: process.execPath,
		tools: [],
		extensions: [],
		readOnly: false,
		capabilities: ["prompt" as const],
		digest: "test-profile",
	};
	const started = engine.start({
		repo,
		workflowId: "recovery-proof",
		definitionId,
		...(definitionId === "verify" ? { mode: "checkout" as const } : {}),
		metadata: {
			branch: "main",
			baseBranch: "main",
			baseCommit: "HEAD",
			task: "Recover the agreed implementation",
			startedBy: "orchestrator",
		},
		routing: {
			defaultProfile: "test",
			routes: [
				"core.plan",
				"core.implementation",
				"core.triage",
				"core.verification",
				"core.archive",
			].map((stepId) => ({ stepId, profile })),
		},
	});
	const snapshot = engine.getSnapshot(repo, started.view.workflowId);
	snapshot.currentStep = "core.implementation";
	snapshot.status = "attention-required";
	snapshot.step.activeRunIds = structural ? ["missing-current-run"] : [];
	snapshot.step.context = { boundary: "agreed-api" };
	snapshot.step.mode = "fix";
	const evidencePath = path.join(repo, "agreed-api.txt");
	fs.writeFileSync(evidencePath, "Existing agreed API evidence\n");
	snapshot.evidence.push({
		kind: "prior-plan",
		path: evidencePath,
		digest: "prior-evidence-digest",
	});
	const db = new Database(canonicalStorePath(repo));
	// Deterministic fixtures only: seed terminal history instead of invoking a
	// model, real host or production worker. SQL never targets a user store.
	db.query(
		"UPDATE workflow_runs SET status='blocked', capability_hash='' WHERE workflow_id=?",
	).run(snapshot.workflowId);
	db.query(
		"UPDATE workflow_outbox SET status='completed',lease=NULL,lease_expires_at=NULL WHERE workflow_id=?",
	).run(snapshot.workflowId);
	writeSnapshot(db, snapshot);
	db.close();
	if (structural) {
		const edit = new Database(canonicalStorePath(repo));
		edit
			.query("UPDATE workflow_runs SET step_id='old.step' WHERE workflow_id=?")
			.run(snapshot.workflowId);
		edit.close();
	}
	let executions = 0;
	const authority = createInstanceAuthority(
		"recovery-test",
		"test-instance-capability",
	);
	const ops = {
		view: () => engine.status(repo, snapshot.workflowId),
		runObservation: async (request: { kind: string }) =>
			request.kind === "workflow-targets"
				? [{ workflowId: snapshot.workflowId, target: repo }]
				: engine.previewRepair(repo, snapshot.workflowId),
		repair: (
			request: {
				revision: number;
				targetStep: string;
				reason?: string;
				recovery?: Extract<
					WorkflowCommand,
					{ type: "operator.repair" }
				>["recovery"];
			},
			options?: { principal?: "operator" | "orchestrator" },
		) => {
			const result = engine.dispatch(repo, {
				type: "operator.repair",
				workflowId: snapshot.workflowId,
				revision: request.revision,
				targetStep: request.targetStep,
				reason: request.reason ?? "",
				recovery: request.recovery,
				principal: options?.principal,
			});
			executions++;
			return result.view;
		},
	} as unknown as ServerOperations;
	const app = createServerApp({
		authority,
		operations: ops,
		events: new EventBroker(authority.instance),
		credentials: new CredentialRegistry(),
		configDir: root,
	});
	const token = orchestratorTokenFor(authority.token);
	const post = (route: string, body: unknown, capability = token) =>
		app.fetch(
			new Request(`http://localhost/api/v1/workflow/${route}`, {
				method: "POST",
				headers: {
					authorization: `Bearer ${capability}`,
					"content-type": "application/json",
				},
				body: JSON.stringify(body),
			}),
		);
	const inspect = async () => {
		const response = await post("recovery-preview", {
			repo,
			workflowId: snapshot.workflowId,
			revision: snapshot.revision,
		});
		expect(response.status).toBe(200);
		return ((await response.json()) as { value: WorkflowRecoveryPreview })
			.value;
	};
	const requestFor = (preview: WorkflowRecoveryPreview) => ({
		repo,
		workflowId: snapshot.workflowId,
		revision: preview.revision,
		targetStep: preview.targetStep,
		reason: "Supply agreed API references",
		recovery: {
			previewId: preview.previewId,
			operation: preview.operation,
			instruction:
				"Use the agreed boundary API; do not call agent_ask for the home orchestrator.",
		},
	});
	const mutate = (
		change: (snapshot: WorkflowSnapshot, db: Database) => void,
	) => {
		const db = new Database(canonicalStorePath(repo));
		const current = engine.getSnapshot(repo, snapshot.workflowId);
		change(current, db);
		writeSnapshot(db, current);
		db.close();
	};
	return {
		fetch: (request: Request) => app.fetch(request),
		token,
		repo,
		snapshot,
		engine: () => engine,
		reopen: () => {
			engine = new WorkflowEngine(registerBuiltins());
		},
		post,
		inspect,
		requestFor,
		mutate,
		executions: () => executions,
	};
}

describe("revision-bound orchestrator recovery", () => {
	test("home tools execute status → inspected preview → one-shot recovery over authenticated transport", async () => {
		const f = fixture();
		const request = f.requestFor(await f.inspect());
		const server = Bun.serve({
			hostname: "127.0.0.1",
			port: 0,
			fetch: f.fetch,
		});
		const faux = fauxProvider();
		const models = createModels();
		models.setProvider(faux.provider);
		const root = fs.mkdtempSync(path.join(os.tmpdir(), "recovery-tool-host-"));
		roots.push(root);
		const host = await DurableHost.open({
			layout: hostLayout(root),
			settings: {},
			globalAgentDir: root,
			storage: new MemoryStorage(),
			models,
			orchestrator: true,
		});
		try {
			await host.listen();
			const runEnvPath = path.join(root, "run.env");
			fs.writeFileSync(
				runEnvPath,
				`AGENTIC_ORCHESTRATOR_URL='http://127.0.0.1:${server.port}'\nAGENTIC_ORCHESTRATOR_TOKEN='${f.token}'\n`,
			);
			await host.ensureRun({
				runId: "orchestrator",
				name: "orchestrator",
				cwd: f.repo,
				runEnvPath,
				model: `${faux.getModel().provider}/${faux.getModel().id}`,
				toolPolicy: "orchestrator",
			});
			const identity = { repo: f.repo, workflowId: f.snapshot.workflowId };
			const calls = [
				fauxToolCall("workflow_status", identity),
				fauxToolCall("workflow_recovery_preview", {
					...identity,
					revision: request.revision,
				}),
				fauxToolCall("workflow_recover", {
					...identity,
					revision: request.revision,
					targetStep: request.targetStep,
					reason: request.reason,
					...request.recovery,
				}),
			];
			faux.setResponses([
				...calls.map((call) =>
					fauxAssistantMessage([call], { stopReason: "toolUse" }),
				),
				fauxAssistantMessage([fauxText("done")]),
			]);
			await host.submit(
				"orchestrator",
				"Retry the blocked agreed implementation with corrective API context",
				"recovery-test",
			);
			let results: unknown[] = [];
			for (let i = 0; i < 200; i++) {
				results = (await host.entriesForTest("orchestrator")).filter(
					(entry) => (entry as { kind?: string }).kind === "pi.tool-result",
				);
				if (results.length === 3) break;
				await Bun.sleep(20);
			}
			expect(results).toHaveLength(3);
			for (const result of results)
				expect(JSON.stringify(result)).not.toContain('"isError":true');
			expect(f.executions()).toBe(1);
			expect(
				f.engine().getSnapshot(f.repo, f.snapshot.workflowId).repaired?.recovery
					?.principal,
			).toBe("orchestrator");
		} finally {
			await host.shutdown();
			await server.stop(true);
		}
	});
	for (const structural of [false, true])
		test(
			structural
				? "structural missing-run preview/execution preserves evidence"
				: "blocked no-question/no-actions recovery delivers durable corrective assignment",
			async () => {
				const f = fixture(structural);
				const before = f.engine().status(f.repo, f.snapshot.workflowId);
				expect(before.availableActions).toEqual([]);
				expect(before.pendingQuestions ?? []).toEqual([]);
				expect(before.developerDialogue).toEqual([]);
				expect(before.recovery?.eligible).toBe(true);
				const compact = compactWorkflowStatusView(
					before as unknown as Record<string, unknown>,
				);
				expect((compact.recovery as { eligible: boolean }).eligible).toBe(true);
				expect(
					(
						summarizeWorkflowView(
							before as unknown as Record<string, unknown>,
						) as { recovery: unknown }
					).recovery,
				).toEqual(compact.recovery);
				expect(
					compactWorkflowStatus(before as unknown as Record<string, unknown>, {
						sinceRevision: before.revision,
					}),
				).toMatchObject({ unchanged: true, revision: before.revision });
				const preview = await f.inspect();
				expect(preview.operation).toBe(
					structural ? "structural-repair" : "retry-current",
				);
				expect(f.executions()).toBe(0);
				const request = f.requestFor(preview);
				const accepted = await f.post("repair", request);
				expect(accepted.status).toBe(200);
				expect(f.executions()).toBe(1);
				f.reopen();
				const after = f.engine().getSnapshot(f.repo, f.snapshot.workflowId);
				expect(after.step.attempt).toBe(f.snapshot.step.attempt + 1);
				expect(after.step.mode).toBe("fix");
				expect(after.step.context).toEqual({ boundary: "agreed-api" });
				expect(after.repaired?.recovery?.principal).toBe("orchestrator");
				expect(after.evidence).toEqual(f.snapshot.evidence);
				const replacement = f
					.engine()
					.status(f.repo, f.snapshot.workflowId)
					.runs.at(-1);
				if (!replacement) throw new Error("missing replacement run");
				const run = f.engine().getRun(f.repo, replacement.id);
				expect(recoveryAssignmentInput(after, run).join("\n")).toContain(
					request.recovery.instruction,
				);
				expect(
					recoveryAssignmentInput(after, { ...run, attempt: run.attempt + 1 }),
				).toEqual([]);
				const db = new Database(canonicalStorePath(f.repo));
				const history = db
					.query(
						"SELECT actor_json,data_json FROM workflow_events WHERE type='operator.repair'",
					)
					.get() as { actor_json: string; data_json: string };
				expect(history.actor_json).toContain("orchestrator");
				expect(history.data_json).toContain(request.recovery.instruction);
				expect(
					db
						.query(
							"SELECT count(*) AS n FROM workflow_runs WHERE status='blocked'",
						)
						.get(),
				).toEqual({ n: 1 });
				db.close();
				let assignment: LaunchContext["assignment"] | undefined;
				const adapter: AgentAdapter = {
					id: "pi-durable",
					preflight() {},
					launch: (ctx) => {
						assignment = ctx.assignment;
						return Effect.succeed({
							runtime: "pi-durable" as const,
							name: ctx.name,
							hostSocket: path.join(f.repo, "fake.sock"),
							sessionId: ctx.assignment.runId,
						});
					},
					prompt: () => Effect.void,
					observe: () => Effect.succeed({ status: "working" as const }),
					stop: () => Effect.void,
				};
				await new EffectRunner(
					f.repo,
					f.engine(),
					agentEffectHandlers(f.repo, f.engine(), {
						registry: f.engine().registry,
						adapters: new Map([["pi-durable", adapter]]),
					}),
				).drain();
				expect(assignment?.inputs.join("\n")).toContain(
					request.recovery.instruction,
				);
				expect(assignment?.inputs.join("\n")).toContain("agreed-api");
				expect((await f.post("repair", request)).status).not.toBe(200);
				expect(f.executions()).toBe(1);
			},
		);

	test("paused-only resume remains separate from recovery", async () => {
		const f = fixture();
		f.mutate((snapshot) => {
			snapshot.status = "paused";
		});
		expect((await f.inspect()).eligible).toBe(false);
		const resumed = f.engine().dispatch(f.repo, {
			type: "operator.resume",
			workflowId: f.snapshot.workflowId,
			revision: f.snapshot.revision,
		});
		expect(resumed.view.status).toBe("active");
		expect(resumed.snapshot.repaired?.recovery).toBeUndefined();
	});

	test("concurrent requests produce one replacement and one normal execution request", async () => {
		const f = fixture();
		const request = f.requestFor(await f.inspect());
		const responses = await Promise.all([
			f.post("repair", request),
			f.post("repair", request),
		]);
		expect(
			responses.filter((response) => response.status === 200),
		).toHaveLength(1);
		expect(f.executions()).toBe(1);
		expect(
			f.engine().getSnapshot(f.repo, f.snapshot.workflowId).step.attempt,
		).toBe(f.snapshot.step.attempt + 1);
	});

	test("instructions preserve reference formatting and mask secrets before durable context", async () => {
		const f = fixture();
		const request = f.requestFor(await f.inspect());
		request.recovery.instruction =
			"Use the agreed API:\n- retryCurrent()\napi_key=abc123";
		expect((await f.post("repair", request)).status).toBe(200);
		f.reopen();
		const record = f.engine().getSnapshot(f.repo, f.snapshot.workflowId)
			.repaired?.recovery;
		expect(record?.instruction).toContain("\n- retryCurrent()\n");
		expect(record?.instruction).not.toContain("abc123");
		expect(record?.instruction).toContain("<redacted>");
	});

	test("stale revision, mismatched preview, unsupported target and bounds fail without mutation", async () => {
		const f = fixture();
		const request = f.requestFor(await f.inspect());
		for (const change of [
			{ revision: request.revision - 1 },
			{ targetStep: "core.completed" },
			{ targetStep: "unknown" },
			{ reason: " " },
			{ reason: "x".repeat(161) },
			{ recovery: { ...request.recovery, previewId: "wrong" } },
			{ recovery: { ...request.recovery, instruction: " " } },
			{ recovery: { ...request.recovery, instruction: "x".repeat(8001) } },
		]) {
			expect(
				(await f.post("repair", { ...request, ...change })).status,
			).not.toBe(200);
		}
		expect(f.executions()).toBe(0);
		expect(f.engine().getSnapshot(f.repo, f.snapshot.workflowId).revision).toBe(
			request.revision,
		);
	});

	test("unknown clients, hidden/non-owned targets and actor spoofing cannot recover", async () => {
		const f = fixture();
		const request = f.requestFor(await f.inspect());
		expect(
			(
				await f.post(
					"repair",
					{ ...request, principal: "operator" },
					"worker-token",
				)
			).status,
		).toBe(401);
		expect(
			(await f.post("repair", { ...request, repo: "/hidden" })).status,
		).toBe(403);
		f.mutate((snapshot) => {
			snapshot.metadata.startedBy = "developer";
		});
		expect((await f.post("repair", request)).status).toBe(403);
		expect(f.executions()).toBe(0);
	});

	for (const step of [
		"core.plan-approval",
		"core.developer-review",
		"core.findings-review",
		"core.wiki-approval",
	])
		test(`human gate ${step} and skip-ahead cannot be bypassed`, () => {
			const f = fixture(
				false,
				step === "core.findings-review" ? "verify" : "openspec",
			);
			f.mutate((snapshot) => {
				snapshot.currentStep = step;
				snapshot.step.activeRunIds = [];
			});
			for (const targetStep of [step, "core.implementation", "core.delivery"])
				expect(() =>
					f.engine().dispatch(f.repo, {
						type: "operator.repair",
						workflowId: f.snapshot.workflowId,
						revision: f.snapshot.revision,
						targetStep,
						reason: "not an approval",
					}),
				).toThrow();
		});

	test("a leased-effect race invalidates inspection without expiring the claim", async () => {
		const f = fixture();
		const request = f.requestFor(await f.inspect());
		f.mutate((_snapshot, db) => {
			db.query(
				"UPDATE workflow_outbox SET status='running',lease='race',lease_expires_at='2099-01-01' WHERE kind='agent.launch'",
			).run();
		});
		expect((await f.post("repair", request)).status).not.toBe(200);
		expect(f.executions()).toBe(0);
	});

	test("live worker and debug-side runs refuse replacement", async () => {
		const f = fixture();
		const request = f.requestFor(await f.inspect());
		for (const step of ["core.implementation", "debug.investigate"]) {
			f.mutate((_snapshot, db) => {
				db.query("UPDATE workflow_runs SET status='working',step_id=?").run(
					step,
				);
			});
			expect((await f.post("repair", request)).status).not.toBe(200);
		}
		expect(f.executions()).toBe(0);
	});
});
