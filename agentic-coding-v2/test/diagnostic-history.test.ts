// Pure retained-diagnostic windowing: no runtime, gateway, engine or receiver.
// The end-to-end HTTP/SQL history paths are not repeated here.
import { expect, test } from "bun:test";
import { digest } from "../src/config.ts";
import { diagnosticHistory } from "../src/environment/diagnostic-history.ts";

type Receipt = {
	owner: number;
	inputDigest: string;
	approved: { run: string };
	issuedAt: number;
	state: "issued" | "completed";
	result?: { observedAt: number };
};
const store = (receipts: Receipt[]) =>
	Object.fromEntries(
		receipts.map((receipt, index) => [
			String(index + 1).padStart(64, "0"),
			JSON.stringify(receipt),
		]),
	);
const record = (run: string, index: number, extra: Partial<Receipt> = {}) => ({
	owner: 7,
	inputDigest: digest(`input-${index}`),
	approved: { run },
	issuedAt: 1000 + index,
	state: "issued" as const,
	...extra,
});
const ids = (records: Record<string, string>) =>
	Object.keys(records).sort((left, right) => left.localeCompare(right));
const run = { id: "run-1", owner: 7 };
const describe = (receipt: Receipt) => ({ issuedAt: String(receipt.issuedAt) });
const all = () => true;

test("a diagnostic window keeps newest issuance first, reports omissions and pages by boundary", () => {
	const records = store(
		Array.from({ length: 202 }, (_, index) => record("run-1", index)),
	);
	const first = diagnosticHistory(records, run, {}, "HTTP", all, describe);
	expect(first).toMatchObject({
		total: 202,
		returned: 200,
		limit: 200,
		omitted: 2,
		newer: 0,
		remainingOlder: 2,
		order: "newest-issuance-first",
		scope: "exact-run",
	});
	expect(first.records?.[0]?.issuedAt).toBe(1201);
	const oldest = String(1).padStart(64, "0");
	expect(first.records?.some((row) => row.id === oldest)).toBe(false);
	const older = diagnosticHistory(
		records,
		run,
		{ cursor: String(first.nextCursor) },
		"HTTP",
		all,
		describe,
	);
	expect(older).toMatchObject({
		total: 202,
		returned: 2,
		newer: 200,
		remainingOlder: 0,
		nextCursor: null,
	});
	expect(
		[...(first.records ?? []), ...(older.records ?? [])]
			.map((row) => row.id)
			.sort(),
	).toEqual(ids(records));
});

test("an exact diagnostic ID stays readable outside the window but only in its own run and owner scope", () => {
	const records = store([
		record("run-1", 0),
		record("run-1", 1),
		record("run-2", 2),
		record("run-1", 3, { owner: 8 }),
		record("run-1", 4, { state: "completed", result: { observedAt: 5000 } }),
	]);
	const id = (index: number) => String(index).padStart(64, "0");
	const exact = diagnosticHistory(
		records,
		run,
		{ operation: id(1) },
		"HTTP",
		all,
		describe,
	);
	expect(exact).toMatchObject({ id: id(1), run: "run-1", state: "issued" });
	expect(exact).toHaveProperty("result", null);
	expect(
		diagnosticHistory(records, run, { operation: id(5) }, "SQL", all, describe),
	).toMatchObject({ id: id(5), state: "completed", observedAt: 5000 });
	for (const operation of [id(3), id(4), "f".repeat(64)])
		expect(() =>
			diagnosticHistory(records, run, { operation }, "HTTP", all, describe),
		).toThrow("Unknown HTTP diagnostic for this exact run");
});

test("a cursor is a validated opaque boundary, never an extra scope, operation or privilege", () => {
	const records = store(
		Array.from({ length: 202 }, (_, index) => record("run-1", index)),
	);
	const cursor = String(
		diagnosticHistory(records, run, {}, "SQL", all, describe).nextCursor,
	);
	expect(cursor).toMatch(/^[a-f0-9]{64}$/);
	for (const selection of [
		{ cursor: "not-a-digest" },
		{ cursor, operation: String(1).padStart(64, "0") },
		{ cursor: "e".repeat(64) },
		{ cursor: digest("another-boundary") },
	])
		expect(() =>
			diagnosticHistory(records, run, selection, "SQL", all, describe),
		).toThrow(/^Choose list cursor|^Unknown diagnostic cursor/);
	// The same boundary under another kind never selects SQL history.
	expect(() =>
		diagnosticHistory(records, run, { cursor }, "HTTP", all, describe),
	).toThrow("Unknown diagnostic cursor");
});
