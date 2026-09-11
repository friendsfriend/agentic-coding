import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type {
	ResolvedProfile,
	WorkflowRouting,
} from "../src/workflow/contracts.ts";
import { registerBuiltins } from "../src/workflow/definitions.ts";
import { canonicalStorePath, WorkflowEngine } from "../src/workflow/runtime.ts";

type TelemetryEvent = Record<string, string | number | boolean | undefined> & {
	event: string;
};

function repository(root: string): string {
	fs.mkdirSync(root, { recursive: true });
	execFileSync("git", ["init", "-q", "-b", "main"], { cwd: root });
	execFileSync("git", ["config", "user.email", "test@example.com"], {
		cwd: root,
	});
	execFileSync("git", ["config", "user.name", "Test"], { cwd: root });
	fs.writeFileSync(path.join(root, "README.md"), "test\n");
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
		routes: ["core.implementation", "core.triage", "core.verification"].map(
			(stepId) => ({ stepId, profile }),
		),
	};
}

function readTelemetry(repo: string, workflowId: string): TelemetryEvent[] {
	const file = path.join(
		repo,
		".herdr-workflow",
		workflowId,
		"telemetry.jsonl",
	);
	if (!fs.existsSync(file)) return [];
	return fs
		.readFileSync(file, "utf8")
		.split("\n")
		.filter((line) => line.trim())
		.map((line) => JSON.parse(line) as TelemetryEvent);
}

function requireEvent(events: TelemetryEvent[], name: string): TelemetryEvent {
	const event = events.find((item) => item.event === name);
	if (!event) throw new Error(`expected telemetry event ${name}`);
	return event;
}

test("engine dispatch telemetry carries identity and payload fields", () => {
	const root = repository(
		fs.mkdtempSync(path.join(os.tmpdir(), "engine-telemetry-")),
	);
	try {
		const engine = new WorkflowEngine(
			registerBuiltins(),
			() => new Date("2026-01-01T00:00:00Z"),
		);
		const started = engine.start({
			repo: root,
			workflowId: "telemetry-flow",
			definitionId: "no-openspec",
			metadata: {
				branch: "feature/x",
				baseBranch: "main",
				baseCommit: "abc123",
				task: "do the thing",
			},
			routing: routing(),
		});
		const startedEvent = requireEvent(
			readTelemetry(root, "telemetry-flow"),
			"workflow.started",
		);
		expect(startedEvent["herdr.definition.id"]).toBe("no-openspec");
		expect(startedEvent["herdr.task.length"]).toBe("do the thing".length);
		expect(startedEvent["herdr.status"]).toBe("active");

		const runSummary = started.view.runs[0];
		if (!runSummary) throw new Error("expected a worker run");
		const run = engine.getRun(root, runSummary.id);
		const launch = engine
			.claimEffects(root)
			.find(
				(effect) =>
					effect.kind === "agent.launch" &&
					(effect.payload as { runId?: string }).runId === run.id,
			);
		if (!launch) throw new Error("expected an agent.launch effect");
		engine.dispatch(root, {
			type: "effect.result",
			effectId: launch.id,
			lease: launch.lease ?? "",
			outcome: "complete",
			data: {
				runtime: "pi",
				name: "worker",
				paneId: "pane",
				sessionId: "session-1",
			},
			durationMs: 123,
		});
		const effectEvent = requireEvent(
			readTelemetry(root, "telemetry-flow"),
			"effect.result",
		);
		expect(effectEvent.effectId).toBe(launch.id);
		expect(effectEvent["herdr.effect.kind"]).toBe("agent.launch");
		expect(effectEvent["herdr.effect.attempt"]).toBe(1);
		expect(effectEvent["herdr.effect.max_attempts"]).toBe(4);
		expect(effectEvent["herdr.status"]).toBe("active");
		// The measured handler wall clock is reported and, because no run was
		// resolved for this effect, no misleading run attempt is emitted.
		expect(effectEvent.durationMs).toBe(123);
		expect(effectEvent["herdr.run.attempt"]).toBeUndefined();

		const token = engine.issueRunCapability(root, run.id);
		engine.dispatch(root, {
			type: "agent.handoff",
			runId: run.id,
			generation: run.generation,
			token,
			outcome: "blocked",
			message: "needs help",
		});
		const events = readTelemetry(root, "telemetry-flow");
		const handoff = requireEvent(events, "agent.handoff");
		expect(handoff.runId).toBe(run.id);
		expect(handoff.role).toBe("worker");
		expect(handoff["herdr.run.attempt"]).toBe(run.attempt);
		expect(handoff.profile).toBe("test");
		expect(handoff.runtime).toBe("pi");
		expect(handoff.sessionId).toBe("session-1");
		expect(handoff["herdr.handoff.outcome"]).toBe("blocked");
		expect(handoff["herdr.evidence.count"]).toBeTypeOf("number");

		const rollup = requireEvent(events, "workflow.rollup");
		expect(rollup["herdr.attention.count"]).toBeGreaterThanOrEqual(1);
		expect(rollup["herdr.current.step"]).toBe("core.implementation");
		expect(rollup["herdr.run.count"]).toBeGreaterThanOrEqual(1);
		// Exactly one roll-up for the one terminal transition.
		expect(
			events.filter((item) => item.event === "workflow.rollup"),
		).toHaveLength(1);
	} finally {
		fs.rmSync(root, { recursive: true, force: true });
	}
});

test("effect exhaustion exports the durable event and one roll-up", () => {
	const root = repository(
		fs.mkdtempSync(path.join(os.tmpdir(), "engine-exhausted-")),
	);
	try {
		const engine = new WorkflowEngine(
			registerBuiltins(),
			() => new Date("2026-01-01T00:00:00Z"),
		);
		engine.start({
			repo: root,
			workflowId: "telemetry-exhausted",
			definitionId: "no-openspec",
			metadata: {
				branch: "feature/x",
				baseBranch: "main",
				baseCommit: "abc123",
				task: "task",
			},
			routing: routing(),
		});
		const launch = engine
			.claimEffects(root)
			.find((effect) => effect.kind === "agent.launch");
		if (!launch) throw new Error("expected an agent.launch effect");
		const db = new Database(canonicalStorePath(root));
		db.query(
			"UPDATE workflow_outbox SET attempts=max_attempts, lease_expires_at=? WHERE id=?",
		).run("2020-01-01T00:00:00.000Z", launch.id);
		db.close();
		engine.claimEffects(root);
		const events = readTelemetry(root, "telemetry-exhausted");
		const exhausted = requireEvent(events, "effect.exhausted");
		expect(exhausted.effectId).toBe(launch.id);
		expect(exhausted["herdr.effect.kind"]).toBe("agent.launch");
		expect(exhausted["herdr.effect.max_attempts"]).toBe(4);
		expect(exhausted["herdr.attention.count"]).toBeGreaterThanOrEqual(1);
		expect(exhausted.outcome).toBe("error");
		expect(
			events.filter((item) => item.event === "workflow.rollup"),
		).toHaveLength(1);
	} finally {
		fs.rmSync(root, { recursive: true, force: true });
	}
});

test("multiple exhausted effects export one roll-up for the workflow", () => {
	const root = repository(
		fs.mkdtempSync(path.join(os.tmpdir(), "engine-multi-exhausted-")),
	);
	try {
		const engine = new WorkflowEngine(
			registerBuiltins(),
			() => new Date("2026-01-01T00:00:00Z"),
		);
		engine.start({
			repo: root,
			workflowId: "telemetry-multi-exhausted",
			definitionId: "no-openspec",
			metadata: {
				branch: "feature/x",
				baseBranch: "main",
				baseCommit: "abc123",
				task: "task",
			},
			routing: routing(),
		});
		const launch = engine
			.claimEffects(root)
			.find((effect) => effect.kind === "agent.launch");
		if (!launch) throw new Error("expected an agent.launch effect");
		const db = new Database(canonicalStorePath(root));
		const revision = (
			db
				.query("SELECT revision FROM workflow_instances WHERE id=?")
				.get("telemetry-multi-exhausted") as { revision: number }
		).revision;
		db.query(
			"INSERT INTO workflow_outbox VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)",
		).run(
			randomUUID(),
			"telemetry-multi-exhausted",
			revision,
			"agent.stop",
			"stop-1",
			JSON.stringify({
				runId: (launch.payload as { runId?: string }).runId,
			}),
			"running",
			4,
			4,
			null,
			"2020-01-01T00:00:00.000Z",
			null,
			null,
		);
		db.query(
			"UPDATE workflow_outbox SET attempts=max_attempts, lease_expires_at=? WHERE id=?",
		).run("2020-01-01T00:00:00.000Z", launch.id);
		db.close();
		engine.claimEffects(root);
		const events = readTelemetry(root, "telemetry-multi-exhausted");
		expect(
			events.filter((item) => item.event === "effect.exhausted"),
		).toHaveLength(2);
		expect(
			events.filter((item) => item.event === "workflow.rollup"),
		).toHaveLength(1);
	} finally {
		fs.rmSync(root, { recursive: true, force: true });
	}
});

test("engine effect error class redacts credentials", () => {
	const root = repository(
		fs.mkdtempSync(path.join(os.tmpdir(), "engine-redact-")),
	);
	try {
		const engine = new WorkflowEngine(
			registerBuiltins(),
			() => new Date("2026-01-01T00:00:00Z"),
		);
		engine.start({
			repo: root,
			workflowId: "telemetry-redact",
			definitionId: "no-openspec",
			metadata: {
				branch: "feature/x",
				baseBranch: "main",
				baseCommit: "abc123",
				task: "task",
			},
			routing: routing(),
		});
		const launch = engine
			.claimEffects(root)
			.find((effect) => effect.kind === "agent.launch");
		if (!launch) throw new Error("expected an agent.launch effect");
		engine.dispatch(root, {
			type: "effect.result",
			effectId: launch.id,
			lease: launch.lease ?? "",
			outcome: "retry",
			data: [
				"push failed for https://user:ghp_abcdefghijklmnopqrstuvwxyz0123456789@example.com/repo.git",
				"token sk-abcdefghijklmnopqrstuvwxyz",
			].join(" "),
		});
		const event = requireEvent(
			readTelemetry(root, "telemetry-redact"),
			"effect.result",
		);
		const errorClass = String(event["herdr.error.class"] ?? "");
		expect(errorClass).not.toContain("ghp_");
		expect(errorClass).not.toContain("sk-abcdef");
		expect(errorClass).toContain("[REDACTED]");
	} finally {
		fs.rmSync(root, { recursive: true, force: true });
	}
});

test("legacy migration exports the legacy.migrated event", () => {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "engine-legacy-"));
	try {
		execFileSync("git", ["init", "-q", "-b", "main"], { cwd: root });
		fs.mkdirSync(path.dirname(canonicalStorePath(root)), { recursive: true });
		const db = new Database(canonicalStorePath(root), { create: true });
		db.exec(
			"CREATE TABLE IF NOT EXISTS workflows(change_id TEXT PRIMARY KEY,state TEXT NOT NULL)",
		);
		db.query("INSERT INTO workflows VALUES (?,?)").run(
			"legacy-change",
			JSON.stringify({
				changeId: "legacy-change",
				phase: "apply",
				repository: root,
				worktree: root,
				branch: "feature/legacy",
				baseBranch: "main",
				baseCommit: "abc",
				workflowType: "no-openspec",
				panes: { worker: "stale" },
			}),
		);
		db.close();
		const engine = new WorkflowEngine(registerBuiltins());
		engine.initialize(root, "legacy-change");
		const view = engine
			.list(root)
			.find((item) => item.definition.id === "no-openspec");
		if (!view) throw new Error("expected the migrated workflow");
		const events = readTelemetry(root, view.workflowId);
		const migrated = requireEvent(events, "legacy.migrated");
		expect(migrated["herdr.source.version"]).toBe(0);
		expect(migrated["herdr.migration.phase"]).toBe("apply");
		expect(migrated["herdr.workflow.type"]).toBe("no-openspec");
	} finally {
		fs.rmSync(root, { recursive: true, force: true });
	}
});
