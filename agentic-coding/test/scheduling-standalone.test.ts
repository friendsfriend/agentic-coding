import { expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
	createModels,
	fauxAssistantMessage,
	fauxProvider,
	fauxText,
} from "@earendil-works/pi-ai";
import { HostClient } from "../src/agent-host/client.ts";
import { DurableHost } from "../src/agent-host/host.ts";
import { hostLayout } from "../src/agent-host/layout.ts";
import { SchedulingInfrastructureError } from "../src/server/scheduling/adapters.ts";
import { SchedulingService } from "../src/server/scheduling/service.ts";
import { standaloneAdapter } from "../src/server/scheduling/standalone.ts";
import { SchedulingStore } from "../src/server/scheduling/store.ts";

// Only the IPC transport is replaced. Reservations, submissions, model turns,
// receipts and reopen all run against the real native durable host.
class LocalClient extends HostClient {
	readonly native: DurableHost;
	constructor(native: DurableHost, socket: string) {
		super(socket);
		this.native = native;
	}
	override async ensureRun(input: Parameters<HostClient["ensureRun"]>[0]) {
		const result = await this.native.ensureRun(input);
		return { type: "ensureRun" as const, runId: input.runId, ...result };
	}
	override async recoverRun(input: Parameters<HostClient["recoverRun"]>[0]) {
		const result = await this.ensureRun(input);
		if (result.conversationId !== input.expectedConversationId)
			throw new Error("Native recovery changed conversation identity");
		return result;
	}
	override scheduledIdentity() {
		return this.native.scheduledIdentity();
	}
	override async scheduledAdmission(
		input: Parameters<HostClient["scheduledAdmission"]>[0],
	): ReturnType<HostClient["scheduledAdmission"]> {
		return {
			type: "scheduledAdmission",
			receipt: await this.native.scheduledAdmission(
				input.operation,
				input.envelope,
				input.fence,
			),
		};
	}
}
function git(cwd: string, ...args: string[]) {
	const result = Bun.spawnSync(["git", "-C", cwd, ...args], {
		env: {
			...process.env,
			GIT_AUTHOR_NAME: "Fixture",
			GIT_AUTHOR_EMAIL: "fixture@example.invalid",
			GIT_COMMITTER_NAME: "Fixture",
			GIT_COMMITTER_EMAIL: "fixture@example.invalid",
		},
	});
	if (result.exitCode !== 0) throw new Error(result.stderr.toString());
	return result.stdout.toString().trim();
}

test("slow standalone preparation spanning lease replacement converges to one native admission", async () => {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "scheduling-preparation-")),
		repository = path.join(dir, "repository"),
		root = path.join(dir, "scheduling");
	fs.mkdirSync(repository);
	git(repository, "init", "-b", "main");
	git(repository, "commit", "--allow-empty", "-m", "fixture");
	const faux = fauxProvider(),
		model = `${faux.getModel().provider}/${faux.getModel().id}`,
		hosts = new Map<string, DurableHost>();
	faux.setResponses([
		fauxAssistantMessage([fauxText("One slow preparation report.")]),
	]);
	let release = () => {},
		entered = () => {},
		preparations = 0,
		activations = 0,
		now = 1000;
	const gate = new Promise<void>((r) => {
			release = r;
		}),
		ready = new Promise<void>((r) => {
			entered = r;
		});
	const adapter = standaloneAdapter(root, {
		catalog: async () => ({
			models: [model],
			thinkingLevels: DurableHost.THINKING_LEVELS,
		}),
		prepareWorktree: async (repo, branch, cwd, base) => {
			preparations++;
			entered();
			await gate;
			git(repo, "worktree", "add", "-b", branch, cwd, base);
		},
		startHost: async (runtimeDir) => {
			let host = hosts.get(runtimeDir);
			if (!host) {
				const models = createModels();
				models.setProvider(faux.provider);
				host = await DurableHost.open({
					layout: hostLayout(runtimeDir),
					settings: {},
					globalAgentDir: path.join(dir, "pi"),
					models,
				});
				hosts.set(runtimeDir, host);
			}
			return new LocalClient(host, hostLayout(runtimeDir).socketPath);
		},
	});
	const wrapped = {
			...adapter,
			activate: async (v: Parameters<typeof adapter.activate>[0]) => {
				activations++;
				return adapter.activate(v);
			},
		},
		adapters = { "wake-up": wrapped, standalone: wrapped, workflow: wrapped };
	const a = SchedulingStore.open(root),
		b = SchedulingStore.open(root),
		sa = new SchedulingService(a, adapters, () => now),
		sb = new SchedulingService(b, adapters, () => now);
	let first: Promise<void> | undefined;
	try {
		const job = a.createJob(
				{
					name: "slow",
					task: "Report fixture",
					originalInstruction: "Report later",
					reason: "test",
					references: [],
					reportingDestination: "transcript",
					target: {
						kind: "standalone",
						repository,
						baseBranch: "main",
						model,
						policy: "read-only",
						reviewPolicy: "none",
					},
				},
				0,
			),
			schedule = a.createSchedule(
				{
					name: "once",
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
		first = sa.tick();
		await ready;
		now = 32000;
		await sb.tick();
		const occurrence = b.history(schedule.id)[0];
		if (!occurrence) throw new Error("Missing occurrence");
		expect(occurrence.state).toBe("pending");
		expect(activations).toBe(0);
		expect(preparations).toBe(1);
		release();
		await first;
		now = 34000;
		await sb.tick();
		for (
			let i = 0;
			i < 200 && b.occurrence(occurrence.id).state !== "succeeded";
			i++
		) {
			await Bun.sleep(10);
			now += 31000;
			await sb.tick();
		}
		expect(b.occurrence(occurrence.id).state).toBe("succeeded");
		expect(b.occurrence(occurrence.id).receipt?.result).toBe(
			"One slow preparation report.",
		);
		expect(activations).toBe(1);
		expect(preparations).toBe(1);
		expect(hosts.size).toBe(1);
		expect(
			git(repository, "branch", "--list", "schedule/*").split("\n"),
		).toHaveLength(1);
	} finally {
		release();
		await first;
		await sa.stop();
		await sb.stop();
		for (const host of hosts.values()) await host.shutdown();
		a.close();
		b.close();
		fs.rmSync(dir, { recursive: true, force: true });
	}
}, 15000);

test("isolated standalone report survives lost acknowledgement and host/store reopen without a new target", async () => {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "scheduling-standalone-")),
		repository = path.join(dir, "repository"),
		config = path.join(dir, "config"),
		root = path.join(config, "scheduling");
	fs.mkdirSync(repository, { mode: 0o700 });
	git(repository, "init", "-b", "main");
	fs.writeFileSync(
		path.join(repository, "fixture.txt"),
		"isolated scheduling fixture\n",
	);
	git(repository, "add", "fixture.txt");
	git(repository, "commit", "-m", "fixture");
	// Read-only scheduling must not execute a repository's checkout hook.
	fs.writeFileSync(
		path.join(repository, ".git", "hooks", "post-checkout"),
		"#!/bin/sh\nexit 42\n",
		{ mode: 0o700 },
	);
	const faux = fauxProvider(),
		model = `${faux.getModel().provider}/${faux.getModel().id}`,
		hosts = new Map<string, DurableHost>();
	faux.setResponses([
		fauxAssistantMessage([fauxText("Independent fixture report complete.")]),
	]);
	let store = SchedulingStore.open(root),
		now = 1000,
		lost = true;
	const adapter = standaloneAdapter(root, {
		configDir: config,
		catalog: async () => ({
			models: [model],
			thinkingLevels: DurableHost.THINKING_LEVELS,
		}),
		startHost: async (runtimeDir, cwd) => {
			let host = hosts.get(runtimeDir);
			if (!host) {
				const models = createModels();
				models.setProvider(faux.provider);
				host = await DurableHost.open({
					layout: hostLayout(runtimeDir),
					settings: {},
					globalAgentDir: path.join(dir, "pi"),
					models,
				});
				hosts.set(runtimeDir, host);
			}
			expect(fs.readFileSync(path.join(cwd, "fixture.txt"), "utf8")).toBe(
				"isolated scheduling fixture\n",
			);
			return new LocalClient(host, hostLayout(runtimeDir).socketPath);
		},
	});
	const wrapped = {
		...adapter,
		async activate(value: Parameters<typeof adapter.activate>[0]) {
			const result = await adapter.activate(value);
			if (lost) {
				lost = false;
				throw new SchedulingInfrastructureError(
					"Fixture lost activation acknowledgement",
				);
			}
			return result;
		},
	};
	const adapters = {
		"wake-up": wrapped,
		standalone: wrapped,
		workflow: wrapped,
	};
	let service = new SchedulingService(store, adapters, () => now);
	try {
		const job = store.createJob(
			{
				name: "Independent report",
				task: "Report the isolated fixture; do not modify it.",
				originalInstruction: "Report later",
				reason: "Local recovery fixture",
				references: [],
				reportingDestination: "transcript",
				target: {
					kind: "standalone",
					repository,
					baseBranch: "main",
					model,
					policy: "read-only",
					reviewPolicy: "none",
				},
			},
			0,
		);
		const schedule = store.createSchedule(
			{
				name: "once",
				jobId: job.id,
				timing: {
					kind: "once",
					at: new Date(now).toISOString(),
					timezone: "UTC",
				},
				latePolicy: { kind: "run-late" },
			},
			0,
		);
		await service.tick();
		const [first] = store.history(schedule.id);
		if (!first?.receipt?.agent)
			throw new Error("Missing standalone reservation");
		expect(first.state).toBe("reconciling");
		const firstAgent = first.receipt.agent,
			runtimeDir = path.join(root, "agents", first.id),
			worktree = path.join(runtimeDir, "worktree"),
			host = hosts.get(runtimeDir);
		if (!host) throw new Error("Missing native fixture host");
		expect(git(worktree, "branch", "--show-current")).toBe(
			`schedule/${first.id}`,
		);
		for (
			let i = 0;
			i < 200 && (await host.status(firstAgent.runId)).status !== "idle";
			i++
		)
			await Bun.sleep(10);
		const completed = await adapter.query(first);
		expect(completed.state).toBe("succeeded");
		expect(completed.result).toBe("Independent fixture report complete.");
		expect(completed.submission?.id).toBeDefined();
		await service.stop();
		await host.shutdown();
		hosts.delete(runtimeDir);
		store.close();
		store = SchedulingStore.open(root);
		now = 32000;
		service = new SchedulingService(store, adapters, () => now);
		await service.tick();
		const recovered = store.occurrence(first.id);
		expect(recovered.state).toBe("succeeded");
		expect(recovered.receipt?.agent).toEqual(firstAgent);
		expect(recovered.receipt?.submission).toEqual(completed.submission);
		expect(recovered.receipt?.result).toBe(completed.result);
		if (!recovered.receipt) throw new Error("Missing recovered receipt");
		await expect(
			adapter.query({
				...recovered,
				receipt: {
					...recovered.receipt,
					agent: { ...firstAgent, hostId: "wrong-host" },
				},
			}),
		).rejects.toThrow("identity changed");
		await expect(
			adapter.query({
				...recovered,
				receipt: {
					...recovered.receipt,
					agent: { ...firstAgent, conversationId: "wrong-conversation" },
				},
			}),
		).rejects.toThrow("temporarily unavailable");
		expect((await adapter.query(recovered)).submission).toEqual(
			completed.submission,
		);
		const artifact = JSON.parse(fs.readFileSync(firstAgent.outputPath, "utf8"));
		expect(artifact.output).toBe(completed.result);
		expect(artifact.submission).toEqual(completed.submission);
		expect(fs.statSync(firstAgent.outputPath).mode & 0o777).toBe(0o600);
		await service.tick();
		expect(store.history(schedule.id)).toHaveLength(1);
		expect(git(repository, "status", "--porcelain")).toBe("");
		const evidence = process.env.SCHEDULING_FIXTURE_EVIDENCE;
		if (evidence)
			fs.appendFileSync(
				evidence,
				`${JSON.stringify({ target: "standalone", occurrenceId: first.id, receipt: recovered.receipt, artifact })}\n`,
				{ mode: 0o600 },
			);
	} finally {
		await service.stop();
		store.close();
		for (const host of hosts.values()) await host.shutdown();
		fs.rmSync(dir, { recursive: true, force: true });
	}
}, 15000);
