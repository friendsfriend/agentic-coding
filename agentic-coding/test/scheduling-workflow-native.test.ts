import { Database } from "bun:sqlite";
import { expect, spyOn, test } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import { registerBuiltins } from "../src/workflow/definitions.ts";
import type { StartWorkflowInput } from "../src/workflow/runtime.ts";
import {
	canonicalStorePath,
	initializeStore,
	STORE_SCHEMA_VERSION,
	WorkflowEngine,
} from "../src/workflow/runtime.ts";
import {
	autoRemoveRepoFixtures,
	createTempRepoFixture,
	repoPreset,
} from "./support/git-fixture.ts";

autoRemoveRepoFixtures();
const owner = { occurrenceId: "occurrence-1", contentDigest: "a".repeat(64) };
const authority = { ...owner, admittedAt: 1000, fence: 1 };
function fixture(): { root: string; input: StartWorkflowInput } {
	const root = createTempRepoFixture("scheduled-native-", repoPreset.readme);
	return {
		root,
		input: {
			repo: root,
			workflowId: "schedule-occurrence-1",
			definitionId: "solo",
			metadata: {
				branch: "main",
				baseBranch: "main",
				baseCommit: "base",
				task: "add a flag",
			},
			routing: {
				defaultProfile: "fake",
				routes: [
					{
						stepId: "core.implementation",
						profile: {
							name: "fake",
							runtime: "pi-durable",
							executable: process.execPath,
							tools: [],
							extensions: [],
							readOnly: false,
							capabilities: ["prompt", "run-environment", "observe"],
							digest: "fake",
						},
					},
				],
			},
		},
	};
}
function counts(root: string) {
	const db = new Database(canonicalStorePath(root), { readonly: true });
	try {
		return {
			instances: db
				.query<{ n: number }, []>("SELECT count(*) n FROM workflow_instances")
				.get()?.n,
			runs: db
				.query<{ n: number }, []>("SELECT count(*) n FROM workflow_runs")
				.get()?.n,
			outbox: db
				.query<{ n: number }, []>("SELECT count(*) n FROM workflow_outbox")
				.get()?.n,
			starts: db
				.query<{ n: number }, []>(
					"SELECT count(*) n FROM workflow_events WHERE type='workflow.started'",
				)
				.get()?.n,
		};
	} finally {
		db.close();
	}
}
test("scheduled supported workflow executes a fake local runtime to its normal human gate and reopens without another start", () => {
	const { root, input } = fixture();
	input.definitionId = "no-openspec";
	input.metadata = {
		...input.metadata,
		gatePolicies: {
			planApproval: "always",
			developerReview: "always",
			wiki: "always",
		},
		startedBy: "orchestrator",
	};
	const profile = input.routing?.routes[0]?.profile;
	if (!profile) throw new Error("Missing fixture profile");
	input.routing = {
		defaultProfile: "fake",
		routes: ["core.implementation", "core.triage", "core.verification"].map(
			(stepId) => ({
				stepId,
				profile: {
					...profile,
					readOnly: stepId !== "core.implementation",
					capabilities:
						stepId === "core.implementation"
							? ["prompt", "run-environment", "observe"]
							: ["prompt", "run-environment", "observe", "read-only"],
				},
			}),
		),
	};
	const engine = new WorkflowEngine(registerBuiltins());
	engine.reserveScheduled(input, owner);
	engine.activateScheduled(root, authority);
	function complete(role: string, payload: unknown) {
		const view = engine.status(root, input.workflowId);
		const row = view.runs.find(
			(run) => run.role === role && run.status !== "completed",
		);
		if (!row) throw new Error(`Missing ${role} run at ${view.currentStep.id}`);
		const run = engine.getRun(root, row.id);
		const token = engine
			.claimEffects(root, 100)
			.find((effect) => effect.kind === "agent.launch")?.runToken;
		if (!token || !run.outputPath)
			throw new Error("Missing native launch authority/output");
		fs.mkdirSync(path.dirname(run.outputPath), {
			recursive: true,
			mode: 0o700,
		});
		fs.writeFileSync(
			run.outputPath,
			JSON.stringify({
				runId: run.id,
				schemaId: run.outputSchema?.id,
				schemaVersion: run.outputSchema?.version,
				payload,
			}),
			{ mode: 0o600 },
		);
		return engine.dispatch(root, {
			type: "agent.handoff",
			runId: run.id,
			generation: run.generation,
			token,
			outcome: "complete",
			artifact: run.outputPath,
		});
	}
	fs.appendFileSync(
		path.join(root, "README.md"),
		"Local fake implementation fixture.\n",
	);
	complete("worker", { changed: true });
	complete("triage", {
		roles: [
			{
				role: "quality-verifier",
				reason: "Fixture verification",
				files: ["README.md"],
			},
		],
	});
	complete("quality-verifier", { findings: [] });
	complete("test-verifier", { findings: [] });
	const view = engine.status(root, input.workflowId);
	expect(view.currentStep.id).toBe("core.developer-review");
	expect(view.waiting?.kind).toBe("approval");
	const reopened = new WorkflowEngine(registerBuiltins());
	expect(reopened.queryScheduled(root, owner).snapshot).toBeDefined();
	reopened.activateScheduled(root, authority);
	expect(reopened.status(root, input.workflowId).waiting).toEqual(view.waiting);
	expect(counts(root).starts).toBe(1);
	if (process.env.SCHEDULING_FIXTURE_EVIDENCE)
		fs.appendFileSync(
			process.env.SCHEDULING_FIXTURE_EVIDENCE,
			`${JSON.stringify({ fixture: "workflow", workflowId: input.workflowId, repository: root, currentStep: view.currentStep.id, waiting: view.waiting, starts: counts(root).starts })}\n`,
		);
});
test("native reservation is durable/non-runnable and rejects changed identity/content/input", () => {
	const { root, input } = fixture();
	const first = new WorkflowEngine(registerBuiltins());
	const receipt = first.reserveScheduled(input, owner);
	expect(counts(root)).toEqual({ instances: 0, runs: 0, outbox: 0, starts: 0 });
	const resumed = new WorkflowEngine(registerBuiltins());
	expect(resumed.queryScheduled(root, owner).reservation).toEqual(receipt);
	expect(resumed.reserveScheduled(input, owner)).toEqual(receipt);
	expect(() =>
		resumed.reserveScheduled(
			{ ...input, metadata: { ...input.metadata, task: "changed" } },
			owner,
		),
	).toThrow("input mismatch");
	expect(() =>
		resumed.reserveScheduled(input, {
			...owner,
			contentDigest: "b".repeat(64),
		}),
	).toThrow("mismatch");
	expect(() =>
		resumed.reserveScheduled(input, { ...owner, occurrenceId: "another" }),
	).toThrow("already owned");
	expect(() => resumed.start(input)).toThrow("scheduling reservation");
	expect(() =>
		resumed.activateScheduled(root, { ...authority, fence: 0 }),
	).toThrow("authority");
	expect(counts(root).instances).toBe(0);
});
test("activation and receipt are atomic; losing acknowledgement and reopening never starts twice", () => {
	const { root, input } = fixture();
	const before = new WorkflowEngine(registerBuiltins());
	before.reserveScheduled(input, owner);
	const lostAck = new WorkflowEngine(
		registerBuiltins(),
		() => new Date(2000),
		() => {
			throw new Error("fixture ack lost after commit");
		},
	);
	expect(() => lostAck.activateScheduled(root, authority)).toThrow("ack lost");
	const afterCommit = counts(root);
	expect(afterCommit.instances).toBe(1);
	expect(afterCommit.outbox).toBeGreaterThan(0);
	const recovered = new WorkflowEngine(registerBuiltins());
	const result = recovered.activateScheduled(root, { ...authority, fence: 2 });
	expect(result.view.schedulingOrigin).toEqual({
		occurrenceId: owner.occurrenceId,
		contentDigest: owner.contentDigest,
		admittedAt: 1000,
	});
	expect(recovered.queryScheduled(root, owner).snapshot?.workflowId).toBe(
		input.workflowId,
	);
	expect(counts(root)).toEqual(afterCommit);
	expect(() =>
		recovered.activateScheduled(root, { ...authority, admittedAt: 999 }),
	).toThrow("authority mismatch");
	expect(() =>
		recovered.activateScheduled(root, {
			...authority,
			contentDigest: "b".repeat(64),
		}),
	).toThrow("mismatch");
});
test("failure during native activation rolls back instance, outbox and activation receipt together", () => {
	const { root, input } = fixture();
	const engine = new WorkflowEngine(registerBuiltins());
	engine.reserveScheduled(input, owner);
	const db = new Database(canonicalStorePath(root));
	db.exec(
		"CREATE TRIGGER fixture_abort BEFORE INSERT ON workflow_outbox BEGIN SELECT RAISE(ABORT,'fixture interrupted activation'); END",
	);
	db.close();
	expect(() => engine.activateScheduled(root, authority)).toThrow(
		"fixture interrupted activation",
	);
	expect(counts(root).instances).toBe(0);
	expect(counts(root).outbox).toBe(0);
	expect(
		engine.queryScheduled(root, owner).reservation.activatedAt,
	).toBeUndefined();
	const repair = new Database(canonicalStorePath(root));
	repair.exec("DROP TRIGGER fixture_abort");
	repair.close();
	expect(
		new WorkflowEngine(registerBuiltins()).activateScheduled(root, authority)
			.view.workflowId,
	).toBe(input.workflowId);
});
test("ordinary workflow cannot be attached and ordinary starts cannot forge native origin", () => {
	const { input } = fixture();
	const engine = new WorkflowEngine(registerBuiltins());
	engine.start(input);
	expect(() => engine.reserveScheduled(input, owner)).toThrow("already owned");
	const other = fixture();
	expect(() =>
		engine.start({
			...other.input,
			metadata: {
				...other.input.metadata,
				schedulingOrigin: { ...owner, admittedAt: 1000 },
			},
		}),
	).toThrow("native-engine owned");
});
test("v6 backup stays on the held directory when the canonical ancestor is replaced", () => {
	const { root, input } = fixture();
	new WorkflowEngine(registerBuiltins()).start(input);
	const file = canonicalStorePath(root),
		directory = path.dirname(file),
		held = `${directory}-held`,
		foreign = path.join(root, "foreign");
	const db = new Database(file);
	db.exec("DROP TABLE workflow_scheduled_reservations; PRAGMA user_version=6");
	db.close();
	fs.mkdirSync(foreign);
	const exec = Database.prototype.exec;
	let replaced = false;
	const interception = spyOn(Database.prototype, "exec").mockImplementation(
		function (this: Database, sql: string) {
			const result = exec.call(this, sql);
			if (sql === "BEGIN IMMEDIATE" && !replaced) {
				replaced = true;
				fs.renameSync(directory, held);
				fs.symlinkSync(foreign, directory);
			}
			return result;
		},
	);
	try {
		try {
			initializeStore(root);
		} catch {
			/* Refusing a rebound store is also safe. */
		}
		expect(replaced).toBe(true);
		expect(fs.readdirSync(foreign)).toEqual([]);
		const backups = fs
			.readdirSync(held)
			.filter((name) => name.includes(".before-v7-"));
		expect(backups).toHaveLength(1);
		const backup = backups[0];
		if (!backup) throw new Error("Missing confined backup");
		const snapshot = new Database(path.join(held, backup), { readonly: true });
		try {
			expect(
				snapshot
					.query<{ user_version: number }, []>("PRAGMA user_version")
					.get()?.user_version,
			).toBe(6);
			expect(
				snapshot.query("SELECT id FROM workflow_instances").all(),
			).toHaveLength(1);
		} finally {
			snapshot.close();
		}
	} finally {
		interception.mockRestore();
		if (replaced) {
			fs.unlinkSync(directory);
			fs.renameSync(held, directory);
		}
	}
});

test("v6 upgrade takes a private pre-upgrade snapshot and preserves native rows", () => {
	const { root, input } = fixture();
	const engine = new WorkflowEngine(registerBuiltins());
	engine.start(input);
	const oldCounts = counts(root);
	const db = new Database(canonicalStorePath(root));
	db.exec("DROP TABLE workflow_scheduled_reservations; PRAGMA user_version=6");
	db.close();
	initializeStore(root);
	expect(counts(root)).toEqual(oldCounts);
	const upgraded = new Database(canonicalStorePath(root), { readonly: true });
	expect(
		upgraded.query<{ user_version: number }, []>("PRAGMA user_version").get()
			?.user_version,
	).toBe(STORE_SCHEMA_VERSION);
	upgraded.close();
	const directory = path.dirname(canonicalStorePath(root));
	const backups = fs
		.readdirSync(directory)
		.filter((name) => name.includes(".before-v7-"));
	expect(backups).toHaveLength(1);
	const backup = backups[0];
	if (!backup) throw new Error("fixture backup absent");
	const file = path.join(directory, backup);
	expect(fs.statSync(file).mode & 0o777).toBe(0o600);
	const snapshot = new Database(file, { readonly: true });
	expect(
		snapshot.query<{ user_version: number }, []>("PRAGMA user_version").get()
			?.user_version,
	).toBe(6);
	expect(
		snapshot.query("SELECT id FROM workflow_instances").all(),
	).toHaveLength(1);
	snapshot.close();
	initializeStore(root);
	expect(
		fs.readdirSync(directory).filter((name) => name.includes(".before-v7-")),
	).toHaveLength(1);
});
