/** Security regression for the observability key diagnostic (SEC-001/SEC-002):
 * navigation keys emit a bounded `tui.observability.key` span, while any
 * character that could be passphrase/search/filter entry (dashboard prompt
 * open, search mode, theme filtering) is suppressed before it can reach the
 * OTLP endpoint. Transport is mocked with a synchronous recorder. */
/** @jsxImportSource @opentui/solid */
import { afterEach, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { testRender } from "@opentui/solid";
import { isKeyTraceSuppressed } from "../../src/tui/dash/tracing";
import { App } from "../../src/tui/otel/app/App";
import { TraceDb } from "../../src/tui/otel/model/db";
import { LogStore } from "../../src/tui/otel/model/logStore";
import { MetricStore } from "../../src/tui/otel/model/metricStore";
import { TopologyStore } from "../../src/tui/otel/model/topologyStore";
import { TraceStore } from "../../src/tui/otel/model/traceStore";

type RecordedSpan = {
	name: string;
	attributes: Array<{ key: string; value: { stringValue?: string } }>;
};

const originalFetch = globalThis.fetch;
let spans: RecordedSpan[] = [];

afterEach(() => {
	globalThis.fetch = originalFetch;
	spans = [];
});

function capture(): void {
	spans = [];
	globalThis.fetch = (async (_url, init) => {
		const body = JSON.parse(String(init?.body ?? "{}")) as {
			resourceSpans?: Array<{ scopeSpans?: Array<{ spans?: RecordedSpan[] }> }>;
		};
		for (const resource of body.resourceSpans ?? [])
			for (const scope of resource.scopeSpans ?? [])
				spans.push(...(scope.spans ?? []));
		return new Response("", { status: 200 });
	}) as typeof fetch;
}

function observedKeyNames(): string[] {
	return spans
		.filter((span) => span.name === "tui.observability.key")
		.map(
			(span) =>
				span.attributes.find((attr) => attr.key === "tui.key")?.value
					?.stringValue ?? "",
		);
}

async function renderOtelApp() {
	const dir = mkdtempSync(join(tmpdir(), "otel-key-trace-"));
	const db = new TraceDb(dir);
	const t = await testRender(
		() => (
			<App
				repos={["/demo"]}
				db={db}
				traceStore={new TraceStore()}
				metricStore={new MetricStore()}
				logStore={new LogStore()}
				topologyStore={new TopologyStore()}
			/>
		),
		{ width: 120, height: 40 },
	);
	return { t, db };
}

test("isKeyTraceSuppressed gates key diagnostics during any text-entry context", () => {
	expect(
		isKeyTraceSuppressed({
			anyModalOpen: true,
			searchEntry: false,
			filterEntry: false,
			wikiCommentEntry: false,
		}),
	).toBe(true);
	expect(
		isKeyTraceSuppressed({
			anyModalOpen: false,
			searchEntry: true,
			filterEntry: false,
			wikiCommentEntry: false,
		}),
	).toBe(true);
	expect(
		isKeyTraceSuppressed({
			anyModalOpen: false,
			searchEntry: false,
			filterEntry: true,
			wikiCommentEntry: false,
		}),
	).toBe(true);
	expect(
		isKeyTraceSuppressed({
			anyModalOpen: false,
			searchEntry: false,
			filterEntry: false,
			wikiCommentEntry: true,
		}),
	).toBe(true);
	expect(
		isKeyTraceSuppressed({
			anyModalOpen: false,
			searchEntry: false,
			filterEntry: false,
			wikiCommentEntry: false,
		}),
	).toBe(false);
});

test("navigation keys emit a bounded observability key diagnostic", async () => {
	capture();
	const { t, db } = await renderOtelApp();
	await t.renderOnce();

	t.mockInput.pressKey("j");
	await t.renderOnce();

	expect(observedKeyNames()).toContain("j");
	expect(
		spans.some(
			(span) =>
				span.name === "tui.observability.key" &&
				span.attributes.some(
					(attr) =>
						attr.key === "tui.surface" &&
						attr.value?.stringValue === "observability",
				),
		),
	).toBe(true);
	t.renderer.destroy();
	db.close();
});

test("typed search characters never reach a span", async () => {
	capture();
	const { t, db } = await renderOtelApp();
	await t.renderOnce();

	// Enter trace search mode with "/", then type characters that would have
	// been exported verbatim before the text-entry gate.
	t.mockInput.pressKey("/");
	await t.renderOnce();
	t.mockInput.pressKey("a");
	t.mockInput.pressKey("$");
	t.mockInput.pressKey("9");
	await t.renderOnce();

	const keys = observedKeyNames();
	expect(keys).not.toContain("a");
	expect(keys).not.toContain("$");
	expect(keys).not.toContain("9");
	// The "/" that opened search is a fixed navigation key, not character entry.
	expect(keys).toContain("/");
	t.renderer.destroy();
	db.close();
});
