import { describe, expect, test } from "bun:test";
import type { DomainEventMessage } from "@devenv/core";
import {
	applySlotMessage,
	formatDuration,
	type SlotRow,
	slotIdleRemainingMs,
	slotOwnerLabel,
	slotRowFields,
	slotRowsFromSnapshot,
	slotWaitMs,
	slotWorkflowId,
	visibleSlotRows,
} from "./slot-store.ts";

// The Slots section's pure data layer (show-environment-instances): the snapshot
// mapping, the `environment.slot.*` event application and the row formatting.
// The reactive `createSlotStore` is a thin wrapper over these, so pinning them
// is what proves the section's behaviour without a server or a terminal.

function waiting(
	app: string,
	owner: string,
	since: string,
	position = 1,
): DomainEventMessage {
	return {
		type: "event",
		event: {
			instance: "i",
			sequence: 1,
			domain: "environment",
			kind: "environment.slot.waiting",
			resource: app,
			at: since,
			payload: { app, waiter: owner, holder: "workflow:a", position },
		},
	};
}

function granted(app: string, owner: string, at: string): DomainEventMessage {
	return {
		type: "event",
		event: {
			instance: "i",
			sequence: 2,
			domain: "environment",
			kind: "environment.slot.granted",
			resource: app,
			at,
			payload: { app, owner },
		},
	};
}

function reaped(app: string, owner: string): DomainEventMessage {
	return {
		type: "event",
		event: {
			instance: "i",
			sequence: 3,
			domain: "environment",
			kind: "environment.slot.reaped",
			resource: app,
			at: "2026-01-01T00:10:00.000Z",
			payload: { app, owner },
		},
	};
}

describe("slot snapshot", () => {
	test("keeps the richer fields and falls back to ordered waiters", () => {
		const rows = slotRowsFromSnapshot([
			{
				app: "shop",
				holder: "workflow:a",
				status: "running",
				waiters: ["workflow:b", "workflow:c"],
				waiting: [
					{
						owner: "workflow:b",
						since: "2026-01-01T00:00:00.000Z",
						position: 1,
					},
				],
				holderSince: "2026-01-01T00:00:00.000Z",
				idleMs: 5000,
				idleTtlMs: 60000,
				endpoints: { api: "http://127.0.0.1:8080" },
			},
			{
				app: "api",
				holder: null,
				status: null,
				waiters: ["workflow:c"],
			} as never,
		]);
		expect(rows[0]).toEqual({
			app: "shop",
			holder: "workflow:a",
			status: "running",
			endpoints: { api: "http://127.0.0.1:8080" },
			holderSince: "2026-01-01T00:00:00.000Z",
			idleMs: 5000,
			idleTtlMs: 60000,
			waiting: [
				{ owner: "workflow:b", since: "2026-01-01T00:00:00.000Z", position: 1 },
			],
		});
		// No `waiting`: the plain `waiters` order carries the positions.
		expect(rows[1]?.waiting).toEqual([
			{ owner: "workflow:c", since: "", position: 1 },
		]);
	});

	test("lists only agent-held apps and apps with waiters", () => {
		const rows: SlotRow[] = [
			{
				app: "agent",
				holder: "workflow:a",
				status: "running",
				endpoints: {},
				holderSince: null,
				idleMs: null,
				idleTtlMs: null,
				waiting: [],
			},
			{
				app: "human",
				holder: "user",
				status: "running",
				endpoints: {},
				holderSince: null,
				idleMs: null,
				idleTtlMs: null,
				waiting: [],
			},
			{
				app: "queued",
				holder: "user",
				status: "running",
				endpoints: {},
				holderSince: null,
				idleMs: null,
				idleTtlMs: null,
				waiting: [{ owner: "workflow:b", since: "", position: 1 }],
			},
			{
				app: "free",
				holder: null,
				status: null,
				endpoints: {},
				holderSince: null,
				idleMs: null,
				idleTtlMs: null,
				waiting: [],
			},
		];
		expect(visibleSlotRows(rows).map((row) => row.app)).toEqual([
			"agent",
			"queued",
		]);
	});
});

describe("slot events", () => {
	test("a wait adds the waiter in position order and names the holder", () => {
		const first = applySlotMessage(
			[],
			waiting("shop", "workflow:b", "2026-01-01T00:00:00.000Z", 1),
		);
		const second = applySlotMessage(
			first.rows,
			waiting("shop", "workflow:c", "2026-01-01T00:01:00.000Z", 2),
		);
		const row = second.rows[0];
		expect(row?.holder).toBe("workflow:a");
		expect(row?.waiting.map((wait) => wait.owner)).toEqual([
			"workflow:b",
			"workflow:c",
		]);
	});

	test("a grant becomes the holder and drops that owner from the queue", () => {
		const queued = applySlotMessage(
			[],
			waiting("shop", "workflow:b", "2026-01-01T00:00:00.000Z", 1),
		);
		const result = applySlotMessage(
			queued.rows,
			granted("shop", "workflow:b", "2026-01-01T00:02:00.000Z"),
		);
		expect(result.rows[0]?.holder).toBe("workflow:b");
		expect(result.rows[0]?.holderSince).toBe("2026-01-01T00:02:00.000Z");
		expect(result.rows[0]?.waiting).toEqual([]);
	});

	test("a reap frees the holder and a resync asks for a snapshot", () => {
		const held = applySlotMessage(
			[],
			granted("shop", "workflow:a", "2026-01-01T00:00:00.000Z"),
		);
		const reapedRow = applySlotMessage(held.rows, reaped("shop", "workflow:a"));
		expect(reapedRow.rows[0]?.holder).toBeNull();
		expect(reapedRow.refresh).toBe(false);
		const resync = applySlotMessage(reapedRow.rows, {
			type: "resync",
			reason: "cursor outside replay window",
		});
		expect(resync.refresh).toBe(true);
	});

	test("an unrelated event leaves the rows untouched", () => {
		const result = applySlotMessage([], {
			type: "event",
			event: {
				instance: "i",
				sequence: 9,
				domain: "workflow",
				kind: "workflow.updated",
				at: "2026-01-01T00:00:00.000Z",
				payload: {},
			},
		});
		expect(result.rows).toEqual([]);
		expect(result.refresh).toBe(false);
	});
});

describe("slot formatting", () => {
	test("labels owners and resolves workflow ids", () => {
		expect(slotOwnerLabel("user")).toBe("you");
		expect(slotOwnerLabel("workflow:abc")).toBe("abc");
		expect(slotOwnerLabel(null)).toBe("nobody");
		expect(slotWorkflowId("workflow:abc")).toBe("abc");
		expect(slotWorkflowId("user")).toBeUndefined();
	});

	test("formats a duration, a wait and the idle TTL remaining", () => {
		expect(formatDuration(5_000)).toBe("5s");
		expect(formatDuration(200_000)).toBe("3m 20s");
		expect(
			slotWaitMs(
				{ owner: "workflow:b", since: "2026-01-01T00:00:00.000Z", position: 1 },
				Date.parse("2026-01-01T00:03:20.000Z"),
			),
		).toBe(200_000);
		expect(
			slotIdleRemainingMs({
				app: "shop",
				holder: "workflow:a",
				status: "running",
				endpoints: {},
				holderSince: null,
				idleMs: 5_000,
				idleTtlMs: 65_000,
				waiting: [],
			}),
		).toBe(60_000);
	});

	test("renders a row's holder, endpoints, idle/TTL and waiters", () => {
		const fields = slotRowFields(
			{
				app: "shop",
				holder: "workflow:a",
				status: "running",
				endpoints: { api: "http://127.0.0.1:8080" },
				holderSince: "2026-01-01T00:00:00.000Z",
				idleMs: 5_000,
				idleTtlMs: 65_000,
				waiting: [
					{
						owner: "workflow:b",
						since: "2026-01-01T00:03:20.000Z",
						position: 1,
					},
				],
			},
			Date.parse("2026-01-01T00:04:00.000Z"),
		);
		expect(fields).toEqual({
			holder: "a",
			status: "running",
			endpoints: "api=http://127.0.0.1:8080",
			idle: "idle 5s · ttl 1m 0s",
			waiting: "b (40s)",
		});
	});

	test("falls back to an em dash for absent endpoints and waiters", () => {
		const fields = slotRowFields(
			{
				app: "shop",
				holder: null,
				status: null,
				endpoints: {},
				holderSince: null,
				idleMs: null,
				idleTtlMs: null,
				waiting: [],
			},
			0,
		);
		expect(fields).toEqual({
			holder: "nobody",
			status: "unknown",
			endpoints: "—",
			idle: "—",
			waiting: "—",
		});
	});
});
