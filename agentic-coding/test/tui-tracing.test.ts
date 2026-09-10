// Focused coverage for the TUI operational tracing adapter: receiver-compatible
// span identity/shape, allowlisted safe attributes, ERROR status, bounded
// values, and non-throwing export failures.
import { afterEach, expect, test } from "bun:test";
import { isKeyTraceSuppressed, traceTui } from "../src/tui/dash/tracing";

type CapturedSpan = {
	traceId: string;
	spanId: string;
	name: string;
	startTimeUnixNano: string;
	endTimeUnixNano: string;
	status: { code: number };
	attributes: Array<{ key: string; value: { stringValue?: string } }>;
};

const originalFetch = globalThis.fetch;
const originalEndpoint = process.env.OTEL_EXPORTER_OTLP_TRACES_ENDPOINT;

afterEach(() => {
	globalThis.fetch = originalFetch;
	if (originalEndpoint === undefined)
		delete process.env.OTEL_EXPORTER_OTLP_TRACES_ENDPOINT;
	else process.env.OTEL_EXPORTER_OTLP_TRACES_ENDPOINT = originalEndpoint;
});

/** Replace the OTLP transport with a recorder that returns the decoded spans. */
function captureSpans(): CapturedSpan[] {
	const spans: CapturedSpan[] = [];
	globalThis.fetch = (async (_url, init) => {
		const body = JSON.parse(String(init?.body ?? "{}")) as {
			resourceSpans?: Array<{ scopeSpans?: Array<{ spans?: CapturedSpan[] }> }>;
		};
		for (const resource of body.resourceSpans ?? [])
			for (const scope of resource.scopeSpans ?? [])
				spans.push(...(scope.spans ?? []));
		return new Response("", { status: 200 });
	}) as typeof fetch;
	return spans;
}

function attribute(spans: CapturedSpan[], key: string): string | undefined {
	return spans[0]?.attributes.find((entry) => entry.key === key)?.value
		?.stringValue;
}

test("emits a completed receiver-compatible span with allowlisted attributes", async () => {
	process.env.OTEL_EXPORTER_OTLP_TRACES_ENDPOINT =
		"http://127.0.0.1:9/v1/traces";
	const spans = captureSpans();
	traceTui(
		"tui.dashboard.action",
		{
			surface: "dashboard",
			action: "approve-plan",
			secret: "do-not-leak",
			content: "artifact body",
		},
		"ok",
		25,
	);
	await Bun.sleep(0);

	expect(spans).toHaveLength(1);
	const span = spans[0];
	if (!span) throw new Error("expected one exported span");
	expect(span.name).toBe("tui.dashboard.action");
	expect(span.traceId).toMatch(/^[0-9a-f]{32}$/);
	expect(span.spanId).toMatch(/^[0-9a-f]{16}$/);
	expect(span.traceId).not.toBe("0".repeat(32));
	expect(Number(span.endTimeUnixNano)).toBeGreaterThan(
		Number(span.startTimeUnixNano),
	);
	expect(span.status.code).toBe(1);
	expect(attribute(spans, "tui.surface")).toBe("dashboard");
	expect(attribute(spans, "tui.action")).toBe("approve-plan");
	expect(attribute(spans, "tui.outcome")).toBe("ok");
	expect(attribute(spans, "tui.secret")).toBeUndefined();
	expect(attribute(spans, "tui.content")).toBeUndefined();
	expect(JSON.stringify(span)).not.toContain("do-not-leak");
	expect(JSON.stringify(span)).not.toContain("artifact body");
});

test("marks failed outcomes ERROR without leaking dynamic error text", async () => {
	process.env.OTEL_EXPORTER_OTLP_TRACES_ENDPOINT =
		"http://127.0.0.1:9/v1/traces";
	const spans = captureSpans();
	traceTui(
		"tui.dashboard.refresh",
		{
			surface: "dashboard",
			action: "refresh",
			message: "boom: /home/dev/secret-repo",
		},
		"error",
	);
	await Bun.sleep(0);

	expect(spans[0]?.status.code).toBe(2);
	expect(attribute(spans, "tui.outcome")).toBe("error");
	expect(JSON.stringify(spans[0] ?? {})).not.toContain("/home/dev/secret-repo");
});

test("bounds allowlisted attribute values", async () => {
	process.env.OTEL_EXPORTER_OTLP_TRACES_ENDPOINT =
		"http://127.0.0.1:9/v1/traces";
	const spans = captureSpans();
	traceTui("tui.dashboard.key", {
		surface: "dashboard",
		action: "key",
		key: "x".repeat(500),
	});
	await Bun.sleep(0);

	expect(attribute(spans, "tui.key")).toHaveLength(96);
});

test("never throws when the OTLP export fails", async () => {
	process.env.OTEL_EXPORTER_OTLP_TRACES_ENDPOINT =
		"http://127.0.0.1:1/v1/traces";
	globalThis.fetch = (async () => {
		throw new Error("connection refused");
	}) as unknown as typeof fetch;

	expect(() =>
		traceTui("tui.process.startup", {
			surface: "process",
			action: "renderer-created",
		}),
	).not.toThrow();
	await Bun.sleep(0);
});

test("drops non-printable control sequences from span values", async () => {
	process.env.OTEL_EXPORTER_OTLP_TRACES_ENDPOINT =
		"http://127.0.0.1:9/v1/traces";
	const spans = captureSpans();
	traceTui("tui.dashboard.key", {
		surface: "dashboard",
		action: "key",
		key: "\x1B[31mred\x1B[0m",
	});
	await Bun.sleep(0);

	expect(attribute(spans, "tui.key")).toBeUndefined();
});

test("isKeyTraceSuppressed forbids key diagnostics during text entry", () => {
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
