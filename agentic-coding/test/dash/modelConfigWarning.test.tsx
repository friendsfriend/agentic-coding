/** @jsxImportSource @opentui/solid */
import { afterEach, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { testRender } from "@opentui/solid";
import {
	activeNotification,
	resetNotifications,
} from "../../src/tui/dash/notifications";
import { ModelConfigModal } from "../../src/tui/dash/ui/ModelConfigModal";

type CapturedSpan = {
	name: string;
	attributes: Array<{ key: string; value: { stringValue?: string } }>;
};

const originalFetch = globalThis.fetch;
const originalEndpoint = process.env.OTEL_EXPORTER_OTLP_TRACES_ENDPOINT;

afterEach(() => {
	globalThis.fetch = originalFetch;
	if (originalEndpoint === undefined)
		delete process.env.OTEL_EXPORTER_OTLP_TRACES_ENDPOINT;
	else process.env.OTEL_EXPORTER_OTLP_TRACES_ENDPOINT = originalEndpoint;
	resetNotifications();
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

test("library warnings while the agent editor is open become warning toasts and telemetry", async () => {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "model-warn-test-"));
	process.env.HERDR_WORKFLOW_CONFIG = path.join(dir, "config.toml");
	fs.writeFileSync(process.env.HERDR_WORKFLOW_CONFIG, "[agents]\n");
	process.env.OTEL_EXPORTER_OTLP_TRACES_ENDPOINT =
		"http://127.0.0.1:9/v1/traces";
	const spans = captureSpans();
	const consoleWarnBeforeMount = console.warn;
	try {
		const t = await testRender(
			() => <ModelConfigModal onKeyReady={() => {}} onCancel={() => {}} />,
			{ width: 90, height: 26 },
		);
		await t.flush();
		resetNotifications();

		console.warn("Potential memory leak detected: buffer not disposed");
		await Bun.sleep(0);

		expect(activeNotification()?.type).toBe("warning");
		expect(activeNotification()?.message).toContain("memory leak");
		const leakSpan = spans.find(
			(span) => attribute(span, "tui.kind") === "leak",
		);
		expect(leakSpan?.name).toBe("tui.model_config.console");
		expect(attribute(leakSpan, "tui.surface")).toBe("model-config");
		expect(attribute(leakSpan, "tui.action")).toBe("console-warn");
		// The free-form warning text never reaches telemetry.
		expect(JSON.stringify(spans)).not.toContain("buffer not disposed");

		t.renderer.destroy();
		// Unmounting releases the intercept for the rest of the session.
		expect(console.warn).toBe(consoleWarnBeforeMount);
	} finally {
		delete process.env.HERDR_WORKFLOW_CONFIG;
		fs.rmSync(dir, { recursive: true, force: true });
	}
}, 20000);
