// Every notification toast on both TUI surfaces must emit one OTEL span. The
// free-form message is never allowed into the span (tracing value contract);
// only the bounded kind/surface constants are recorded.
import { afterEach, expect, test } from "bun:test";
import {
	notify as dashNotify,
	resetNotifications as resetDash,
} from "../../src/tui/dash/notifications";
import {
	notify as otelNotify,
	resetNotifications as resetOtel,
} from "../../src/tui/otel/app/notifications";

type CapturedSpan = {
	name: string;
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
	resetDash();
	resetOtel();
});

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

function attribute(span: CapturedSpan | undefined, key: string) {
	return span?.attributes.find((entry) => entry.key === key)?.value
		?.stringValue;
}

test("each toast emits one span carrying surface, action, and kind", async () => {
	process.env.OTEL_EXPORTER_OTLP_TRACES_ENDPOINT =
		"http://127.0.0.1:9/v1/traces";
	const spans = captureSpans();

	dashNotify("Profile saved", "success");
	otelNotify("memory leak detected", "warning");
	await Bun.sleep(0);
	await Bun.sleep(0);

	expect(spans).toHaveLength(2);
	expect(spans[0]?.name).toBe("tui.notification");
	expect(attribute(spans[0], "tui.surface")).toBe("dash");
	expect(attribute(spans[0], "tui.action")).toBe("notify");
	expect(attribute(spans[0], "tui.kind")).toBe("success");
	expect(spans[0]?.status.code).toBe(1);
	expect(attribute(spans[1], "tui.surface")).toBe("observability");
	expect(attribute(spans[1], "tui.kind")).toBe("warning");
	// The message text never reaches telemetry.
	expect(JSON.stringify(spans)).not.toContain("memory leak detected");
});

test("error toasts mark the span ERROR", async () => {
	process.env.OTEL_EXPORTER_OTLP_TRACES_ENDPOINT =
		"http://127.0.0.1:9/v1/traces";
	const spans = captureSpans();

	dashNotify("/home/dev/secret-repo failed", "error");
	await Bun.sleep(0);

	expect(spans[0]?.status.code).toBe(2);
	expect(attribute(spans[0], "tui.outcome")).toBe("error");
	expect(JSON.stringify(spans[0] ?? {})).not.toContain("/home/dev/secret-repo");
});
