import { afterEach, expect, spyOn, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { JobInput, TargetReceipt } from "../src/contracts/scheduling.ts";
import { EventBroker } from "../src/server/events.ts";
import {
	SchedulingInfrastructureError,
	type SchedulingTargetAdapter,
} from "../src/server/scheduling/adapters.ts";
import { SchedulingApi } from "../src/server/scheduling/api.ts";
import { SchedulingService } from "../src/server/scheduling/service.ts";
import { SchedulingStore } from "../src/server/scheduling/store.ts";

const roots: string[] = [],
	stores: SchedulingStore[] = [];
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
function fixture() {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "scheduling-service-"));
	roots.push(root);
	const store = SchedulingStore.open(root);
	stores.push(store);
	const j = store.createJob(job, 0),
		schedule = store.createSchedule(
			{
				name: "once",
				jobId: j.id,
				timing: {
					kind: "once",
					at: new Date(1000).toISOString(),
					timezone: "UTC",
				},
				latePolicy: { kind: "run-late" },
			},
			0,
		);
	return { store, schedule };
}
function adapters(adapter: SchedulingTargetAdapter) {
	return { "wake-up": adapter, standalone: adapter, workflow: adapter };
}
test("unapproved writable work survives repeated ticks, restart and overlapping run-now until operator approval", async () => {
	const { store, schedule } = fixture();
	store.action(schedule.id, 1, "cancel", 0, "cancel-fixture");
	const writable = store.createJob(
		{
			...job,
			target: {
				kind: "standalone",
				repository: "/fixture",
				baseBranch: "main",
				model: "fixture/model",
				policy: "default",
				reviewPolicy: "human",
			},
		},
		0,
	);
	const when = store.createSchedule(
		{
			name: schedule.name,
			timing: schedule.timing,
			latePolicy: schedule.latePolicy,
			jobId: writable.id,
		},
		0,
	);
	let now = 1000,
		activations = 0;
	const adapter: SchedulingTargetAdapter = {
		resolve: async (v) => v,
		reserve: async (v) => ({ id: v.id, digest: "fixture", state: "reserved" }),
		query: async (v) => {
			if (!v.receipt) throw new Error("Missing receipt");
			return v.receipt;
		},
		activate: async (v) => {
			activations++;
			return { id: v.id, digest: "fixture", state: "succeeded" };
		},
	};
	let service = new SchedulingService(store, adapters(adapter), () => now);
	await service.tick();
	const original = store.history(when.id)[0];
	if (!original) throw new Error("Missing occurrence");
	expect(original.state).toBe("waiting-review");
	expect(original.admittedAt).toBeUndefined();
	expect(activations).toBe(0);
	now += 60_000;
	await service.tick();
	expect(activations).toBe(0);
	await service.stop();
	const reopened = SchedulingStore.open(path.dirname(store.filename));
	stores.push(reopened);
	service = new SchedulingService(reopened, adapters(adapter), () => now);
	await service.tick();
	expect(reopened.occurrence(original.id).state).toBe("waiting-review");
	expect(reopened.occurrence(original.id).admittedAt).toBeUndefined();
	expect(activations).toBe(0);
	const api = new SchedulingApi(service);
	await expect(
		api.execute(
			{
				operation: "occurrences.approve",
				id: original.id,
				fence: reopened.occurrence(original.id).fence,
				requestId: "denied",
			},
			"orchestrator",
		),
	).rejects.toThrow("Only an operator");
	await service.tick();
	expect(activations).toBe(0);
	const manual = reopened.action(when.id, 1, "run-now", now, "overlap");
	expect(manual.occurrence?.state).toBe("skipped-overlap");
	expect(manual.schedule.revision).toBe(1);
	await api.execute(
		{
			operation: "occurrences.approve",
			id: original.id,
			fence: reopened.occurrence(original.id).fence,
			requestId: "approved",
		},
		"operator",
	);
	await service.tick();
	expect(activations).toBe(1);
	expect(reopened.occurrence(original.id).state).toBe("succeeded");
	expect(reopened.occurrence(original.id).admittedAt).toBe(now);
	now += 60_000;
	await service.tick();
	expect(activations).toBe(1);
	await service.stop();
});

test("idle polls do not run retention maintenance each second", async () => {
	const { store } = fixture();
	let now = 1000;
	const adapter: SchedulingTargetAdapter = {
		resolve: async (v) => v,
		reserve: async (v) => ({ id: v.id, digest: "fixture", state: "reserved" }),
		query: async (v) => ({ id: v.id, digest: "fixture", state: "reserved" }),
		activate: async (v) => ({
			id: v.id,
			digest: "fixture",
			state: "succeeded",
		}),
	};
	const prune = spyOn(store, "prune"),
		service = new SchedulingService(store, adapters(adapter), () => now);
	try {
		for (let i = 0; i < 60; i++) {
			await service.tick();
			now += 1000;
		}
		expect(prune).toHaveBeenCalledTimes(1);
		await service.tick();
		expect(prune).toHaveBeenCalledTimes(2);
	} finally {
		prune.mockRestore();
		await service.stop();
	}
});

test("launch-before-ack failure recovers the SAME durable target after service/store reopen", async () => {
	const { store, schedule } = fixture();
	let now = 1000,
		launches = 0;
	const receipts = new Map<string, TargetReceipt>();
	const adapter: SchedulingTargetAdapter = {
		async resolve(value) {
			return value;
		},
		async reserve(value) {
			const receipt: TargetReceipt = {
				id: value.id,
				digest: "fixture",
				state: "reserved",
			};
			receipts.set(value.id, receipt);
			return receipt;
		},
		async activate(value) {
			launches++;
			receipts.set(value.id, {
				id: value.id,
				digest: "fixture",
				state: "succeeded",
				result: "fixture-output",
			});
			throw new SchedulingInfrastructureError("ack lost");
		},
		async query(value) {
			const receipt = receipts.get(value.id);
			if (!receipt) throw new Error("missing fixture receipt");
			return receipt;
		},
	};
	const a = new SchedulingService(
		store,
		adapters(adapter),
		() => now,
		() => {
			throw new Error("notification unavailable");
		},
	);
	await a.tick();
	const [occ] = store.history(schedule.id);
	if (!occ) throw new Error("fixture");
	expect(occ.state).toBe("reconciling");
	expect(launches).toBe(1);
	await a.stop();
	const reopened = SchedulingStore.open(path.dirname(store.filename));
	stores.push(reopened);
	now = 32000;
	const b = new SchedulingService(reopened, adapters(adapter), () => now);
	await b.tick();
	expect(reopened.occurrence(occ.id).state).toBe("succeeded");
	expect(reopened.occurrence(occ.id).receipt?.result).toBe("fixture-output");
	expect(launches).toBe(1);
	await b.stop();
});
test("pause during remote reservation fences later authorization without making it runnable", async () => {
	const { store, schedule } = fixture();
	let release = () => {};
	let entered = () => {};
	const waiting = new Promise<void>((resolve) => {
			release = resolve;
		}),
		reserved = new Promise<void>((resolve) => {
			entered = resolve;
		});
	let activated = false;
	const adapter: SchedulingTargetAdapter = {
		async resolve(value) {
			return value;
		},
		async reserve(value) {
			entered();
			await waiting;
			return { id: value.id, digest: "fixture", state: "reserved" };
		},
		async activate(value) {
			activated = true;
			return { id: value.id, digest: "fixture", state: "running" };
		},
		async query(value) {
			return { id: value.id, digest: "fixture", state: "reserved" };
		},
	};
	const service = new SchedulingService(store, adapters(adapter), () => 1000);
	const tick = service.tick();
	await reserved;
	store.mutate("operator", "pause", {}, () =>
		store.action(schedule.id, 1, "pause", 1000, "pause"),
	);
	release();
	await tick;
	expect(activated).toBe(false);
	expect(store.history(schedule.id)[0]?.state).toBe(
		"cancelled-before-admission",
	);
	await service.stop();
});
test("once run-now consumes the trigger and admission uses its committed schedule revision", async () => {
	const { store, schedule } = fixture();
	const result = store.mutate("operator", "manual", {}, () =>
		store.action(schedule.id, 1, "run-now", 500, "manual"),
	);
	if (!result.occurrence) throw new Error("fixture");
	const claim = store.claim(result.occurrence.id, 500);
	if (!claim) throw new Error("fixture claim");
	store.transition(claim.id, claim.fence, "reserved", 500, {
		receipt: { id: claim.id, digest: "fixture", state: "reserved" },
	});
	expect(store.authorize(claim.id, claim.fence, 500).admittedAt).toBe(500);
	expect(store.reconcileDue(1000)).toHaveLength(0);
	expect(
		store.mutate<typeof result>("operator", "manual", {}, () => {
			throw new Error("must not rerun");
		}),
	).toEqual(result);
});

for (const window of [
	"claim",
	"reservation-ack",
	"receipt-before",
	"receipt-after",
	"authorization-after",
	"activation-ack",
	"completion-before",
	"completion-after",
] as const) {
	test(`two dispatchers recover ${window} with one identity and one runnable target`, async () => {
		const { store, schedule } = fixture();
		let now = 1000,
			injected = false,
			starts = 0;
		const native = new Map<string, TargetReceipt>();
		const adapter: SchedulingTargetAdapter = {
			async resolve(value) {
				return value;
			},
			async reserve(value) {
				const receipt = native.get(value.id) ?? {
					id: value.id,
					digest: "fixture",
					state: "reserved" as const,
				};
				native.set(value.id, receipt);
				if (window === "reservation-ack" && !injected) {
					injected = true;
					throw new SchedulingInfrastructureError("reservation ack lost");
				}
				return receipt;
			},
			async query(value) {
				const receipt = native.get(value.id);
				if (!receipt) throw new Error("Missing native reservation");
				return receipt;
			},
			async activate(value) {
				if (native.get(value.id)?.state === "reserved") {
					starts++;
					native.set(value.id, {
						id: value.id,
						digest: "fixture",
						state: "succeeded",
						result: "exact result",
					});
				}
				if (window === "activation-ack" && !injected) {
					injected = true;
					throw new SchedulingInfrastructureError("activation ack lost");
				}
				const receipt = native.get(value.id);
				if (!receipt) throw new Error("Missing native result");
				return receipt;
			},
		};
		const transition = store.transition.bind(store),
			authorize = store.authorize.bind(store),
			claim = store.claim.bind(store);
		const spies = [
			spyOn(store, "transition").mockImplementation(
				(...args: Parameters<typeof transition>) => {
					const point =
						args[2] === "reserved"
							? "receipt"
							: args[2] === "succeeded"
								? "completion"
								: undefined;
					if (window === `${point}-before` && !injected) {
						injected = true;
						throw new SchedulingInfrastructureError("before persistence");
					}
					const result = transition(...args);
					if (window === `${point}-after` && !injected) {
						injected = true;
						throw new SchedulingInfrastructureError("after persistence");
					}
					return result;
				},
			),
			spyOn(store, "authorize").mockImplementation(
				(...args: Parameters<typeof authorize>) => {
					const result = authorize(...args);
					if (window === "authorization-after" && !injected) {
						injected = true;
						throw new SchedulingInfrastructureError("authorization ack lost");
					}
					return result;
				},
			),
			spyOn(store, "claim").mockImplementation(
				(...args: Parameters<typeof claim>) => {
					const result = claim(...args);
					if (result && window === "claim" && !injected) {
						injected = true;
						throw new SchedulingInfrastructureError("claim ack lost");
					}
					return result;
				},
			),
		];
		const competitor = SchedulingStore.open(path.dirname(store.filename));
		stores.push(competitor);
		const a = new SchedulingService(store, adapters(adapter), () => now),
			b = new SchedulingService(competitor, adapters(adapter), () => now);
		try {
			const first = await Promise.allSettled([a.tick(), b.tick()]);
			expect(first.filter((value) => value.status === "rejected").length).toBe(
				window === "claim" ? 1 : 0,
			);
			expect(injected).toBe(true);
			await a.stop();
			await b.stop();
			for (const spy of spies) spy.mockRestore();
			const reopened = SchedulingStore.open(path.dirname(store.filename));
			stores.push(reopened);
			now = 400000;
			const recovered = new SchedulingService(
				reopened,
				adapters(adapter),
				() => now,
			);
			await recovered.tick();
			await recovered.stop();
			expect(native.size).toBe(1);
			expect(starts).toBe(1);
			const history = reopened.history(schedule.id);
			expect(history).toHaveLength(1);
			expect(history[0]?.state).toBe("succeeded");
			expect(history[0]?.receipt?.result).toBe("exact result");
		} finally {
			for (const spy of spies) spy.mockRestore();
			await a.stop();
			await b.stop();
		}
	});
}
test("only infrastructure retries are bounded; defects and execution failures never replay work", async () => {
	for (const failure of ["infrastructure", "defect", "execution"] as const) {
		const { store, schedule } = fixture();
		let now = 1000,
			reservations = 0,
			starts = 0;
		const native = new Map<string, TargetReceipt>();
		const adapter: SchedulingTargetAdapter = {
			async resolve(value) {
				return value;
			},
			async reserve(value) {
				reservations++;
				if (failure !== "execution") {
					if (failure === "infrastructure")
						throw new SchedulingInfrastructureError("offline");
					throw new Error("defect");
				}
				const receipt = {
					id: value.id,
					digest: "fixture",
					state: "reserved" as const,
				};
				native.set(value.id, receipt);
				return receipt;
			},
			async activate(value) {
				starts++;
				return { id: value.id, digest: "fixture", state: "execution-failed" };
			},
			async query(value) {
				const receipt = native.get(value.id);
				if (!receipt) throw new Error("fixture");
				return receipt;
			},
		};
		const service = new SchedulingService(store, adapters(adapter), () => now);
		try {
			for (let attempt = 0; attempt < 12; attempt++) {
				await service.tick();
				now += 400000;
			}
		} finally {
			await service.stop();
		}
		expect(store.history(schedule.id)[0]?.state).toBe(
			failure === "execution" ? "execution-failed" : "launch-failed",
		);
		expect(starts).toBe(failure === "execution" ? 1 : 0);
		expect(reservations).toBeGreaterThan(0);
		expect(reservations).toBeLessThan(12);
		expect(reservations).toBe(failure === "infrastructure" ? 6 : 1);
	}
});

for (const state of [
	"succeeded",
	"execution-failed",
	"waiting-review",
] as const) {
	test(`notification loss and replay overflow resync ${state} from durable history`, async () => {
		const { store, schedule } = fixture(),
			broker = new EventBroker("isolated", 1);
		const subscription = broker.open({}, () => {
			throw new Error("subscriber disconnected");
		});
		const adapter: SchedulingTargetAdapter = {
			async resolve(value) {
				return value;
			},
			async reserve(value) {
				return { id: value.id, digest: "fixture", state: "reserved" };
			},
			async query(value) {
				if (!value.receipt) throw new Error("Missing receipt");
				return value.receipt;
			},
			async activate(value) {
				return {
					id: value.id,
					digest: "fixture",
					state,
					result: "exact result",
				};
			},
		};
		const service = new SchedulingService(
			store,
			adapters(adapter),
			() => 1000,
			(value) => {
				broker.publish({
					domain: "workflow",
					kind: "scheduling.occurrence",
					resource: value.scheduleId,
					payload: {
						occurrenceId: value.id,
						state: value.state,
						jobId: value.jobId,
					},
				});
			},
		);
		try {
			await service.tick();
			expect(broker.replay(0).snapshotRequired).toBe(true);
			const snapshot = store.history(schedule.id);
			expect(snapshot).toHaveLength(1);
			expect(snapshot[0]?.state).toBe(state);
			expect(snapshot[0]?.receipt?.result).toBe("exact result");
			const replay = broker.replay(broker.currentSequence - 1);
			expect(replay.snapshotRequired).toBe(false);
			expect(replay.events[0]?.kind).toBe("scheduling.occurrence");
			expect(replay.events[0]?.resource).toBe(schedule.id);
			await service.tick();
			expect(store.history(schedule.id)).toHaveLength(1);
		} finally {
			subscription.unsubscribe();
			await service.stop();
		}
	});
}
