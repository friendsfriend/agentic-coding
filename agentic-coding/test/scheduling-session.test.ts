import { afterEach, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { TargetReceipt } from "../src/contracts/scheduling.ts";
import {
	bindDurableSession,
	createDurableSession,
	deleteDurableSession,
	durableSessionOwner,
	initializeDurableSessions,
	readDurableSessionRegistry,
} from "../src/pi-durable-registry.ts";
import { piDurableRuntimeDir } from "../src/pi-durable-state.ts";
import { SchedulingApi } from "../src/server/scheduling/api.ts";
import { SchedulingService } from "../src/server/scheduling/service.ts";
import { workflowlessSessionAdapter } from "../src/server/scheduling/session.ts";
import { SchedulingStore } from "../src/server/scheduling/store.ts";

const roots: string[] = [],
	stores: SchedulingStore[] = [];
afterEach(() => {
	for (const store of stores.splice(0)) store.close();
	for (const root of roots.splice(0))
		fs.rmSync(root, { force: true, recursive: true });
});
test("scheduler sends a synthetic digest only into the exact persisted collection session and retains native receipt provenance after restart", async () => {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "schedule-session-"));
	roots.push(root);
	const configDir = path.join(root, "config"),
		runtimeDir = piDurableRuntimeDir(configDir),
		owner = durableSessionOwner();
	const initial = initializeDurableSessions(runtimeDir, root, owner);
	const session = createDurableSession(runtimeDir, {
		operationId: "fixture",
		name: "Daily task digest",
		owner,
		cwd: fs.realpathSync(root),
		model: "fake/model",
		thinking: "low",
		toolPolicy: "collection",
	});
	bindDurableSession(runtimeDir, session.id, owner, {
		hostId: "fake-host",
		conversationId: "digest-conversation",
	});
	let opens = 0,
		admissions = 0;
	const deliveries: string[] = [],
		receipts = new Map<string, TargetReceipt>();
	const adapter = workflowlessSessionAdapter(configDir, {
		models: async () => ["fake/model"],
		validateBase: async () => {},
		open: async (options) => {
			expect(options?.sessionId).toBe(session.id);
			expect(options?.select).toBe(false);
			opens++;
			return {
				runId: session.runId,
				sessionId: session.id,
				hostSocket: "fake-only",
			};
		},
		client: () => ({
			scheduledAdmission: async (request) => {
				expect(request.envelope.expectedHostId).toBe("fake-host");
				expect(request.envelope.expectedConversationId).toBe(
					"digest-conversation",
				);
				const prior = receipts.get(request.envelope.occurrenceId);
				if (request.operation === "query" && prior)
					return { type: "scheduledAdmission", receipt: prior };
				if (request.operation === "activate" && prior?.state !== "succeeded") {
					admissions++;
					deliveries.push(request.envelope.text);
				}
				const receipt: TargetReceipt = {
					id: request.envelope.occurrenceId,
					digest: request.envelope.digest,
					state: request.operation === "reserve" ? "reserved" : "succeeded",
					...(request.operation !== "reserve"
						? {
								submission: {
									id: "native-receipt",
									conversationId: "digest-conversation",
									inputEntryId: "input",
									answerEntryId: "answer",
								},
								result: "Synthetic digest visible in native transcript",
							}
						: {}),
				};
				receipts.set(request.envelope.occurrenceId, receipt);
				return { type: "scheduledAdmission", receipt };
			},
		}),
	});
	const directory = path.join(root, "scheduler"),
		store = SchedulingStore.open(directory);
	stores.push(store);
	const job = store.createJob(
		{
			name: "daily",
			task: "Collect synthetic evidence only",
			originalInstruction: "fixture",
			reason: "fixture",
			references: [],
			reportingDestination: session.id,
			target: {
				kind: "standalone",
				policy: "read-only",
				reviewPolicy: "none",
				repository: root,
				baseBranch: "main",
				model: "fake/model",
				thinking: "low",
				destination: {
					kind: "workflowless-session",
					sessionId: session.id,
					owner,
					hostId: "fake-host",
					conversationId: "digest-conversation",
				},
			},
		},
		0,
	);
	await adapter.resolve(job);
	const schedule = store.createSchedule(
		{
			name: "fake",
			jobId: job.id,
			timing: {
				kind: "once",
				at: new Date(86_401_000).toISOString(),
				timezone: "UTC",
			},
			latePolicy: { kind: "run-late" },
		},
		0,
	);
	const adapters = {
		"wake-up": adapter,
		standalone: adapter,
		workflow: adapter,
	};
	if (
		job.target.kind !== "standalone" ||
		job.target.policy !== "read-only" ||
		!job.target.destination
	)
		throw new Error("fixture target missing");
	const destination = job.target.destination;
	for (const replacement of [
		{ hostId: "replaced-store" },
		{ conversationId: "replaced-conversation" },
	]) {
		await expect(
			adapter.resolve({
				...job,
				target: {
					...job.target,
					destination: { ...destination, ...replacement },
				},
			}),
		).rejects.toThrow("binding/settings changed");
	}
	expect(opens).toBe(0);
	const service = new SchedulingService(store, adapters, () => 86_402_000);
	await expect(
		new SchedulingApi(service).execute(
			{
				operation: "jobs.create",
				requestId: "foreign-custody",
				job: {
					name: job.name,
					task: job.task,
					originalInstruction: job.originalInstruction,
					reason: job.reason,
					references: job.references,
					reportingDestination: job.reportingDestination,
					target: job.target,
				},
			},
			"orchestrator",
		),
	).rejects.toThrow("authenticated operator");
	await expect(
		workflowlessSessionAdapter(configDir, { models: async () => [] }).resolve(
			job,
		),
	).rejects.toThrow("model unavailable");
	await service.tick();
	await service.tick();
	expect(store.history(schedule.id)).toMatchObject([{ state: "succeeded" }]);
	expect(admissions).toBe(1);
	expect(deliveries[0]).toContain("1970-01-02T00:00:01.000Z");
	expect(
		store.history(schedule.id)[0]?.receipt?.submission?.answerEntryId,
	).toBe("answer");
	expect(readDurableSessionRegistry(runtimeDir)?.activeId).toBe(
		initial.activeId,
	);
	await service.stop();
	const reopened = SchedulingStore.open(directory);
	stores.push(reopened);
	const recovered = new SchedulingService(reopened, adapters, () => 86_403_000);
	await recovered.tick();
	await recovered.stop();
	expect(admissions).toBe(1);
	expect(opens).toBeGreaterThan(0);
	deleteDurableSession(runtimeDir, session.id, owner);
	await expect(adapter.resolve(job)).rejects.toThrow("deleted or unavailable");
	const foreign = {
		...job,
		target: {
			...job.target,
			destination: {
				kind: "workflowless-session" as const,
				sessionId: session.id,
				owner: "uid:foreign",
				hostId: "fake-host",
				conversationId: "digest-conversation",
			},
		},
	};
	await expect(adapter.resolve(foreign)).rejects.toThrow("custody");
});
