import { afterEach, expect, test } from "bun:test";
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
import { Schema } from "effect";
import { DurableHost } from "../src/agent-host/host.ts";
import { hostLayout } from "../src/agent-host/layout.ts";
import {
	decodeScheduling,
	type JobInput,
} from "../src/contracts/scheduling.ts";
import {
	schedulingAgentRequestSchema,
	schedulingResponseSchema,
} from "../src/contracts/scheduling-api.ts";
import { createServerApp } from "../src/server/app.ts";
import {
	createInstanceAuthority,
	orchestratorTokenFor,
} from "../src/server/auth.ts";
import { BackendClient } from "../src/server/client.ts";
import { CredentialRegistry } from "../src/server/credentials.ts";
import { EventBroker } from "../src/server/events.ts";
import type { SchedulingTargetAdapter } from "../src/server/scheduling/adapters.ts";
import { SchedulingApi } from "../src/server/scheduling/api.ts";
import { SchedulingService } from "../src/server/scheduling/service.ts";
import { SchedulingStore } from "../src/server/scheduling/store.ts";

const roots: string[] = [];
const stores: SchedulingStore[] = [];
afterEach(() => {
	for (const store of stores.splice(0)) store.close();
	for (const root of roots.splice(0))
		fs.rmSync(root, { recursive: true, force: true });
});
const job: JobInput = {
	name: "fixture",
	task: "observe fixture",
	originalInstruction: "observe later",
	reason: "test",
	references: [],
	reportingDestination: "fixture",
	target: {
		kind: "wake-up",
		hostId: "host",
		hostSocket: "fixture",
		runId: "run",
		conversationId: "1",
	},
};
const timing = {
	kind: "once" as const,
	at: new Date(2000).toISOString(),
	timezone: "UTC",
};
const schedule = {
	name: "once",
	timing,
	latePolicy: { kind: "run-late" as const },
};
function fixture(
	manualDestination?: ConstructorParameters<typeof SchedulingApi>[1],
) {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "scheduling-api-"));
	roots.push(root);
	const store = SchedulingStore.open(root);
	stores.push(store);
	let available = true;
	let now = 0;
	const adapter: SchedulingTargetAdapter = {
		resolve: async (candidate) => {
			if (!available) throw new Error("fixture destination unavailable");
			return candidate;
		},
		reserve: async (value) => ({
			id: value.id,
			digest: "fixture",
			state: "reserved",
		}),
		activate: async (value) => ({
			...(value.receipt ?? { id: value.id, digest: "fixture" }),
			state: "queued",
		}),
		query: async (value) => {
			if (!value.receipt) throw new Error("Missing fixture receipt");
			return value.receipt;
		},
	};
	const service = new SchedulingService(
		store,
		{ "wake-up": adapter, standalone: adapter, workflow: adapter },
		() => now,
	);
	const api = new SchedulingApi(service, manualDestination);
	const authority = createInstanceAuthority(
		"scheduling-test",
		"operator-test-token",
	);
	const app = createServerApp({
		authority,
		events: new EventBroker(authority.instance),
		credentials: new CredentialRegistry(),
		scheduling: api,
	});
	const post = (body: unknown, token = authority.token) =>
		app.fetch(
			new Request("http://localhost/api/v1/scheduling", {
				method: "POST",
				headers: {
					authorization: `Bearer ${token}`,
					"content-type": "application/json",
				},
				body: JSON.stringify(body),
			}),
		);
	return {
		root,
		app,
		api,
		store,
		service,
		post,
		authority,
		setNow: (value: number) => {
			now = value;
		},
		unavailable: () => {
			available = false;
		},
	};
}
test("validation exposes bounded actionable field issues without submitted values", async () => {
	const f = fixture();
	const sentinel = "PRIVATE-INVALID-INPUT";
	const response = await f.post({
		operation: "create",
		requestId: "bad-field",
		job: { ...job, name: 0, task: sentinel },
		schedule,
	});
	expect(response.status).toBe(400);
	const body = await response.json();
	expect(body.error.issues.length).toBeGreaterThan(0);
	expect(body.error.issues.length).toBeLessThanOrEqual(8);
	expect(
		body.error.issues.some((issue: { path: string }) =>
			issue.path.includes("job.name"),
		),
	).toBe(true);
	expect(JSON.stringify(body)).not.toContain(sentinel);
});
test("strict shared API authenticates, bounds pages and bodies, and never accepts authority in payloads", async () => {
	const f = fixture();
	expect((await f.post({ operation: "status" }, "forged")).status).toBe(401);
	expect(
		(await f.post({ operation: "status", principal: "operator" })).status,
	).toBe(400);
	expect((await f.post({ operation: "jobs.list", limit: 101 })).status).toBe(
		400,
	);
	expect((await f.post({ operation: "jobs.list", limit: 0 })).status).toBe(400);
	const oversized = await f.post({
		operation: "create",
		requestId: "oversized",
		job: { ...job, task: "x".repeat(270000) },
		schedule,
	});
	expect(oversized.status).toBe(400);
	expect(JSON.stringify(await oversized.json())).toContain(
		"request body is too large",
	);
	const response = await f.post(
		{ operation: "status" },
		orchestratorTokenFor(f.authority.token),
	);
	expect(response.status).toBe(200);
	const result = decodeScheduling(
		schedulingResponseSchema,
		(await response.json()).value,
	);
	expect(result.kind).toBe("status");
	if (result.kind === "status")
		expect(result.status).toMatchObject({
			machineWake: false,
			operatesOnlyWhileServiceRunning: true,
			pollingAllowanceMs: 5000,
		});
});
test("combined and reusable-job creation replay acknowledgements even if target validation later fails", async () => {
	const f = fixture();
	const combined = {
		operation: "create" as const,
		requestId: "combined",
		job,
		schedule,
	};
	const reusable = {
		operation: "jobs.create" as const,
		requestId: "reusable",
		job,
	};
	const created = await f.api.execute(combined, "orchestrator");
	const reusableCreated = await f.api.execute(reusable, "operator");
	decodeScheduling(schedulingResponseSchema, created);
	f.unavailable();
	expect(await f.api.execute(combined, "orchestrator")).toEqual(created);
	expect(await f.api.execute(reusable, "operator")).toEqual(reusableCreated);
	await expect(
		f.api.execute(
			{ ...combined, job: { ...job, task: "changed" } },
			"orchestrator",
		),
	).rejects.toMatchObject({ code: "conflict" });
	expect(f.store.listJobs()).toHaveLength(2);
	expect(f.store.listSchedules()).toHaveLength(1);
});
test("shared job updates require current fan-out confirmation, expected revision, and replay identity", async () => {
	const f = fixture();
	const j = f.store.createJob(job, 0);
	const a = f.store.createSchedule({ ...schedule, jobId: j.id }, 0);
	const b = f.store.createSchedule({ ...schedule, jobId: j.id }, 0);
	const update = {
		operation: "jobs.update" as const,
		requestId: "update",
		id: j.id,
		revision: j.revision,
		job: { ...job, task: "edited" },
		affectedSchedules: [a.id],
	};
	await expect(f.api.execute(update, "operator")).rejects.toMatchObject({
		code: "conflict",
	});
	expect(f.store.job(j.id).revision).toBe(1);
	const confirmed = { ...update, affectedSchedules: [a.id, b.id] };
	const result = await f.api.execute(confirmed, "operator");
	expect(result.kind).toBe("job");
	expect(await f.api.execute(confirmed, "operator")).toEqual(result);
	await expect(
		f.api.execute({ ...confirmed, requestId: "stale" }, "operator"),
	).rejects.toMatchObject({ code: "conflict" });
	expect(f.store.job(j.id).revision).toBe(2);
	await expect(
		f.api.execute(
			{ operation: "jobs.delete", requestId: "delete", id: j.id, revision: 2 },
			"operator",
		),
	).rejects.toMatchObject({ code: "conflict" });
});
test("mutation request keys are principal-scoped and changed operations cannot reuse them", async () => {
	const f = fixture();
	const request = { operation: "jobs.create", requestId: "same", job };
	const operator = await f.api.execute(request, "operator");
	const orchestrator = await f.api.execute(request, "orchestrator");
	expect(operator).not.toEqual(orchestrator);
	await expect(
		f.api.execute(
			{ operation: "create", requestId: "same", job, schedule },
			"operator",
		),
	).rejects.toMatchObject({ code: "conflict" });
	expect(f.store.listJobs()).toHaveLength(2);
});
test("history uses stable tuple pagination and actions replay without allocating another occurrence", async () => {
	const f = fixture();
	const j = f.store.createJob(job, 0);
	let s = f.store.createSchedule({ ...schedule, jobId: j.id }, 0);
	for (let index = 0; index < 3; index++) {
		const request = {
			operation: "schedules.action" as const,
			requestId: `run-${index}`,
			id: s.id,
			revision: s.revision,
			action: "run-now" as const,
		};
		const response = await f.api.execute(request, "operator");
		expect(await f.api.execute(request, "operator")).toEqual(response);
		if (response.kind !== "schedule") throw new Error("Expected schedule");
		s = response.schedule;
	}
	const first = await f.api.execute(
		{ operation: "history", scheduleId: s.id, limit: 2 },
		"operator",
	);
	if (first.kind !== "occurrences" || !first.nextCursor)
		throw new Error("Expected cursor");
	const second = await f.api.execute(
		{
			operation: "history",
			scheduleId: s.id,
			limit: 2,
			after: first.nextCursor,
		},
		"operator",
	);
	if (second.kind !== "occurrences") throw new Error("Expected history");
	expect(first.items).toHaveLength(2);
	expect(second.items).toHaveLength(1);
	expect(
		new Set([...first.items, ...second.items].map((value) => value.id)).size,
	).toBe(3);
	decodeScheduling(schedulingResponseSchema, first);
	expect(
		(
			await f.post({
				operation: "history",
				scheduleId: s.id,
				after: "not-a-cursor",
			})
		).status,
	).toBe(400);
});
test("writable standalone approval is operator-only, fenced, durable and idempotent", async () => {
	const f = fixture();
	const j = f.store.createJob(
		{
			...job,
			target: {
				kind: "standalone",
				repository: "fixture",
				model: "fixture/model",
				policy: "default",
				reviewPolicy: "human",
				baseBranch: "main",
			},
		},
		0,
	);
	const s = f.store.createSchedule({ ...schedule, jobId: j.id }, 0);
	const [occurrence] = f.store.reconcileDue(2000);
	if (!occurrence) throw new Error("Expected occurrence");
	const claim = f.store.claim(occurrence.id, 2000);
	if (!claim) throw new Error("Expected claim");
	f.store.transition(claim.id, claim.fence, "waiting-review", 2000);
	const request = {
		operation: "occurrences.approve",
		requestId: "approve",
		id: claim.id,
		fence: claim.fence,
	};
	expect(
		(await f.post(request, orchestratorTokenFor(f.authority.token))).status,
	).toBe(403);
	expect(f.store.occurrence(claim.id).state).toBe("waiting-review");
	await expect(
		f.api.execute({ ...request, fence: 0 }, "operator"),
	).rejects.toMatchObject({ code: "conflict" });
	const approved = await f.api.execute(request, "operator");
	expect(await f.api.execute(request, "operator")).toEqual(approved);
	expect(f.store.occurrence(claim.id)).toMatchObject({
		state: "reserved",
		approvedBy: "operator",
	});
	expect(f.store.activeForSchedule(s.id)).toHaveLength(1);
});

test("standalone policy and review choices cannot advertise unapproved writable execution", async () => {
	const f = fixture();
	for (const [policy, reviewPolicy] of [
		["default", "none"],
		["read-only", "human"],
	]) {
		const response = await f.post({
			operation: "jobs.create",
			requestId: `invalid-${policy}`,
			job: {
				...job,
				target: {
					kind: "standalone",
					repository: "/fixture",
					model: "fixture/model",
					baseBranch: "main",
					policy,
					reviewPolicy,
				},
			},
		});
		expect(response.status).toBe(400);
	}
	expect(f.store.listJobs()).toHaveLength(0);
});

test("relative once resolves only at first commit; local once refuses gaps and requires an explicit fold choice", async () => {
	const f = fixture();
	f.setNow(1000);
	const relative = {
		operation: "create",
		requestId: "relative",
		job,
		schedule: {
			...schedule,
			timing: { kind: "delay", delayMs: 3600000, timezone: "UTC" },
		},
	};
	const created = await f.api.execute(relative, "operator");
	if (created.kind !== "created") throw new Error("Expected creation");
	expect(created.schedule.timing).toMatchObject({
		kind: "once",
		at: new Date(3601000).toISOString(),
		sourceDelayMs: 3600000,
	});
	f.setNow(300000);
	expect(await f.api.execute(relative, "operator")).toEqual(created);
	const local = {
		kind: "local-once",
		local: "2026-11-01T01:30",
		timezone: "America/New_York",
	};
	expect((await f.post({ operation: "preview", timing: local })).status).toBe(
		400,
	);
	const earlier = await f.api.execute(
		{ operation: "preview", timing: { ...local, fold: "earlier" } },
		"operator",
	);
	const later = await f.api.execute(
		{ operation: "preview", timing: { ...local, fold: "later" } },
		"operator",
	);
	if (
		earlier.kind !== "preview" ||
		later.kind !== "preview" ||
		earlier.preview.timing.kind !== "once" ||
		later.preview.timing.kind !== "once"
	)
		throw new Error("Expected once previews");
	expect(
		Date.parse(later.preview.timing.at) - Date.parse(earlier.preview.timing.at),
	).toBe(3600000);
	expect(
		(
			await f.post({
				operation: "preview",
				timing: { ...local, local: "2026-03-08T02:30", fold: "earlier" },
			})
		).status,
	).toBe(400);
	expect(f.store.listSchedules()).toHaveLength(1);
});

test("manual destination initialization is operator-only and its pinned acknowledgement replays without another bootstrap", async () => {
	let bootstraps = 0;
	const target = {
		kind: "wake-up" as const,
		hostId: "manual-host",
		hostSocket: "/fixture",
		conversationId: "manual-conversation",
		runId: "orchestrator",
	};
	const f = fixture(async () => {
		bootstraps++;
		if (bootstraps > 1) throw new Error("destination no longer available");
		return target;
	});
	const request = { operation: "destination", requestId: "manual-destination" };
	expect(
		(await f.post(request, orchestratorTokenFor(f.authority.token))).status,
	).toBe(403);
	expect(bootstraps).toBe(0);
	const first = await f.post(request);
	expect(first.status).toBe(200);
	expect(
		decodeScheduling(schedulingResponseSchema, (await first.json()).value),
	).toEqual({ kind: "destination", target });
	const repeated = await f.post(request);
	expect(repeated.status).toBe(200);
	expect((await repeated.json()).value).toEqual({
		kind: "destination",
		target,
	});
	expect(bootstraps).toBe(1);
	expect(f.store.listJobs()).toHaveLength(0);
});

test("a pinned manual request cannot cross a same-URL store replacement", async () => {
	const original = fixture(),
		replacement = fixture();
	let app = original.app;
	const listener = Bun.serve({
		hostname: "127.0.0.1",
		port: 0,
		fetch: (request) => app.fetch(request),
	});
	try {
		const client = new BackendClient({
			baseUrl: `http://127.0.0.1:${listener.port}`,
			token: original.authority.token,
			ownerId: "store-binding-fixture",
		});
		const status = await client.scheduling({ operation: "status" });
		if (status.kind !== "status") throw new Error("Expected store identity");
		expect(status.status.storeId).toBe(original.store.identity);
		app = replacement.app;
		await expect(
			client.scheduling(
				{ operation: "create", requestId: "pinned", job, schedule },
				undefined,
				status.status.storeId,
			),
		).rejects.toMatchObject({ status: 409, code: "scheduling-store-changed" });
		expect(original.store.listJobs()).toHaveLength(0);
		expect(replacement.store.listJobs()).toHaveLength(0);
		const created = await client.scheduling(
			{ operation: "create", requestId: "new-store", job, schedule },
			undefined,
			replacement.store.identity,
		);
		expect(created.kind).toBe("created");
	} finally {
		await listener.stop(true);
	}
});

test("typed manual client and server share strict scheduling contracts over loopback", async () => {
	const f = fixture();
	const listener = Bun.serve({
		hostname: "127.0.0.1",
		port: 0,
		fetch: (request) => f.app.fetch(request),
	});
	try {
		const client = new BackendClient({
			baseUrl: `http://127.0.0.1:${listener.port}`,
			token: f.authority.token,
			ownerId: "scheduling-manual-fixture",
		});
		const status = await client.scheduling({ operation: "status" });
		expect(status.kind).toBe("status");
		const created = await client.scheduling({
			operation: "create",
			requestId: "manual",
			job,
			schedule,
		});
		if (created.kind !== "created") throw new Error("Expected creation");
		expect(Date.parse(created.preview.next[0]?.at ?? "")).toBe(
			Date.parse(timing.at),
		);
		expect(
			(
				await client.scheduling({
					operation: "schedules.get",
					id: created.schedule.id,
				})
			).kind,
		).toBe("schedule");
		await expect(
			client.scheduling({ operation: "jobs.list", limit: 101 }),
		).rejects.toMatchObject({ status: 400 });
	} finally {
		await listener.stop(true);
	}
});

test("native orchestrator scheduling tools pin the originating conversation and use shared API receipts", async () => {
	const f = fixture();
	// Named JSON Schema references prevent duplicated job/timing definitions from
	// bloating every model request; native regression cases retain the other tools.
	const metadata = JSON.stringify(
		Schema.toJsonSchemaDocument(schedulingAgentRequestSchema),
	);
	expect(metadata.length).toBeLessThan(10000);
	expect(metadata).not.toContain('"occurrences.approve"');
	expect(metadata).not.toContain('"destination"');
	const listener = Bun.serve({
		hostname: "127.0.0.1",
		port: 0,
		fetch: (request) => f.app.fetch(request),
	});
	const nativeDir = path.join(f.root, "native");
	fs.mkdirSync(nativeDir, { recursive: true });
	const faux = fauxProvider(),
		models = createModels();
	models.setProvider(faux.provider);
	const host = await DurableHost.open({
		layout: hostLayout(nativeDir),
		settings: {},
		globalAgentDir: nativeDir,
		storage: new MemoryStorage(),
		models,
		orchestrator: true,
	});
	try {
		await host.listen();
		const runEnvPath = path.join(nativeDir, "run.env");
		fs.writeFileSync(
			runEnvPath,
			`AGENTIC_ORCHESTRATOR_URL='http://127.0.0.1:${listener.port}'\nAGENTIC_ORCHESTRATOR_TOKEN='${orchestratorTokenFor(f.authority.token)}'\n`,
			{ mode: 0o600 },
		);
		const { conversationId } = await host.ensureRun({
			runId: "orchestrator",
			name: "orchestrator",
			cwd: nativeDir,
			runEnvPath,
			model: `${faux.getModel().provider}/${faux.getModel().id}`,
			toolPolicy: "orchestrator",
		});
		const pinned = {
			kind: "wake-up" as const,
			hostId: await host.scheduledIdentity(),
			hostSocket: hostLayout(nativeDir).socketPath,
			conversationId,
			runId: "orchestrator",
		};
		const request = {
			operation: "create",
			requestId: "native-create",
			job: { ...job, target: pinned },
			schedule,
		};
		const calls: Array<[string, Parameters<typeof fauxToolCall>[1]]> = [
			["scheduling_destination", {}],
			["scheduling", { request }],
			["scheduling", { request }],
			["scheduling", { request: { operation: "jobs.list", limit: 1 } }],
			[
				"scheduling",
				{
					request: {
						...request,
						requestId: "redirect",
						job: { ...job, target: { ...pinned, conversationId: "another" } },
					},
				},
			],
		];
		faux.setResponses([
			...calls.map(([name, args]) =>
				fauxAssistantMessage([fauxToolCall(name, args)], {
					stopReason: "toolUse",
				}),
			),
			fauxAssistantMessage([fauxText("done")]),
		]);
		await host.submit(
			"orchestrator",
			"schedule the fixture without executing it",
			"scheduling-fixture",
		);
		let results: Array<{ text: string; error: boolean }> = [];
		for (let attempt = 0; attempt < 200; attempt++) {
			results = (await host.entriesForTest("orchestrator")).flatMap((entry) => {
				const record = entry as {
					kind?: string;
					model?: Array<{
						content?: Array<{ text?: string }>;
						isError?: boolean;
					}>;
				};
				if (record.kind !== "pi.tool-result") return [];
				const message = record.model?.[0];
				return [
					{
						text: (message?.content ?? [])
							.map((block) => block.text ?? "")
							.join(""),
						error: message?.isError === true,
					},
				];
			});
			if (results.length >= calls.length) break;
			await Bun.sleep(20);
		}
		expect(results).toHaveLength(calls.length);
		expect(results[0]?.text).toContain(conversationId);
		expect(results[1]?.text).toContain('"kind":"created"');
		expect(results[2]?.text).toBe(results[1]?.text);
		expect(results[3]?.text).toContain('"kind":"jobs"');
		expect(results.slice(0, 4).every((value) => !value.error)).toBe(true);
		expect(results[4]?.text).toContain("differs from the calling session");
		expect(results[4]?.error).toBe(true);
		expect(f.store.listJobs()).toHaveLength(1);
		expect(f.store.listSchedules()).toHaveLength(1);
		expect(f.store.listJobs()[0]?.target).toEqual(pinned);
	} finally {
		await host.shutdown();
		await listener.stop(true);
	}
});
