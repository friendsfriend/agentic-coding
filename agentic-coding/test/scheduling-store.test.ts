import { Database } from "bun:sqlite";
import { afterEach, describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { JobInput, ScheduleInput } from "../src/contracts/scheduling.ts";
import { SchedulingStore } from "../src/server/scheduling/store.ts";

const roots: string[] = [],
	stores: SchedulingStore[] = [];
afterEach(() => {
	for (const store of stores.splice(0)) store.close();
	for (const root of roots.splice(0))
		fs.rmSync(root, { recursive: true, force: true });
});
function open(root?: string): SchedulingStore {
	const dir =
		root ?? fs.mkdtempSync(path.join(os.tmpdir(), "scheduling-store-"));
	if (!root) roots.push(dir);
	const store = SchedulingStore.open(dir);
	stores.push(store);
	return store;
}
const job: JobInput = {
	name: "fixture",
	task: "Observe fixture only",
	originalInstruction: "recheck later",
	reason: "fixture",
	references: [],
	reportingDestination: "fixture transcript",
	target: {
		kind: "wake-up",
		hostId: "fixture-host",
		hostSocket: "/fixture.sock",
		conversationId: "1",
		runId: "fixture-run",
	},
};
function once(jobId: string, at = 1000): ScheduleInput {
	return {
		name: "once",
		jobId,
		timing: { kind: "once", at: new Date(at).toISOString(), timezone: "UTC" },
		latePolicy: { kind: "run-late" },
	};
}
function fixture(store: SchedulingStore, at = 1000) {
	const j = store.createJob(job, 0),
		s = store.createSchedule(once(j.id, at), 0);
	return { j, s };
}
describe("private scheduling store", () => {
	test("fresh schema, private permissions and reopen preserve identities", () => {
		const a = open(),
			{ s } = fixture(a);
		const b = open(path.dirname(a.filename));
		expect(b.schedule(s.id)).toEqual(s);
		expect(fs.statSync(a.filename).mode & 0o777).toBe(0o600);
		expect(b.reconcileDue(1000)).toHaveLength(1);
		expect(a.reconcileDue(1000)).toHaveLength(0);
		expect(b.history(s.id)[0]?.job.task).toBe(job.task);
	});
	test("reject newer/corrupt stores without replacement", () => {
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), "schedule-newer-"));
		roots.push(dir);
		const file = path.join(dir, "scheduling.sqlite"),
			db = new Database(file);
		db.exec("PRAGMA user_version=9");
		db.close();
		fs.chmodSync(file, 0o600); // Fixture reaches the version gate, not the private-file gate.
		const before = fs.readFileSync(file);
		expect(() => SchedulingStore.open(dir)).toThrow("Unsupported");
		expect(fs.readFileSync(file)).toEqual(before);
		fs.writeFileSync(file, "not sqlite");
		expect(() => SchedulingStore.open(dir)).toThrow();
		expect(fs.readFileSync(file, "utf8")).toBe("not sqlite");
	});
	test("atomic create receipts and same-key changed-body conflict", () => {
		const store = open();
		const work = () => {
			const j = store.createJob(job, 0);
			return { j, s: store.createSchedule(once(j.id), 0) };
		};
		const first = store.mutate("operator", "create-1", job, work);
		expect(store.mutate("operator", "create-1", job, work)).toEqual(first);
		expect(() =>
			store.mutate("operator", "create-1", { ...job, name: "changed" }, work),
		).toThrow("different body");
		expect(store.listJobs()).toHaveLength(1);
		expect(() =>
			store.mutate("operator", "rollback", {}, () => {
				store.createJob(job, 0);
				throw new Error("fixture");
			}),
		).toThrow();
		expect(store.listJobs()).toHaveLength(1);
	});
	test("unique slot, claim contention and lease expiry preserve occupancy", () => {
		const a = open(),
			{ j, s } = fixture(a),
			b = open(path.dirname(a.filename));
		const [occ] = a.reconcileDue(1000);
		if (!occ) throw new Error("missing fixture occurrence");
		const claim = a.claim(occ.id, 1000);
		if (!claim) throw new Error("missing claim");
		expect(b.claim(occ.id, 1001)).toBeUndefined();
		const replacement = b.claim(occ.id, 32000);
		expect(replacement?.fence).toBe(claim.fence + 1);
		expect(() => a.transition(occ.id, claim.fence, "running", 32000)).toThrow(
			"Stale",
		);
		const s2 = b.createSchedule(once(j.id, 33000), 32000);
		expect(b.reconcileDue(33000)[0]?.state).toBe("skipped-overlap");
		expect(b.history(s.id)).toHaveLength(1);
		expect(b.history(s2.id)).toHaveLength(1);
	});
	test("pause wins before admission, activation wins against later cancellation", () => {
		const store = open(),
			{ s } = fixture(store);
		const [o] = store.reconcileDue(1000);
		if (!o) throw new Error("fixture");
		const claim = store.claim(o.id, 1000);
		if (!claim) throw new Error("fixture claim");
		store.transition(o.id, claim.fence, "reserved", 1000, {
			receipt: { id: o.id, digest: "fixture", state: "reserved" },
		});
		store.action(s.id, s.revision, "pause", 1001, "pause");
		expect(() => store.authorize(o.id, claim.fence, 1002)).toThrow();
		expect(store.occurrence(o.id).state).toBe("cancelled-before-admission");
		const other = fixture(store, 2000),
			[next] = store.reconcileDue(2000);
		if (!next) throw new Error("fixture 2");
		const nextClaim = store.claim(next.id, 2000);
		if (!nextClaim) throw new Error("claim 2");
		store.transition(next.id, nextClaim.fence, "reserved", 2000, {
			receipt: { id: next.id, digest: "fixture", state: "reserved" },
		});
		store.authorize(next.id, nextClaim.fence, 2000);
		store.transition(next.id, nextClaim.fence, "waiting-review", 2000);
		const cancelled = store.action(other.s.id, 1, "cancel", 2001, "cancel");
		expect(cancelled.active[0]?.id).toBe(next.id);
		expect(store.occurrence(next.id).state).toBe("waiting-review");
	});
	test("once late/expiry, recurring downtime, polling allowance and clock rewind", () => {
		const store = open();
		const j = store.createJob(job, 0);
		const expiry = store.createSchedule(
			{ ...once(j.id), latePolicy: { kind: "expire-after", graceMs: 0 } },
			0,
		);
		expect(store.reconcileDue(1001)[0]?.state).toBe("expired");
		expect(store.history(expiry.id)[0]?.terminalAt).toBe(1001);
		const interval = store.createSchedule(
			{
				...once(j.id),
				timing: {
					kind: "interval",
					anchor: new Date(60000).toISOString(),
					everyMs: 60000,
					timezone: "UTC",
				},
			},
			0,
		);
		expect(store.reconcileDue(60000 * 100, true)[0]?.missedCount).toBe(99);
		expect(store.reconcileDue(60000 * 100)[0]?.state).toBe("pending");
		expect(store.reconcileDue(0)).toHaveLength(0);
		expect(store.schedule(interval.id).nextDue).toBe(60000 * 101);
	});
	test("revision conflicts and live-reference deletion refusal", () => {
		const store = open(),
			{ j, s } = fixture(store);
		expect(() => store.updateSchedule(s.id, 99, once(j.id), 0)).toThrow(
			"Stale",
		);
		expect(() => store.deleteJob(j.id, 1, 0)).toThrow("referencing schedules");
		const changed = store.updateJob(j.id, 1, { ...job, name: "updated" }, 1);
		expect(changed.affectedSchedules).toEqual([s.id]);
		expect(() => store.listSchedules("", 101)).toThrow();
	});
});

for (const phase of ["claimed", "reserved", "admitted"] as const) {
	for (const mutation of [
		"pause",
		"resume",
		"cancel",
		"delete",
		"postpone",
		"edit",
		"run-now",
	] as const) {
		test(`${mutation} racing ${phase} preserves the admission boundary and shared occupancy`, () => {
			const store = open(),
				{ j, s } = fixture(store),
				[occ] = store.reconcileDue(1000);
			if (!occ) throw new Error("Missing occurrence");
			const claim = store.claim(occ.id, 1000);
			if (!claim) throw new Error("Missing claim");
			if (phase !== "claimed")
				store.transition(occ.id, claim.fence, "reserved", 1000, {
					receipt: { id: occ.id, digest: "fixture", state: "reserved" },
				});
			if (phase === "admitted") store.authorize(occ.id, claim.fence, 1000);
			store.mutate("operator", "race", { mutation }, () => {
				if (mutation === "edit")
					return store.updateSchedule(
						s.id,
						s.revision,
						{
							...once(j.id),
							name: "changed",
							timing: {
								kind: "interval",
								anchor: new Date(1000).toISOString(),
								everyMs: 60000,
								timezone: "UTC",
							},
						},
						1001,
					);
				return store.action(
					s.id,
					s.revision,
					mutation,
					1001,
					"race",
					mutation === "postpone" ? 9000 : undefined,
				);
			});
			const retained = store.occurrence(occ.id);
			if (phase === "admitted" || mutation === "run-now") {
				expect(retained.fence).toBe(claim.fence);
				expect(retained.job).toEqual(occ.job);
				if (phase === "admitted") expect(retained.admittedAt).toBe(1000);
				if (mutation === "run-now" && phase !== "admitted") {
					if (phase === "claimed")
						store.transition(occ.id, claim.fence, "reserved", 1002, {
							receipt: { id: occ.id, digest: "fixture", state: "reserved" },
						});
					expect(store.authorize(occ.id, claim.fence, 1002).admittedAt).toBe(
						1002,
					);
				}
				if (mutation === "run-now")
					expect(
						store
							.history(s.id)
							.some((value) => value.state === "skipped-overlap"),
					).toBe(true);
			} else {
				expect(retained.state).toBe("cancelled-before-admission");
				expect(() => store.authorize(occ.id, claim.fence, 1002)).toThrow();
			}
			const other = store.createSchedule(once(j.id, 2000), 1002);
			store.reconcileDue(2000);
			if (phase === "admitted" || mutation === "run-now")
				expect(store.history(other.id)[0]?.state).toBe("skipped-overlap");
		});
	}
}
for (const state of [
	"queued",
	"processing",
	"running",
	"waiting-review",
	"reconciling",
	"destination-unavailable",
] as const) {
	test(`${state} retains job-wide occupancy across reopen`, () => {
		const store = open(),
			{ j, s } = fixture(store),
			[occ] = store.reconcileDue(1000);
		if (!occ) throw new Error("Missing occurrence");
		const claim = store.claim(occ.id, 1000);
		if (!claim) throw new Error("Missing claim");
		store.transition(occ.id, claim.fence, state, 1000);
		const reopened = open(path.dirname(store.filename));
		const other = reopened.createSchedule(once(j.id, 2000), 1001);
		reopened.reconcileDue(2000);
		expect(reopened.history(other.id)[0]?.state).toBe("skipped-overlap");
		expect(reopened.history(s.id)[0]?.state).toBe(state);
	});
}
test("retention caps terminal history, exempts unknown work and never recreates pruned slots", () => {
	const store = open(),
		{ j, s } = fixture(store);
	store.updateSchedule(
		s.id,
		1,
		{
			...once(j.id),
			timing: {
				kind: "interval",
				anchor: new Date(1000).toISOString(),
				everyMs: 60000,
				timezone: "UTC",
			},
		},
		0,
	);
	for (let i = 0; i < 1003; i++) {
		const now = 1000 + i * 60000,
			[occ] = store.reconcileDue(now);
		if (!occ) throw new Error("Missing interval slot");
		const claim = store.claim(occ.id, now);
		if (!claim) throw new Error("Missing claim");
		store.transition(occ.id, claim.fence, "succeeded", now);
	}
	const history = store.history(s.id, "", 100);
	expect(history).toHaveLength(100);
	expect(store.prune(1000 + 1003 * 60000)).toBe(0);
	expect(history[0]?.nominalDue).toBe(1000 + 3 * 60000);
	const tail = history.at(-1);
	if (!tail) throw new Error("Missing page boundary");
	const next = store.history(
		s.id,
		JSON.stringify([tail.createdAt, tail.id]),
		100,
	);
	expect(next).toHaveLength(100);
	expect(next.every((value) => value.createdAt > tail.createdAt)).toBe(true);
	expect(new Set([...history, ...next].map((value) => value.id)).size).toBe(
		200,
	);
	expect(store.reconcileDue(1000)).toHaveLength(0);
	const [active] = store.reconcileDue(1000 + 1003 * 60000);
	if (!active) throw new Error("Missing active slot");
	const claim = store.claim(active.id, active.createdAt);
	if (!claim) throw new Error("Missing claim");
	store.transition(active.id, claim.fence, "reconciling", active.createdAt);
	for (let batch = 0; batch < 10; batch++)
		expect(store.prune(200 * 86400_000)).toBe(100);
	expect(store.prune(200 * 86400_000)).toBe(0);
	expect(store.occurrence(active.id).state).toBe("reconciling");
	const reopened = open(path.dirname(store.filename));
	expect(reopened.reconcileDue(1000)).toHaveLength(0);
	expect(reopened.history(s.id)).toHaveLength(1);
	expect(reopened.job(j.id).id).toBe(j.id);
}, 30000);

test("distinct wake-up jobs share destination occupancy but never redirect to another conversation", () => {
	const store = open(),
		{ s } = fixture(store);
	store.reconcileDue(1000);
	const same = store.createJob({ ...job, name: "same destination" }, 1001);
	const other = store.createJob(
		{
			...job,
			name: "other conversation",
			target: {
				...job.target,
				kind: "wake-up",
				hostId: "fixture-host",
				hostSocket: "/fixture.sock",
				runId: "fixture-run",
				conversationId: "other",
			},
		},
		1001,
	);
	const blocked = store.createSchedule(once(same.id, 2000), 1001),
		independent = store.createSchedule(once(other.id, 2000), 1001);
	store.reconcileDue(2000);
	expect(store.history(blocked.id)[0]?.state).toBe("skipped-overlap");
	expect(store.history(independent.id)[0]?.state).toBe("pending");
	expect(store.history(s.id)[0]?.job.target).toEqual(job.target);
});
test("run-now preserves recurring cadence while explicit postpone changes only the next slot", () => {
	const store = open(),
		j = store.createJob(job, 0),
		schedule = store.createSchedule(
			{
				...once(j.id),
				timing: {
					kind: "interval",
					anchor: new Date(60000).toISOString(),
					everyMs: 60000,
					timezone: "UTC",
				},
			},
			0,
		);
	const manual = store.action(schedule.id, 1, "run-now", 1000, "manual");
	expect(manual.schedule.nextDue).toBe(60000);
	store.action(
		schedule.id,
		manual.schedule.revision,
		"postpone",
		2000,
		"postpone",
		90000,
	);
	expect(store.reconcileDue(60000)).toHaveLength(0);
	expect(store.reconcileDue(90000)[0]?.nominalDue).toBe(90000);
	expect(store.schedule(schedule.id).nextDue).toBe(120000);
});
