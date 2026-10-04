/** @jsxImportSource @opentui/solid */
// Workspace sidebar render test (integrated-multiplexer sidebar): the shell
// shows the durable workflows, collapses them to indices while unfocused,
// filters them from the keyboard, moves panel focus with Shift+H/L, opens the
// selected workflow's dashboard page, and reports a missing tmux on `n`. The
// overview read is stubbed at the gateway port, so the test pins presentation
// and navigation rather than the store.
import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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
			verificationRound: 0,
			runs: [],
		},
		tasks: [0, 0],
		agents: [],
	};
}

/** Temp configuration each render uses, so a sidebar toggle can never write to
 * the developer's real config; `currentConfigFile` is the file the last render
 * read and saved to. */
const tempConfigDirs: string[] = [];
let currentConfigFile = "";

afterEach(() => {
	delete process.env.HERDR_WORKFLOW_CONFIG;
	for (const dir of tempConfigDirs.splice(0))
		rmSync(dir, { recursive: true, force: true });
});

function persistedSidebarMode(): unknown {
	return (
		JSON.parse(readFileSync(currentConfigFile, "utf8")) as {
			ui?: { sidebar_mode?: unknown };
		}
	).ui?.sidebar_mode;
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
	const configDir = mkdtempSync(join(tmpdir(), "sidebar-config-"));
	currentConfigFile = join(configDir, "config.json");
	writeFileSync(currentConfigFile, "{}\n");
	tempConfigDirs.push(configDir);
	process.env.HERDR_WORKFLOW_CONFIG = currentConfigFile;
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

/** Focus the sidebar (the dedicated Ctrl+S toggle) and let the expand animation
 * settle. */
async function focusSidebar(t: Test): Promise<void> {
	t.mockInput.pressKey("s", { ctrl: true });
	await advance(t, 4, 60);
}

/** Leave the sidebar for the page body (the same toggle). */
async function unfocusSidebar(t: Test): Promise<void> {
	t.mockInput.pressKey("s", { ctrl: true });
	await advance(t, 4, 60);
}

test("the sidebar collapses to indices while unfocused and expands on focus", async () => {
	stubGateway();
	const t = await renderShell();
	try {
		// Unfocused: index-only rows, no workflow names.
		expect(await renderUntil(t, "Workspaces")).toBe(false);
		expect(t.captureCharFrame()).toContain("1");
		expect(t.captureCharFrame()).not.toContain("wf-active");

		await focusSidebar(t);
		expect(await renderUntil(t, "Workspaces")).toBe(true);
		expect(t.captureCharFrame()).toContain("wf-active");
		// The default filter hides completed workflows.
		expect(t.captureCharFrame()).not.toContain("wf-done");

		// Unfocus: the panel slides back to the index-only strip.
		await unfocusSidebar(t);
		expect(t.captureCharFrame()).not.toContain("wf-active");
	} finally {
		t.renderer.destroy();
		clearGateway();
	}
});

test("the sidebar filters workflows with f", async () => {
	stubGateway();
	const t = await renderShell();
	try {
		await focusSidebar(t);
		expect(await renderUntil(t, "wf-active")).toBe(true);

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

test("Enter opens the selected workflow's dashboard page", async () => {
	stubGateway();
	const t = await renderShell();
	try {
		await focusSidebar(t);
		expect(await renderUntil(t, "wf-active")).toBe(true);
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

test("e toggles a permanent sidebar that stays expanded while unfocused", async () => {
	stubGateway();
	const t = await renderShell();
	try {
		await focusSidebar(t);
		expect(await renderUntil(t, "wf-active")).toBe(true);

		// Permanent: leaving the panel keeps the full rows and title visible,
		// and the choice is written to the configuration for the next start.
		t.mockInput.pressKey("e");
		await unfocusSidebar(t);
		expect(t.captureCharFrame()).toContain("Workspaces");
		expect(t.captureCharFrame()).toContain("wf-active");
		expect(persistedSidebarMode()).toBe("permanent");

		// Back to expanding: unfocusing collapses it to the index strip again.
		await focusSidebar(t);
		t.mockInput.pressKey("e");
		await unfocusSidebar(t);
		expect(t.captureCharFrame()).not.toContain("wf-active");
		expect(persistedSidebarMode()).toBe("expanding");
	} finally {
		t.renderer.destroy();
		clearGateway();
	}
});

test("the footer advertises the sidebar toggle exactly once", async () => {
	stubGateway();
	const t = await renderShell();
	try {
		const count = () => t.captureCharFrame().split("Ctrl+S").length - 1;
		expect(count()).toBe(1);
		t.mockInput.pressKey("s", { ctrl: true });
		await advance(t, 4, 60);
		expect(count()).toBe(1);
	} finally {
		t.renderer.destroy();
		clearGateway();
	}
});

test("Ctrl+S toggles sidebar focus from any surface", async () => {
	stubGateway();
	const t = await renderShell();
	try {
		// Content focus -> sidebar: the dedicated host key works without the
		// page body's own panel keys. The panel then expands.
		t.mockInput.pressKey("s", { ctrl: true });
		expect(await renderUntil(t, (frame) => frame.includes("filter"))).toBe(
			true,
		);
		await advance(t, 4, 60);
		expect(t.captureCharFrame()).toContain("wf-active");

		// Sidebar focus -> content, and the panel collapses again.
		t.mockInput.pressKey("s", { ctrl: true });
		await advance(t, 4, 60);
		expect(t.captureCharFrame()).not.toContain("wf-active");
	} finally {
		t.renderer.destroy();
		clearGateway();
	}
});

test("the title-row glyph pins the sidebar open, the collapsed glyph expands it", async () => {
	stubGateway();
	const t = await renderShell();
	try {
		// Collapsed strip: the expand glyph sits at the top-left of the panel.
		expect(t.captureCharFrame()).not.toContain("wf-active");
		await t.mockMouse.click(1, 1);
		await advance(t, 4, 60);
		expect(t.captureCharFrame()).toContain("wf-active");
		expect(persistedSidebarMode()).toBe("permanent");

		// Expanded title row: clicking the glyph returns it to auto-collapse.
		await t.mockMouse.click(32, 1);
		await advance(t, 4, 60);
		await unfocusSidebar(t);
		expect(t.captureCharFrame()).not.toContain("wf-active");
		expect(persistedSidebarMode()).toBe("expanding");
	} finally {
		t.renderer.destroy();
		clearGateway();
	}
});

test("+ opens the new-workflow form from the sidebar", async () => {
	stubGateway();
	const t = await renderShell();
	try {
		await focusSidebar(t);
		expect(await renderUntil(t, "wf-active")).toBe(true);
		t.mockInput.pressKey("+");
		expect(
			await renderUntil(t, (frame) => frame.includes("New workflow")),
		).toBe(true);
	} finally {
		t.renderer.destroy();
		clearGateway();
	}
});

test("n reports an error when no tmux client is available", async () => {
	stubGateway();
	const previousTmux = process.env.TMUX;
	delete process.env.TMUX;
	const t = await renderShell();
	try {
		await focusSidebar(t);
		expect(await renderUntil(t, "wf-active")).toBe(true);
		t.mockInput.pressKey("n");
		expect(
			await renderUntil(t, (frame) => frame.includes("tmux is not available")),
		).toBe(true);
	} finally {
		if (previousTmux !== undefined) process.env.TMUX = previousTmux;
		t.renderer.destroy();
		clearGateway();
	}
});
