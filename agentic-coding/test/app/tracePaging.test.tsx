/** @jsxImportSource @opentui/solid */
// Lazily read, paged observability (trace-list-paging): the shell reads no
// history at startup, the first observability visit ingests and reads one page,
// `[`/`]` move between pages, and a trace's spans are fetched when it opens.
import { expect, test } from "bun:test";
import { testRender } from "@opentui/solid";
import { App } from "../../src/tui/otel/app/App";
import { LogStore } from "../../src/tui/otel/model/logStore";
import { MetricStore } from "../../src/tui/otel/model/metricStore";
import type {
	TelemetryDb,
	TelemetryWorkspace,
} from "../../src/tui/otel/model/telemetry-db";
import { TopologyStore } from "../../src/tui/otel/model/topologyStore";
import { TraceStore } from "../../src/tui/otel/model/traceStore";
import type {
	SpanData,
	TraceSummaryPage,
	TraceSummaryRow,
} from "../../src/tui/otel/model/types";
import { jumpTo, renderUntil } from "./support/terminal";

/** Three workflows, two per page, newest first. */
const ROWS: TraceSummaryRow[] = [
	row("wf-newest", 0),
	row("wf-mid", 1),
	row("wf-oldest", 0),
];

function row(changeId: string, errorCount: number): TraceSummaryRow {
	return {
		changeId,
		spanCount: 2,
		errorCount,
		startNanos: "1000000000",
		endNanos: "3000000000",
		agents: ["worker"],
	};
}

function span(changeId: string, name: string): SpanData {
	return {
		traceId: changeId,
		spanId: `${changeId}-${name}`.padEnd(16, "0"),
		parentSpanId: "",
		name,
		startTimeUnixNano: "1000000000",
		endTimeUnixNano: "2000000000",
		status: { code: 0 },
		attributes: [{ key: "herdr.change.id", value: changeId }],
		resource: { attributes: [], droppedAttributesCount: 0 },
		scope: { name: "engine", version: "" },
		serviceName: "herdr-workflow",
		kind: 0,
	};
}

class StubTelemetryDb implements TelemetryDb {
	readonly pageReads: Array<{ page: number; changeId?: string }> = [];
	readonly scans: string[] = [];
	readonly spanReads: string[] = [];
	private readonly listeners = new Set<() => void>();

	getWorkspaces(): TelemetryWorkspace[] {
		return [];
	}
	async refreshWorkspaces(): Promise<TelemetryWorkspace[]> {
		return [];
	}
	async fetchTracePage(options: {
		page: number;
		perPage: number;
		changeId?: string;
	}): Promise<TraceSummaryPage> {
		this.pageReads.push({
			page: options.page,
			...(options.changeId ? { changeId: options.changeId } : {}),
		});
		const filtered = options.changeId
			? ROWS.filter((item) => item.changeId === options.changeId)
			: ROWS;
		// The stub answers with its own small page size, so three workflows make
		// two pages without depending on the shell's default.
		const perPage = 2;
		const offset = (options.page - 1) * perPage;
		return {
			items: filtered.slice(offset, offset + perPage),
			total: filtered.length,
			page: options.page,
			perPage,
		};
	}
	async fetchTraceSpans(changeId: string): Promise<SpanData[]> {
		this.spanReads.push(changeId);
		return [span(changeId, "effect.result")];
	}
	async fetchRecentSpans(): Promise<SpanData[]> {
		return [];
	}
	async watchRepositories(): Promise<void> {}
	async scanRepositories(roots: readonly string[]): Promise<number> {
		this.scans.push(...roots);
		return 0;
	}
	onChange(listener: () => void): () => void {
		this.listeners.add(listener);
		return () => this.listeners.delete(listener);
	}
	cleanupOlderThan(): number {
		return 0;
	}
	close(): void {}
}

async function renderPagedShell() {
	const db = new StubTelemetryDb();
	const traceStore = new TraceStore();
	const t = await testRender(
		() => (
			<App
				repos={["/repo"]}
				db={db}
				traceStore={traceStore}
				metricStore={new MetricStore()}
				logStore={new LogStore()}
				topologyStore={new TopologyStore()}
				environments={{ serverUrl: "http://127.0.0.1:4050" }}
				renderEnvironments={() => <text>ENV-BODY</text>}
			/>
		),
		{ width: 140, height: 40 },
	);
	await t.renderOnce();
	return { t, db, traceStore };
}

test("the shell reads no traces until observability is shown", async () => {
	const { t, db } = await renderPagedShell();
	// Initial destination is Environments: nothing reads the trace list.
	expect(t.captureCharFrame()).toContain("Applications");
	expect(db.pageReads).toEqual([]);
	expect(db.scans).toEqual([]);

	await jumpTo(t, "traces");
	expect(await renderUntil(t, "wf-newest")).toBe(true);
	// The first read ingests workspace files once, then reads page 1 only.
	expect(db.scans).toEqual(["/repo"]);
	expect(db.pageReads).toEqual([{ page: 1 }]);
	t.renderer.destroy();
});

test("paging moves between trace pages and a trace opens by fetching its spans", async () => {
	const { t, db } = await renderPagedShell();
	await jumpTo(t, "traces");
	expect(await renderUntil(t, "wf-newest")).toBe(true);
	// The footer advertises the page binding; the header names the page.
	expect(t.captureCharFrame()).toContain("page");
	expect(t.captureCharFrame()).toContain("page 1/2");

	t.mockInput.pressKey("]");
	expect(await renderUntil(t, "wf-oldest")).toBe(true);
	const second = t.captureCharFrame();
	expect(second).toContain("page 2/2");
	expect(second).not.toContain("wf-newest");
	expect(db.pageReads.at(-1)).toEqual({ page: 2 });

	// The last page is the end of the list: a further `]` reads nothing new.
	t.mockInput.pressKey("]");
	await t.renderOnce();
	expect(db.pageReads.at(-1)).toEqual({ page: 2 });

	t.mockInput.pressKey("[");
	expect(await renderUntil(t, "wf-newest")).toBe(true);
	expect(db.pageReads.at(-1)).toEqual({ page: 1 });

	// Opening a trace fetches exactly that workflow's spans.
	t.mockInput.pressEnter();
	expect(await renderUntil(t, "Span tree")).toBe(true);
	expect(db.spanReads).toEqual(["wf-newest"]);
	t.renderer.destroy();
});
