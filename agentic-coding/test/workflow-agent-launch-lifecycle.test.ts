import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type {
	WorkflowEffect,
	WorkflowRun,
	WorkflowSnapshot,
} from "../src/contracts/workflow.ts";
import {
	definitionVersionForPolicy,
	registerBuiltins,
} from "../src/workflow/definitions.ts";
import type {
	CompiledWorkflowDefinition,
	WorkflowRegistry,
} from "../src/workflow/registry.ts";
import {
	effectEligibility,
	effectRetryEligibility,
} from "../src/workflow/runtime/effect-eligibility.ts";
import {
	canonicalStorePath,
	researchWorkflowTarget,
	WorkflowEngine,
} from "../src/workflow/runtime.ts";

// Pure row fixtures: no store, configuration, credentials or provider is opened.
// Admission commit -> claim -> ensure -> submit -> publication are distinct
// boundaries. These tests cover eligibility, not remote-admission fencing.
function fixture() {
	const snapshot = {
		workflowId: "fixture",
		currentStep: "core.implementation",
		status: "active",
		definition: { id: "spec-driven" },
		step: { attempt: 2, activeRunIds: ["run"] },
		developerDialogue: [],
	} as unknown as WorkflowSnapshot;
	const run = {
		id: "run",
		workflowId: "fixture",
		stepId: "core.implementation",
		generation: 2,
		attempt: 2,
		status: "pending",
		role: "worker",
	} as WorkflowRun;
	const effect = {
		id: "launch",
		revision: 1,
		idempotencyKey: "fixture-launch",
		attempts: 1,
		maxAttempts: 3,
		workflowId: "fixture",
		kind: "agent.launch",
		payload: { runId: "run" },
		status: "failed",
	} as WorkflowEffect;
	const definition = {
		initial: "core.plan",
		steps: ["core.plan", "core.implementation"],
		edges: [],
	} as unknown as CompiledWorkflowDefinition;
	const registry = {
		stepForDefinition: () => ({
			allowedEffects: ["agent.launch", "agent.prompt", "artifact.write"],
		}),
	} as unknown as WorkflowRegistry;
	return { snapshot, run, effect, definition, registry };
}

test("obsolete failed launch is hidden and direct retry refuses atomically", () => {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "obsolete-launch-"));
	const previous = process.env.HERDR_WIKI_DIR;
	process.env.HERDR_WIKI_DIR = path.join(root, "wiki");
	try {
		const engine = new WorkflowEngine(registerBuiltins(undefined, 6));
		const repo = researchWorkflowTarget();
		const profile = {
			name: "fixture",
			runtime: "pi-durable" as const,
			executable: "pi-durable",
			tools: ["read"],
			extensions: [],
			readOnly: true,
			capabilities: [
				"prompt",
				"run-environment",
				"observe",
				"read-only",
			] as const,
			digest: "fixture",
		};
		engine.start({
			repo,
			workflowId: "obsolete-launch",
			definitionId: "research",
			definitionVersion: definitionVersionForPolicy(6),
			metadata: { branch: "", baseBranch: "", baseCommit: "", task: "fixture" },
			routing: {
				defaultProfile: profile.name,
				routes: [{ stepId: "core.research", role: "researcher", profile }],
			},
		});
		const setup = engine
			.claimEffects(repo)
			.find((effect) => effect.kind === "workspace.setup");
		if (!setup?.lease) throw new Error("fixture setup missing");
		engine.dispatch(repo, {
			type: "effect.result",
			effectId: setup.id,
			lease: setup.lease,
			outcome: "complete",
		});
		const db = new Database(canonicalStorePath(repo));
		try {
			const launch = db
				.query("SELECT id FROM workflow_outbox WHERE kind='agent.launch'")
				.get() as { id: string } | null;
			if (!launch) throw new Error("fixture launch missing");
			db.query(
				"UPDATE workflow_outbox SET status='failed',last_error='original fixture failure' WHERE id=?",
			).run(launch.id);
			// An obsolete non-active historical run can coexist with a valid new
			// attempt. Failure history stays present, but is not retry authority.
			const snapshot = engine.getSnapshot(repo, "obsolete-launch");
			db.query("UPDATE workflow_runs SET status='expired'").run();
			snapshot.step.activeRunIds = [];
			db.query("UPDATE workflow_instances SET snapshot_json=? WHERE id=?").run(
				JSON.stringify(snapshot),
				snapshot.workflowId,
			);
			const view = engine.status(repo, snapshot.workflowId);
			expect(
				view.availableActions.some(
					(action) => action.id === `retry-effect:${launch.id}`,
				),
			).toBe(false);
			const before = db
				.query("SELECT * FROM workflow_outbox WHERE id=?")
				.get(launch.id);
			const revision = view.revision;
			expect(() =>
				engine.dispatch(repo, {
					type: "developer.action",
					workflowId: snapshot.workflowId,
					revision,
					actionId: `retry-effect:${launch.id}`,
				}),
			).toThrow("retry unavailable");
			expect(engine.status(repo, snapshot.workflowId).revision).toBe(revision);
			expect(
				db.query("SELECT * FROM workflow_outbox WHERE id=?").get(launch.id),
			).toEqual(before);
		} finally {
			db.close();
		}
	} finally {
		if (previous === undefined) delete process.env.HERDR_WIKI_DIR;
		else process.env.HERDR_WIKI_DIR = previous;
		fs.rmSync(root, { recursive: true, force: true });
	}
});

describe("durable launch lifecycle eligibility", () => {
	for (const kind of [
		"agent.launch",
		"agent.prompt",
		"artifact.write",
	] as const) {
		for (const defect of [
			"missing",
			"expired",
			"failed",
			"completed",
			"wrong-step",
			"wrong-attempt",
			"wrong-generation",
			"superseded",
			"wrong-workflow",
		] as const) {
			test(`${kind}: refuses ${defect} without changing history`, () => {
				const f = fixture();
				f.effect.kind = kind;
				if (defect === "wrong-step") f.run.stepId = "core.plan";
				else if (defect === "wrong-attempt") f.run.attempt = 1;
				else if (defect === "wrong-generation") f.run.generation = 1;
				else if (defect === "superseded") f.snapshot.step.activeRunIds = [];
				else if (defect === "wrong-workflow") f.run.workflowId = "another";
				else if (defect !== "missing") f.run.status = defect;
				const rows = defect === "missing" ? [] : [f.run];
				const before = JSON.stringify(f);
				expect(
					effectRetryEligibility(
						f.effect,
						f.snapshot,
						f.definition,
						rows,
						f.registry,
					).eligible,
				).toBe(false);
				expect(
					effectEligibility(
						f.effect,
						f.snapshot,
						f.definition,
						rows,
						f.registry,
					).eligible,
				).toBe(false);
				expect(JSON.stringify(f)).toBe(before);
			});
		}
	}
	test("repeat attempts admit only the current active identity", () => {
		const f = fixture();
		for (let attempt = 2; attempt < 8; attempt++) {
			f.snapshot.step.attempt = attempt;
			f.run.attempt = attempt;
			f.run.generation = attempt;
			expect(
				effectRetryEligibility(
					f.effect,
					f.snapshot,
					f.definition,
					[f.run],
					f.registry,
				).eligible,
			).toBe(true);
			const retired = {
				...f.run,
				id: `retired-${attempt}`,
				status: "expired" as const,
			};
			expect(
				effectRetryEligibility(
					{ ...f.effect, payload: { runId: retired.id } },
					f.snapshot,
					f.definition,
					[retired, f.run],
					f.registry,
				).eligible,
			).toBe(false);
		}
	});
	test("addressed historical consults and stop barriers survive step replacement", () => {
		const f = fixture();
		f.run.status = "completed";
		f.run.stepId = "core.plan";
		f.snapshot.developerDialogue = [
			{ id: "question", targetRunId: f.run.id },
		] as WorkflowSnapshot["developerDialogue"];
		expect(
			effectEligibility(
				{
					...f.effect,
					kind: "agent.prompt",
					payload: { runId: f.run.id, questionId: "question" },
				},
				f.snapshot,
				f.definition,
				[f.run],
				f.registry,
			).eligible,
		).toBe(true);
		expect(
			effectEligibility(
				{ ...f.effect, kind: "agent.stop" },
				f.snapshot,
				f.definition,
				[f.run],
				f.registry,
			).eligible,
		).toBe(true);
	});
	test("cancelled launch is a cleanup barrier, never a retry action", () => {
		const f = fixture();
		f.run.status = "expired";
		f.effect.payload = { runId: f.run.id, cancelRequested: true };
		expect(
			effectEligibility(f.effect, f.snapshot, f.definition, [f.run], f.registry)
				.eligible,
		).toBe(true);
		expect(
			effectRetryEligibility(
				f.effect,
				f.snapshot,
				f.definition,
				[f.run],
				f.registry,
			).eligible,
		).toBe(false);
	});
});
