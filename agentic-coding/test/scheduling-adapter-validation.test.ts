import { afterEach, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { JobInput } from "../src/contracts/scheduling.ts";
import {
	SchedulingDestinationUnavailable,
	SchedulingInfrastructureError,
} from "../src/server/scheduling/adapters.ts";
import { createSchedulingRuntime } from "../src/server/scheduling/runtime.ts";
import { standaloneAdapter } from "../src/server/scheduling/standalone.ts";
import { SchedulingStore } from "../src/server/scheduling/store.ts";
import { wakeUpAdapter } from "../src/server/scheduling/wake-up.ts";
import { workflowAdapter } from "../src/server/scheduling/workflow.ts";
import { registerBuiltins } from "../src/workflow/definitions.ts";
import { WorkflowEngine } from "../src/workflow/runtime.ts";

const roots: string[] = [],
	stores: SchedulingStore[] = [];
afterEach(() => {
	for (const store of stores.splice(0)) store.close();
	for (const root of roots.splice(0))
		fs.rmSync(root, { recursive: true, force: true });
});
function fixture(target: JobInput["target"]) {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "scheduling-validation-"));
	roots.push(root);
	const store = SchedulingStore.open(path.join(root, "scheduling"));
	stores.push(store);
	const job = store.createJob(
		{
			name: "fixture",
			task: "Observe only",
			originalInstruction: "Observe later",
			reason: "validation",
			references: [],
			reportingDestination: "transcript",
			target,
		},
		0,
	);
	const schedule = store.createSchedule(
		{
			name: "fixture",
			jobId: job.id,
			timing: {
				kind: "once",
				at: new Date(1000).toISOString(),
				timezone: "UTC",
			},
			latePolicy: { kind: "run-late" },
		},
		0,
	);
	const [occurrence] = store.reconcileDue(1000);
	if (!occurrence) throw new Error("Missing occurrence");
	return { root, store, job, schedule, occurrence };
}
const wake: JobInput["target"] = {
	kind: "wake-up",
	hostId: "host",
	hostSocket: "fixture",
	conversationId: "original",
	runId: "original",
};
test("missing pinned wake-up destinations never create or redirect a conversation", async () => {
	const { job, occurrence } = fixture(wake),
		seen: string[] = [];
	const adapter = wakeUpAdapter(async (value) => {
		if (value.target.kind !== "wake-up") throw new Error("Invalid target");
		seen.push(value.target.conversationId);
		throw new Error("original missing");
	});
	await expect(adapter.resolve(job)).rejects.toBeInstanceOf(
		SchedulingDestinationUnavailable,
	);
	for (const operation of [adapter.reserve, adapter.activate, adapter.query])
		await expect(operation(occurrence)).rejects.toBeInstanceOf(
			SchedulingDestinationUnavailable,
		);
	expect(seen).toEqual(["original", "original", "original", "original"]);
});
test("standalone removed models, invalid thinking, branches and authority fail without starting a host", async () => {
	const { root, job, occurrence } = fixture({
		kind: "standalone",
		repository: "/fixture",
		baseBranch: "main",
		model: "fixture/model",
		policy: "read-only",
		reviewPolicy: "none",
	});
	const repository = path.join(root, "repository");
	fs.mkdirSync(repository, { mode: 0o700 });
	for (const args of [
		["init", "-b", "main"],
		[
			"-c",
			"user.name=Fixture",
			"-c",
			"user.email=fixture@example.invalid",
			"commit",
			"--allow-empty",
			"-m",
			"fixture",
		],
	]) {
		const result = Bun.spawnSync([
			"git",
			"-c",
			"core.hooksPath=/dev/null",
			"-C",
			repository,
			...args,
		]);
		if (result.exitCode !== 0) throw new Error(result.stderr.toString());
	}
	if (job.target.kind !== "standalone") throw new Error("Invalid target");
	const valid = { ...job, target: { ...job.target, repository } };
	let models = ["fixture/model"],
		starts = 0;
	const adapter = standaloneAdapter(root, {
		catalog: async () => ({ models, thinkingLevels: ["off"] }),
		startHost: async () => {
			starts++;
			throw new Error("Host must not start");
		},
	});
	expect((await adapter.resolve(valid)).target).toEqual({
		...valid.target,
		repository: fs.realpathSync(repository),
	});
	models = [];
	await expect(adapter.resolve(valid)).rejects.toBeInstanceOf(
		SchedulingDestinationUnavailable,
	);
	models = ["fixture/model"];
	await expect(
		adapter.resolve({
			...valid,
			target: { ...valid.target, thinking: "invalid" },
		}),
	).rejects.toThrow("thinking level");
	await expect(
		adapter.resolve({
			...valid,
			target: { ...valid.target, baseBranch: "missing-fixture-branch" },
		}),
	).rejects.toThrow("validation failed");
	await expect(adapter.activate(occurrence)).rejects.toThrow("authority");
	await expect(adapter.query(occurrence)).rejects.toThrow("receipt required");
	await expect(
		adapter.query({
			...occurrence,
			receipt: {
				id: occurrence.id,
				digest: "fixture",
				state: "running",
				agent: {
					hostSocket: "unrelated",
					hostId: "unrelated",
					runId: "unrelated",
					conversationId: "unrelated",
					outputPath: "unrelated",
				},
			},
		}),
	).rejects.toBeInstanceOf(SchedulingDestinationUnavailable);
	expect(starts).toBe(0);
});
test("workflow invalid settings and an unavailable native store never bypass the normal start path", async () => {
	const { root, job, occurrence } = fixture({
		kind: "workflow",
		repository: "/fixture",
		workflowType: "missing-fixture-definition",
		preset: "missing-fixture-preset",
		mode: "worktree",
		sourceBranch: "main",
	});
	const runtime = new WorkflowEngine(registerBuiltins());
	let requests = 0;
	const adapter = workflowAdapter(
		() => runtime,
		() => {
			requests++;
		},
	);
	await expect(adapter.resolve(job)).rejects.toThrow();
	await expect(adapter.reserve(occurrence)).rejects.toThrow();
	await expect(adapter.activate(occurrence)).rejects.toThrow("authority");
	await expect(adapter.query(occurrence)).rejects.toThrow("receipt required");
	await expect(
		adapter.query({
			...occurrence,
			receipt: {
				id: occurrence.id,
				digest: "fixture",
				state: "reserved",
				workflow: { repository: root, workflowId: "unrelated" },
			},
		}),
	).rejects.toBeInstanceOf(SchedulingInfrastructureError);
	expect(requests).toBe(0);
});
test("server-owned lifecycle stops and reopens the same store without a TUI or host bootstrap", async () => {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "scheduling-lifecycle-"));
	roots.push(root);
	const options = {
		configDir: root,
		server: () => {
			throw new Error("No host bootstrap allowed");
		},
		publish: () => {},
	};
	const first = createSchedulingRuntime(options),
		identity = first.api.service.store.identity;
	try {
		expect(first.api.service.status().available).toBe(false);
		first.start();
		expect(first.api.service.status().available).toBe(true);
		expect(first.api.service.status().machineWake).toBe(false);
	} finally {
		await first.stop();
	}
	expect(first.api.service.status().available).toBe(false);
	const second = createSchedulingRuntime(options);
	try {
		expect(second.api.service.store.identity).toBe(identity);
		expect(second.api.service.status().available).toBe(false);
	} finally {
		await second.stop();
	}
});

test("workflow adapter pins validated configuration and all human gates across preset removal", async () => {
	const { root, store, job, schedule } = fixture({
		kind: "workflow",
		repository: "/fixture",
		workflowType: "wiki",
		preset: "fixed",
		mode: "checkout",
		sourceBranch: "main",
	});
	const repository = path.join(root, "repository");
	fs.mkdirSync(repository, { mode: 0o700 });
	for (const args of [
		["init", "-b", "main"],
		[
			"-c",
			"user.name=Fixture",
			"-c",
			"user.email=fixture@example.invalid",
			"commit",
			"--allow-empty",
			"-m",
			"fixture",
		],
	]) {
		const result = Bun.spawnSync([
			"git",
			"-c",
			"core.hooksPath=/dev/null",
			"-C",
			repository,
			...args,
		]);
		if (result.exitCode !== 0) throw new Error(result.stderr.toString());
	}
	const config = path.join(root, "config.json"),
		previous = process.env.HERDR_WORKFLOW_CONFIG;
	process.env.HERDR_WORKFLOW_CONFIG = config;
	const agents = {
		default_profile: "fixture",
		profiles: { fixture: { runtime: "pi-durable", executable: "/bin/true" } },
		presets: {
			fixed: {
				default_profile: "fixture",
				pools: {
					"core.wiki": [{ label: "only", profile: "fixture", default: true }],
					"core.research": [
						{ label: "only", profile: "fixture", default: true },
					],
				},
			},
		},
	};
	fs.writeFileSync(config, JSON.stringify({ agents }));
	try {
		if (job.target.kind !== "workflow") throw new Error("Invalid target");
		const updated = store.updateJob(
			job.id,
			1,
			{
				name: job.name,
				task: job.task,
				originalInstruction: job.originalInstruction,
				reason: job.reason,
				references: job.references,
				reportingDestination: job.reportingDestination,
				target: { ...job.target, repository },
			},
			1000,
		);
		const runtime = new WorkflowEngine(registerBuiltins());
		let requests = 0;
		const adapter = workflowAdapter(
			() => runtime,
			() => {
				requests++;
			},
		);
		const { occurrence: manual } = store.action(
			schedule.id,
			1,
			"run-now",
			1000,
			"configured-job",
		);
		if (!manual) throw new Error("Missing configured occurrence");
		const claim = store.claim(manual.id, 1000);
		if (!claim) throw new Error("Missing claim");
		const value = store.resolveJob(
			claim.id,
			claim.fence,
			await adapter.resolve(updated.job),
		);
		const receipt = await adapter.reserve(value);
		store.transition(value.id, value.fence, "reserved", 1000, { receipt });
		const admitted = store.authorize(value.id, value.fence, 1000);
		fs.writeFileSync(
			config,
			JSON.stringify({ agents: { ...agents, presets: {} } }),
		);
		await expect(adapter.resolve(updated.job)).rejects.toThrow();
		const active = await adapter.activate(admitted);
		expect(active.workflow?.workflowId).toBe(`schedule-${value.id}`);
		if (!active.workflow) throw new Error("Missing native workflow");
		const view = runtime.queryScheduled(active.workflow.repository, {
			occurrenceId: value.id,
			contentDigest: receipt.digest,
		}).snapshot;
		if (!view) throw new Error("Missing native snapshot");
		expect(view.metadata.gatePolicies).toEqual({
			planApproval: "always",
			developerReview: "always",
			verification: "always",
			wiki: "always",
		});
		expect(view.metadata.startedBy).toBe("orchestrator");
		expect(
			(await adapter.query({ ...admitted, receipt: active })).workflow,
		).toEqual(active.workflow);
		expect(
			store
				.history(schedule.id)
				.filter((value) => value.admittedAt !== undefined),
		).toHaveLength(1);
		expect(requests).toBe(1);
	} finally {
		if (previous === undefined) delete process.env.HERDR_WORKFLOW_CONFIG;
		else process.env.HERDR_WORKFLOW_CONFIG = previous;
	}
});
