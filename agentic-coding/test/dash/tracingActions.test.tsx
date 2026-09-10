/** Task 3.2 focused coverage: dashboard action success, dashboard action
 * failure, and overview/TUI key diagnostics all emit bounded OTLP spans with
 * the right outcome while dynamic input/error text is absent. Transport is
 * mocked so real spans can be asserted; the dashboard/overview harness mirrors
 * the other dash render tests. */
/** @jsxImportSource @opentui/solid */
import { afterEach, expect, test } from "bun:test";
import { createDefaultOpenTuiKeymap } from "@opentui/keymap/opentui";
import { testRender, useRenderer } from "@opentui/solid";
import { onCleanup } from "solid-js";
import { App } from "../../src/tui/dash/App";
import type { WorkflowOverview } from "../../src/tui/dash/data";
import { type DashboardData, testDashboard } from "../../src/tui/dash/data";
import { Home } from "../../src/tui/dash/Home";

type RecordedSpan = {
	name: string;
	status: { code: number };
	attributes: Array<{ key: string; value: { stringValue?: string } }>;
};

const originalFetch = globalThis.fetch;
const originalEndpoint = process.env.OTEL_EXPORTER_OTLP_TRACES_ENDPOINT;
let spans: RecordedSpan[] = [];

afterEach(() => {
	globalThis.fetch = originalFetch;
	if (originalEndpoint === undefined)
		delete process.env.OTEL_EXPORTER_OTLP_TRACES_ENDPOINT;
	else process.env.OTEL_EXPORTER_OTLP_TRACES_ENDPOINT = originalEndpoint;
	spans = [];
});

/** Replace the OTLP transport with a synchronous recorder for this test. */
function installCapture(): void {
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

function attribute(
	span: RecordedSpan | undefined,
	key: string,
): string | undefined {
	return span?.attributes.find((entry) => entry.key === key)?.value
		?.stringValue;
}

function TestDashboard(props: { testData?: DashboardData } = {}) {
	const renderer = useRenderer();
	const keymap = createDefaultOpenTuiKeymap(renderer);
	const disposeKeymap = keymap.appendEventMatchResolver((event, ctx) => {
		if (
			!event.shift ||
			event.ctrl ||
			event.meta ||
			event.super ||
			event.name.length !== 1
		)
			return undefined;
		const upper = event.name.toUpperCase();
		return upper !== event.name
			? [
					ctx.resolveKey({
						name: upper,
						ctrl: false,
						shift: false,
						meta: false,
						super: false,
					}),
				]
			: undefined;
	});
	const dispose = keymap.registerLayerFields({
		name() {},
		appView(value, ctx) {
			ctx.require("app.view", String(value));
		},
		activeModal(value, ctx) {
			ctx.require("modal.active", String(value));
		},
	});
	onCleanup(() => {
		disposeKeymap();
		dispose();
	});
	return (
		<App
			repo="/demo"
			workflowId="demo"
			profile="test"
			testData={props.testData}
			keymap={keymap}
		/>
	);
}

function overview(): WorkflowOverview {
	return {
		state: {
			workflowId: "demo-change",
			changeId: "demo-change",
			phase: "implement",
			revision: 0,
			status: "active",
			health: { valid: true, attention: [] },
			repository: "/demo/repo",
			worktree: "/demo/repo",
			branch: "demo",
			workspace: "demo",
			verificationRound: 0,
			runs: [],
			panes: {},
		},
		workspaceOpen: true,
		tasks: [1, 2],
		agents: [],
	};
}

function TestHome(props: { items: WorkflowOverview[] }) {
	const renderer = useRenderer();
	const keymap = createDefaultOpenTuiKeymap(renderer);
	const dispose = keymap.registerLayerFields({
		name() {},
		appView(value, ctx) {
			ctx.require("app.view", String(value));
		},
		activeModal(value, ctx) {
			ctx.require("modal.active", String(value));
		},
	});
	onCleanup(dispose);
	return (
		<Home
			keymap={keymap}
			items={props.items}
			loading={false}
			projects={[]}
			refresh={() => {}}
		/>
	);
}

test("dashboard finish action traces a safe success span without demo text", async () => {
	installCapture();
	const t = await testRender(() => <TestDashboard />, {
		width: 120,
		height: 40,
	});

	await t.waitForFrame((frame) => frame.includes("Plan review"));
	t.mockInput.pressKey("f");
	await t.waitForFrame((frame) => !frame.includes("Plan review"));

	const reviewSpans = spans.filter(
		(span) => span.name === "tui.dashboard.review",
	);
	expect(reviewSpans.length).toBeGreaterThan(0);
	expect(
		reviewSpans.find(
			(span) => attribute(span, "tui.action") === "review-approved",
		)?.status.code,
	).toBe(1);
	expect(
		attribute(
			reviewSpans.find(
				(span) => attribute(span, "tui.action") === "review-approved",
			),
			"tui.surface",
		),
	).toBe("dashboard");
	expect(
		attribute(
			reviewSpans.find(
				(span) => attribute(span, "tui.action") === "review-approved",
			),
			"tui.outcome",
		),
	).toBe("ok");
	// Dynamic demo outcome text stays out of the span payload.
	expect(JSON.stringify(reviewSpans)).not.toContain("Advanced dummy workflow");

	// Pressing r with no modal open routes through the dashboard key diagnostic
	// and a refresh span; both stay bounded.
	t.mockInput.pressKey("r");
	await t.renderOnce();
	expect(
		spans.some(
			(span) =>
				span.name === "tui.dashboard.key" &&
				attribute(span, "tui.key") === "r" &&
				attribute(span, "tui.modal") === "none",
		),
	).toBe(true);
	expect(
		spans.some(
			(span) =>
				span.name === "tui.dashboard.refresh" &&
				attribute(span, "tui.action") === "refresh" &&
				span.status.code === 1,
		),
	).toBe(true);
	t.renderer.destroy();
});

test("dashboard return-workspace failure traces an ERROR span without error text", async () => {
	installCapture();
	// "apply" phase has no auto-opened modal, so Escape reaches handleKey and
	// fails on the missing return-workspace (deterministic in the test profile).
	const t = await testRender(
		() => <TestDashboard testData={testDashboard("apply")} />,
		{ width: 120, height: 40 },
	);
	await t.waitForFrame((frame) => frame.includes("Change ("));

	t.mockInput.pressEscape();

	// A lone ESC byte resolves as a keypress asynchronously in the test parser;
	// poll until the traced failure span lands.
	let failed: RecordedSpan | undefined;
	for (let attempt = 0; attempt < 20 && !failed; attempt++) {
		await Bun.sleep(25);
		await t.renderOnce();
		failed = spans.find(
			(span) =>
				span.name === "tui.dashboard.action" &&
				attribute(span, "tui.action") === "return-workspace",
		);
	}
	expect(failed?.status.code).toBe(2);
	expect(attribute(failed, "tui.outcome")).toBe("error");
	expect(attribute(failed, "tui.surface")).toBe("dashboard");
	expect(JSON.stringify(failed ?? {})).not.toContain("No dashboard workspace");
	t.renderer.destroy();
});

test("overview key diagnostic traces a bounded span", async () => {
	installCapture();
	const t = await testRender(() => <TestHome items={[overview()]} />, {
		width: 120,
		height: 40,
	});
	await t.flush();

	t.mockInput.pressKey("?");
	await t.renderOnce();

	expect(
		spans.some(
			(span) =>
				span.name === "tui.overview.key" &&
				attribute(span, "tui.surface") === "overview" &&
				attribute(span, "tui.key") === "?",
		),
	).toBe(true);
	t.renderer.destroy();
});
