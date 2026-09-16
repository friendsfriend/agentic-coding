// Paged, indexed trace list (trace-list-paging): the list is aggregated SQL over
// materialized columns, not a json_extract over every span, and rows ingested
// before those columns existed are backfilled once.

import { Database } from "bun:sqlite";
import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { TraceDb } from "../../src/tui/otel/model/db";
import type { SpanData } from "../../src/tui/otel/model/types";

const dirs: string[] = [];
function tempDir(): string {
	const dir = mkdtempSync(join(tmpdir(), "trace-paging-"));
	dirs.push(dir);
	return dir;
}

afterEach(() => {
	for (const dir of dirs.splice(0))
		rmSync(dir, { recursive: true, force: true });
});

function span(options: {
	changeId: string;
	startNanos: string;
	status?: number;
	role?: string;
}): SpanData {
	return {
		traceId: `trace-${options.changeId}`,
		spanId: `${options.changeId}-${options.startNanos}`.padEnd(16, "0"),
		parentSpanId: "",
		name: "effect.result",
		startTimeUnixNano: options.startNanos,
		endTimeUnixNano: String(BigInt(options.startNanos) + 1_000_000n),
		status: { code: options.status ?? 0 },
		attributes: [
			{ key: "herdr.change.id", value: options.changeId },
			...(options.role ? [{ key: "herdr.role", value: options.role }] : []),
		],
		resource: { attributes: [], droppedAttributesCount: 0 },
		scope: { name: "engine", version: "" },
		serviceName: "herdr-workflow",
		kind: 0,
	};
}

/** Two spans for `beta` (one failing, one planner and one worker role), one for
 * `alpha`, oldest last so the newest-first order is observable. */
function seed(db: TraceDb): void {
	db.ingestSpan("alpha", span({ changeId: "alpha", startNanos: "1000000000" }));
	db.ingestSpan(
		"beta",
		span({
			changeId: "beta",
			startNanos: "5000000000",
			status: 2,
			role: "worker",
		}),
	);
	db.ingestSpan(
		"beta",
		span({ changeId: "beta", startNanos: "6000000000", role: "planner" }),
	);
}

describe("paged trace summaries", () => {
	test("aggregates one row per workflow, newest first, with errors and agents", () => {
		const db = new TraceDb(tempDir());
		try {
			seed(db);
			const page = db.listTraceSummaries({ page: 1, perPage: 1 });
			expect(page.total).toBe(2);
			expect(page.items).toHaveLength(1);
			expect(page.items[0]?.changeId).toBe("beta");
			expect(page.items[0]?.spanCount).toBe(2);
			expect(page.items[0]?.errorCount).toBe(1);
			expect(page.items[0]?.agents).toEqual(["worker", "planner"]);
			// Nanosecond timestamps stay exact strings.
			expect(page.items[0]?.startNanos).toBe("5000000000");
			expect(page.items[0]?.endNanos).toBe("6001000000");

			const second = db.listTraceSummaries({ page: 2, perPage: 1 });
			expect(second.items.map((item) => item.changeId)).toEqual(["alpha"]);
		} finally {
			db.close();
		}
	});

	test("filters to one workflow and reports the filtered total", () => {
		const db = new TraceDb(tempDir());
		try {
			seed(db);
			const page = db.listTraceSummaries({ changeId: "beta" });
			expect(page.total).toBe(1);
			expect(page.items.map((item) => item.changeId)).toEqual(["beta"]);
		} finally {
			db.close();
		}
	});

	test("reads spans per workflow and the newest spans for the graph", () => {
		const db = new TraceDb(tempDir());
		try {
			seed(db);
			expect(db.loadSpans("beta")).toHaveLength(2);
			const recent = db.recentSpans(2);
			expect(recent.map((item) => item.startTimeUnixNano)).toEqual([
				"5000000000",
				"6000000000",
			]);
		} finally {
			db.close();
		}
	});

	test("backfills the aggregation columns of rows ingested before they existed", () => {
		const dir = tempDir();
		const db = new TraceDb(dir);
		seed(db);
		db.close();

		// Simulate the pre-column database: the aggregated columns are empty but
		// the spans are there, exactly as an older ingest left them.
		const raw = new Database(join(dir, "traces.sqlite"));
		raw.run(
			"UPDATE traces SET start_nanos=NULL, end_nanos=NULL, status_code=NULL, role=NULL",
		);
		raw.close();

		const reopened = new TraceDb(dir);
		try {
			const page = reopened.listTraceSummaries({ perPage: 10 });
			expect(page.total).toBe(2);
			const beta = page.items.find((item) => item.changeId === "beta");
			expect(beta?.spanCount).toBe(2);
			expect(beta?.errorCount).toBe(1);
			expect(beta?.agents).toEqual(["worker", "planner"]);
			expect(beta?.startNanos).toBe("5000000000");
		} finally {
			reopened.close();
		}
	});
});
