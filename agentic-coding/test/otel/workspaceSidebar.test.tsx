/** @jsxImportSource @opentui/solid */
// Workspace sidebar render test (integrated-multiplexer sidebar): the shell
// shows the durable workflows, filters them from the keyboard, moves panel
// focus with Shift+H/L, and opens the selected workflow's dashboard page. The
// overview read is stubbed at the gateway port, so the test pins presentation
// and navigation rather than the store.
import { expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createDefaultOpenTuiKeymap } from "@opentui/keymap/opentui";
import { testRender, useRenderer } from "@opentui/solid";
import { onCleanup } from "solid-js";
import type { ObservationRequest } from "../../src/contracts/environment.ts";
import type { DashboardGateway } from "../../src/contracts/gateway.ts";
import type { WorkflowOverview } from "../../src/contracts/workflow.ts";
import { TraceDb } from "../../src/server/telemetry-db";
import { setupKeymap } from "../../src/tui/dash/keymap-setup.ts";
import { clearGateway, configureGateway } from "../../src/tui/data/index.ts";
import { App } from "../../src/tui/otel/app/App.tsx";
import { LogStore } from "../../src/tui/otel/model/logStore.ts";
import { MetricStore } from "../../src/tui/otel/model/metricStore.ts";
import { TopologyStore } from "../../src/tui/otel/model/topologyStore.ts";
import { TraceStore } from "../../src/tui/otel/model/traceStore.ts";
import { advance, renderUntil, type Test } from "../app/support/terminal.ts";

function overview(
	workflowId: string,
	status: WorkflowOverview["state"]["status"],
): WorkflowOverview {
	return {
		state: {
			workflowId,
			changeId: "",
			phase: "apply",
			stepLabel: "Apply",
			revision: 1,
			status,
			health: { valid: true, attention: [] },
			repository: "/demo",
			worktree: "/demo",
			branch: "main",
			workspace: "",
			verificationRound: 0,
			runs: [],
			panes: {},
		},
		workspaceOpen: false,
		tasks: [0, 0],
		agents: [],
	};
}

const OVERVIEWS = [
	overview("wf-active", "active"),
	overview("wf-attention", "attention-required"),
	overview("wf-done", "completed"),
];

function stubGateway(): void {
	configureGateway({
		kind: "in-process",
		connectionState: () => "open",
		observe: async (observation: ObservationRequest) => {
			if (observation.kind === "workflows") return OVERVIEWS;
			throw new Error(`unexpected observation ${observation.kind}`);
		},
		view: async () => {
			throw new Error("no workflow view in this stub");
		},
		subscribe: () => () => {},
	} as unknown as DashboardGateway);
}

async function renderShell(): Promise<Test> {
	const db = new TraceDb(mkdtempSync(join(tmpdir(), "sidebar-render-")));
	const t = await testRender(
		() => {
			const renderer = useRenderer();
			const keymap = createDefaultOpenTuiKeymap(renderer);
			const disposeKeymap = setupKeymap(keymap);
			keymap.setData("modal.active", "none");
			onCleanup(disposeKeymap);
			return (
				<App
					repos={["/demo"]}
					db={db}
					traceStore={new TraceStore()}
					metricStore={new MetricStore()}
					logStore={new LogStore()}
					topologyStore={new TopologyStore()}
					dashboard={{ mode: "home", keymap }}
				/>
			);
		},
		{ width: 140, height: 40 },
	);
	await advance(t);
	return t;
}

test("the sidebar lists running workflows and filters them with f", async () => {
	stubGateway();
	const t = await renderShell();
	try {
		expect(await renderUntil(t, "Workspaces")).toBe(true);
		expect(t.captureCharFrame()).toContain("wf-active");
		// The default filter hides completed workflows.
		expect(t.captureCharFrame()).not.toContain("wf-done");

		// Filters are a sidebar key: focus the panel first (the footer then
		// advertises the sidebar's own keys).
		t.mockInput.pressKey("h", { shift: true });
		expect(await renderUntil(t, (frame) => frame.includes("filter"))).toBe(
			true,
		);
		t.mockInput.pressKey("f");
		expect(await renderUntil(t, "wf-attention")).toBe(true);
		expect(t.captureCharFrame()).not.toContain("wf-active");

		t.mockInput.pressKey("f");
		expect(await renderUntil(t, "wf-done")).toBe(true);

		t.mockInput.pressKey("f");
		expect(await renderUntil(t, "wf-active")).toBe(true);
		expect(t.captureCharFrame()).not.toContain("wf-done");
	} finally {
		t.renderer.destroy();
		clearGateway();
	}
});

test("Shift+H focuses the sidebar, Shift+L returns to the page body", async () => {
	stubGateway();
	const t = await renderShell();
	try {
		expect(await renderUntil(t, "wf-active")).toBe(true);
		// Content focus: the page body advertises the way to the sidebar.
		expect(t.captureCharFrame()).toContain("workspaces");

		t.mockInput.pressKey("h", { shift: true });
		expect(await renderUntil(t, (frame) => frame.includes("filter"))).toBe(
			true,
		);

		t.mockInput.pressKey("l", { shift: true });
		expect(await renderUntil(t, (frame) => frame.includes("workspaces"))).toBe(
			true,
		);
	} finally {
		t.renderer.destroy();
		clearGateway();
	}
});

test("Enter opens the selected workflow's dashboard page", async () => {
	stubGateway();
	const t = await renderShell();
	try {
		expect(await renderUntil(t, "wf-active")).toBe(true);
		t.mockInput.pressKey("h", { shift: true });
		await renderUntil(t, (frame) => frame.includes("filter"));
		t.mockInput.pressEnter();
		// The workflow-dashboard route names the workflow in the breadcrumb and
		// the shell badge reports the workflow tab.
		expect(
			await renderUntil(
				t,
				(frame) => frame.includes("wf-active") && frame.includes("workflow"),
			),
		).toBe(true);
	} finally {
		t.renderer.destroy();
		clearGateway();
	}
});
