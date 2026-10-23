/** @jsxImportSource @opentui/solid */
// Workspace sidebar render test (integrated-multiplexer sidebar): the shell
// shows the durable workflows, collapses them to a status glyph plus their
// index while unfocused, filters them from the keyboard, focuses the panel with
// the Ctrl+S host key (and with nothing else), opens the selected workflow's
// dashboard page, and reports a missing tmux on `n`. The
// overview read is stubbed at the gateway port, so the test pins presentation
// and navigation rather than the store.
import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { TextAttributes } from "@opentui/core";
import { createDefaultOpenTuiKeymap } from "@opentui/keymap/opentui";
import { testRender, useRenderer } from "@opentui/solid";
import { activeErrorModal, dismissErrorModal, uiColors } from "@ui";
import { onCleanup } from "solid-js";
import type { ObservationRequest } from "../../src/contracts/environment.ts";
import type { DashboardGateway } from "../../src/contracts/gateway.ts";
import type { WorkflowOverview } from "../../src/contracts/workflow.ts";
import { TraceDb } from "../../src/server/telemetry-db";
import { setupKeymap } from "../../src/tui/dash/keymap-setup.ts";
import { clearGateway, configureGateway } from "../../src/tui/data/index.ts";
import { App } from "../../src/tui/otel/app/App.tsx";
import { SIDEBAR_HOME_PINS } from "../../src/tui/otel/app/sidebar-model.ts";
import {
	SIDEBAR_COLLAPSED_WIDTH,
	SIDEBAR_WIDTH,
	sidebarPanelView,
} from "../../src/tui/otel/components/WorkspaceSidebar.tsx";
import { LogStore } from "../../src/tui/otel/model/logStore.ts";
import { MetricStore } from "../../src/tui/otel/model/metricStore.ts";
import { TopologyStore } from "../../src/tui/otel/model/topologyStore.ts";
import { TraceStore } from "../../src/tui/otel/model/traceStore.ts";
import {
	advance,
	pressEscapeAndSettle,
	renderUntil,
	type Test,
} from "../app/support/terminal.ts";

/** One theme colour as the red/green/blue triple the renderer reports a span's
 * foreground in. */
function rgb(hex: string): [number, number, number] {
	const value = hex.replace("#", "");
	return [
		parseInt(value.slice(0, 2), 16),
		parseInt(value.slice(2, 4), 16),
		parseInt(value.slice(4, 6), 16),
	];
}

function overview(
	workflowId: string,
	status: WorkflowOverview["state"]["status"],
	/** Repository-independent rows keep an empty (or unrelated) repository and
	 * are addressed through their target store instead. */
	overrides: {
		target?: string;
		repository?: string;
		definitionId?: string;
		stepId?: string;
		pendingQuestions?: number;
		attention?: string[];
		valid?: boolean;
		startedBy?: WorkflowOverview["startedBy"];
		verification?: WorkflowOverview["verification"];
		tasks?: [number, number];
	} = {},
): WorkflowOverview {
	return {
		target: overrides.target ?? "/demo",
		state: {
			workflowId,
			changeId: "",
			phase: "apply",
			...(overrides.stepId ? { stepId: overrides.stepId } : {}),
			stepLabel:
				overrides.stepId === "core.verification" ? "Verification" : "Apply",
			revision: 1,
			status,
			health: {
				valid: overrides.valid ?? true,
				attention: overrides.attention ?? [],
			},
			repository: overrides.repository ?? "/demo",
			worktree: "/demo",
			branch: "main",
			verificationRound: 0,
			runs: [],
			...(overrides.pendingQuestions
				? {
						pendingQuestions: Array.from(
							{ length: overrides.pendingQuestions },
							(_, index) =>
								({
									id: `q-${index}`,
									role: "planner",
									prompt: "?",
								}) as unknown as NonNullable<
									WorkflowOverview["state"]["pendingQuestions"]
								>[number],
						),
					}
				: {}),
			...(overrides.definitionId
				? {
						definition: {
							id: overrides.definitionId,
							version: 1,
							digest: "digest",
							label: overrides.definitionId,
						},
					}
				: {}),
		},
		tasks: overrides.tasks ?? [0, 0],
		...(overrides.startedBy ? { startedBy: overrides.startedBy } : {}),
		...(overrides.verification ? { verification: overrides.verification } : {}),
		agents: [],
	};
}

/** Temp configuration each render uses, so a sidebar toggle can never write to
 * the developer's real config; `currentConfigFile` is the file the last render
 * read and saved to. */
const tempConfigDirs: string[] = [];
let currentConfigFile = "";

/** Deletes the stubbed gateway received, in order. The observation read honours
 * them so the sidebar's poll cannot resurrect a deleted row. */
const deletedWorkflows: Array<{ repo: string; workflowId: string }> = [];

afterEach(() => {
	deletedWorkflows.length = 0;
	delete process.env.HERDR_WORKFLOW_CONFIG;
	for (const dir of tempConfigDirs.splice(0))
		rmSync(dir, { recursive: true, force: true });
	// The shell's error modal is a module-level store, so it outlives a destroyed
	// renderer: a dashboard whose background reads fail leaves it up for the next
	// test in this process, where it would own every key and every click.
	dismissErrorModal();
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

function stubGateway(
	overviews: WorkflowOverview[] = OVERVIEWS,
	/** How the dashboard's own view read answers. The workspace cycle opens real
	 * dashboard pages, so a cycle test keeps that read pending: a failed
	 * observation raises the global error modal, which owns every key until it is
	 * dismissed and would swallow the next cycle press. */
	view: "throw" | "pending" = "throw",
): void {
	configureGateway({
		kind: "in-process",
		connectionState: () => "open",
		observe: async (observation: ObservationRequest) => {
			if (observation.kind === "workflows")
				return overviews.filter(
					(entry) =>
						!deletedWorkflows.some(
							(call) => call.workflowId === entry.state.workflowId,
						),
				);
			throw new Error(`unexpected observation ${observation.kind}`);
		},
		view:
			view === "pending"
				? () => new Promise<never>(() => {})
				: async () => {
						throw new Error("no workflow view in this stub");
					},
		deleteWorkflow: async (request: { repo: string; workflowId: string }) => {
			deletedWorkflows.push(request);
			return { worktreeRemoved: false };
		},
		subscribe: () => () => {},
	} as unknown as DashboardGateway);
}

async function renderShell(
	/** Kitty keyboard protocol: the terminal that reports Ctrl+H as its own key
	 * instead of the Backspace byte. */
	options: { kittyKeyboard?: boolean } = {},
): Promise<Test> {
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
		{ width: 140, height: 40, ...options },
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

/** Move the sidebar cursor past the Home pins onto the first workflow row. */
async function selectFirstWorkflow(t: Test): Promise<void> {
	for (let index = 0; index < SIDEBAR_HOME_PINS.length; index += 1) {
		t.mockInput.pressKey("j");
		await advance(t);
	}
}

/** The breadcrumb row of a frame: the line carrying the separator, or "" on a
 * page with no ancestors (Home). It is read from the frame the renderer handed
 * back rather than captured again, so a predicate never re-captures mid-render
 * and the workspace the page body landed on is judged by the crumb alone — the
 * sidebar rows name workflows too. */
function crumbLine(frame: string): string {
	return frame.split("\n").find((line) => line.includes("›")) ?? "";
}

/** Wait until the page body shows `workspace` — the crumb names the resource of
 * the workspace a cycle press opened. */
async function renderWorkspace(t: Test, workspace: string): Promise<boolean> {
	return renderUntil(t, (frame) => crumbLine(frame).includes(workspace));
}

/** A workflow dashboard reads its own view and observability data on mount, and
 * this stub answers only the workflow list, so the dashboard reports the failed
 * reads through the shell's global error modal — which owns every key until it is
 * dismissed. A real dashboard reaches its gateway, so this only ever fires here;
 * clear it so the next cycle press is delivered instead of being eaten. */
async function dismissObservationError(t: Test): Promise<void> {
	if (!activeErrorModal()) return;
	await pressEscapeAndSettle(t, () => !activeErrorModal());
}

/** The collapsed strip of a frame: its leftmost columns on every line. Only the
 * strip (the toggle glyph, the pinned entry and one row per workflow) draws
 * there, so this block is everything a glance at the collapsed sidebar reads. */
function collapsedStrip(frame: string): string {
	return frame
		.split("\n")
		.map((line) => line.slice(0, SIDEBAR_COLLAPSED_WIDTH))
		.join("\n");
}

/** One stacked row of the collapsed strip, as the renderer painted it: the
 * index line names the row, then the glyph and phase signal follow on the next
 * two lines. Captured spans carry each line's tone colour and weight. */
function collapsedMark(
	t: Test,
	position: number,
): {
	index: string;
	indexBold: boolean;
	glyph: string;
	bold: boolean;
	fg: string;
	signal: string;
	signalFg: string;
} {
	const rows = t.captureCharFrame().split("\n");
	const row = rows.findIndex(
		(line) =>
			line.slice(0, SIDEBAR_COLLAPSED_WIDTH).slice(2).trimEnd() ===
			String(position),
	);
	if (row < 0) throw new Error(`no collapsed row at position ${position}`);
	const content = (offset: number): string =>
		rows[row + offset]?.slice(0, SIDEBAR_COLLAPSED_WIDTH).slice(2).trim() ?? "";
	const index = content(0);
	const glyph = content(1);
	const signal = content(2);
	const spans = t.captureSpans().lines;
	const indexSpan = spans[row]?.spans.find(
		(entry) => entry.text.trim() === index,
	);
	const glyphSpan = spans[row + 1]?.spans.find(
		(entry) => entry.text.trim() === glyph,
	);
	const signalSpan = spans[row + 2]?.spans.find(
		(entry) => entry.text.trim() === signal,
	);
	if (!indexSpan || !glyphSpan || !signalSpan) {
		throw new Error(`missing spans for the collapsed row at ${position}`);
	}
	return {
		index,
		indexBold: (indexSpan.attributes & TextAttributes.BOLD) !== 0,
		glyph,
		bold: (glyphSpan.attributes & TextAttributes.BOLD) !== 0,
		fg: glyphSpan.fg.buffer.slice(0, 3).join(","),
		signal,
		signalFg: signalSpan.fg.buffer.slice(0, 3).join(","),
	};
}

/** One expected mark: the row's index and glyph in the strip, then the tone
 * colour and whether the glyph is painted bold. */
function expectMark(
	t: Test,
	position: number,
	glyph: string,
	color: string,
	bold: boolean,
): void {
	const mark = collapsedMark(t, position);
	expect(mark.index).toBe(String(position));
	expect(mark.indexBold).toBe(true);
	expect(mark.glyph).toBe(glyph);
	expect(mark.fg).toBe(rgb(color).join(","));
	expect(mark.bold).toBe(bold);
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

		// Unfocus: the panel slides back to the three-line strip.
		await unfocusSidebar(t);
		expect(t.captureCharFrame()).not.toContain("wf-active");
	} finally {
		t.renderer.destroy();
		clearGateway();
	}
});

test("the collapsed strip carries each workflow's status glyph", async () => {
	stubGateway([
		overview("wf-question", "attention-required", { pendingQuestions: 1 }),
		overview("wf-review", "active", { stepId: "core.developer-review" }),
		overview("wf-invalid", "active", { valid: false }),
		overview("wf-running", "active"),
		overview("wf-idle", "paused"),
	]);
	const t = await renderShell();
	try {
		// Unfocused, each row carries the same status mark the expanded row
		// shows, in its tone colour; a state waiting on a reader is bold as well, so
		// `?`, `!` and the review `✓` stand out at the collapsed width while the
		// running and paused rows stay plain.
		expectMark(t, 1, "…", uiColors.info, false);
		expectMark(t, 2, "✓", uiColors.info, true);
		expectMark(t, 3, "?", uiColors.warning, true);
		expectMark(t, 4, "!", uiColors.error, true);
		expectMark(t, 5, "◦", uiColors.textMuted, false);
		// The third line only spends a review marker where a reader is needed;
		// the other quiet phases settle on the muted dot.
		expect(
			[1, 2, 3, 4, 5].map((position) => collapsedMark(t, position).signal),
		).toEqual(["·", "?", "·", "·", "·"]);
		// The strip names nothing: no workflow id reaches it.
		expect(collapsedStrip(t.captureCharFrame())).not.toContain("wf-");
	} finally {
		t.renderer.destroy();
		clearGateway();
	}
});

test("the collapsed strip keeps its shape with many workflows", async () => {
	stubGateway(
		Array.from({ length: 30 }, (_, index) =>
			overview(`wf-a-very-long-workflow-id-${index}`, "active"),
		),
	);
	const t = await renderShell();
	try {
		// Long ids never reach the strip, so many rows and long names leave its shape
		// alone: one three-line stack per row, inside the collapsed width.
		const rows = compactWorkflowRows(t.captureCharFrame());
		expect(rows[0]).toEqual(["1", "…", "·"]);
		expect(rows[9]).toEqual(["10", "…", "·"]);
		expect(collapsedStrip(t.captureCharFrame())).not.toContain(
			"wf-a-very-long",
		);
	} finally {
		t.renderer.destroy();
		clearGateway();
	}
});

/** The compact strip's whole vocabulary: the toggle glyph, the pinned entries'
 * mark, its rule, and three lines per workflow (position, status glyph and one
 * phase character). The collapsed sidebar names nothing, so a *letter* in the
 * strip is expanded content — an id, a phase, a panel title or a filter label —
 * that leaked into it. */
const COMPACT_STRIP = /^[^A-Za-z]*$/;

/** The column the page body starts at, read from the Home destination list
 * ("Home"): body content is the column the sidebar is not, so the space the
 * collapsed strip frees is measured there. */
function bodyColumn(frame: string): number {
	for (const line of frame.split("\n")) {
		const column = line.indexOf("Home");
		if (column > 1) return column;
	}
	return -1;
}

/** The sidebar band of a frame: the rows between the shell's own header and
 * status bar, which each span the whole width and belong to no panel. */
function sidebarBand(frame: string): string[] {
	const lines = frame.split("\n");
	const last = lines.reduce((at, line, index) => (line.trim() ? index : at), 0);
	return lines.slice(1, last);
}

/** The compact strip of a frame: the leftmost columns of the sidebar band. Only
 * the strip (the toggle glyph, the pinned entry, its rule and one row per
 * workflow) draws there, so this block is everything a glance at the collapsed
 * sidebar reads. */
function compactStrip(frame: string): string {
	return sidebarBand(frame)
		.map((line) => line.slice(0, SIDEBAR_COLLAPSED_WIDTH))
		.join("\n");
}

/** The compact strip's non-empty cells, read past its selection marker and gap:
 * the pinned marks, their rule, then three cells (position, status glyph,
 * phase signal) per workflow. */
function compactRows(frame: string): string[] {
	return sidebarBand(frame)
		.map((line) => line.slice(0, SIDEBAR_COLLAPSED_WIDTH).slice(2).trimEnd())
		.filter((line) => line.length > 0);
}

/** The strip's workflow cells grouped by row, skipping the pinned marks and
 * rule when present. */
function compactWorkflowRows(frame: string): string[][] {
	const cells = compactRows(frame);
	// The pinned marks and their rule have no numeric position; the first
	// workflow row does.
	const first = cells.findIndex((cell) => /^\d+$/.test(cell));
	const start = first >= 0 ? first : 0;
	const rows: string[][] = [];
	for (let index = start; index + 2 < cells.length; index += 3) {
		rows.push(cells.slice(index, index + 3));
	}
	return rows;
}

test("the collapsed panel is the compact strip whatever the width is", () => {
	// The sidebar's own state decides the collapsed view: an expanded width left
	// over from a slide that never ran (or never finished) must not paint the full
	// rows, and while collapsed the panel paints the fixed compact width — the
	// columns the page body keeps.
	expect(
		sidebarPanelView({ expandedByState: false, animatedWidth: SIDEBAR_WIDTH }),
	).toEqual({ width: SIDEBAR_COLLAPSED_WIDTH, expanded: false });
	expect(
		sidebarPanelView({
			expandedByState: true,
			animatedWidth: SIDEBAR_COLLAPSED_WIDTH,
		}),
	).toEqual({ width: SIDEBAR_COLLAPSED_WIDTH, expanded: false });
	expect(
		sidebarPanelView({ expandedByState: true, animatedWidth: SIDEBAR_WIDTH }),
	).toEqual({ width: SIDEBAR_WIDTH, expanded: true });
	// The compact width is exactly what a compact row needs and no more: the
	// selection marker, its gap column and four cells for the bold position.
	expect(SIDEBAR_COLLAPSED_WIDTH).toBe(1 + 1 + 4);
});

test("the collapsed strip paints only the position, status glyph and phase signal", async () => {
	for (const count of [1, 3, 10]) {
		stubGateway(
			Array.from({ length: count }, (_, index) =>
				overview(`wf-a-very-long-workflow-id-${index}`, "active"),
			),
		);
		const t = await renderShell();
		try {
			const frame = t.captureCharFrame();
			// Long ids, and the phase meta under them, never reach the strip.
			expect(compactStrip(frame)).toMatch(COMPACT_STRIP);
			// One three-line row per workflow, under the pinned entries.
			expect(compactWorkflowRows(frame)).toEqual(
				Array.from({ length: count }, (_, index) => [`${index + 1}`, "…", "·"]),
			);
			// The body keeps the columns the strip does not take.
			expect(bodyColumn(frame)).toBe(SIDEBAR_COLLAPSED_WIDTH + 1);
		} finally {
			t.renderer.destroy();
			clearGateway();
		}
	}
});

test("a verifying workflow spends the collapsed phase line on its running verifiers", async () => {
	stubGateway([
		overview("wf-verify", "active", {
			stepId: "core.verification",
			repository: "/work/project-name",
			verification: {
				findings: { critical: 3, warning: 1, info: 3 },
				completedVerifiers: 3,
				totalVerifiers: 7,
				runningVerifiers: 2,
				failed: true,
			},
		}),
		overview("wf-other", "active"),
	]);
	const t = await renderShell();
	try {
		const frame = t.captureCharFrame();
		expect(compactWorkflowRows(frame)).toEqual([
			["1", "✓", "2"],
			["2", "…", "·"],
		]);
		const mark = collapsedMark(t, 1);
		expect(mark.signal).toBe("2");
		expect(mark.signalFg).toBe(rgb(uiColors.error).join(","));
	} finally {
		t.renderer.destroy();
		clearGateway();
	}
});

test("a verifying workflow's expanded row carries findings, verifiers and project", async () => {
	stubGateway([
		overview("wf-verify", "active", {
			stepId: "core.verification",
			repository: "/work/project-name",
			verification: {
				findings: { critical: 0, warning: 1, info: 3 },
				completedVerifiers: 3,
				totalVerifiers: 7,
				runningVerifiers: 2,
				failed: true,
			},
		}),
	]);
	const t = await renderShell();
	try {
		await focusSidebar(t);
		expect(await renderUntil(t, "Verification · 0 1 3 · 3/7✓")).toBe(true);
		const lines = t.captureCharFrame().split("\n");
		const nameRow = lines.findIndex((line) => line.includes("wf-verify"));
		expect(nameRow).toBeGreaterThan(-1);
		const row = (offset: number): string =>
			lines[nameRow + offset]?.slice(0, SIDEBAR_WIDTH).trimEnd() ?? "";
		expect(row(0)).toContain("✓ wf-verify");
		expect(row(1)).toContain("Verification · 0 1 3 · 3/7✓");
		// The project line is the last path segment, not the repository path.
		expect(row(2)).toContain("project-name");
		expect(row(2)).not.toContain("/work/project-name");
		expect(row(3)).not.toContain("project-name");

		const spans = t.captureSpans();
		const nameSpan = spans.lines[nameRow]?.spans.find((span) =>
			span.text.includes("wf-verify"),
		);
		expect((nameSpan?.attributes ?? 0) & TextAttributes.BOLD).not.toBe(0);
		const metaSpans = spans.lines[nameRow + 1]?.spans ?? [];
		const counts = metaSpans
			.filter((span) => /^\d+$/.test(span.text))
			.map((span) => span.fg.buffer.slice(0, 3).join(","));
		expect(counts).toEqual([
			rgb(uiColors.error).join(","),
			rgb(uiColors.warning).join(","),
			rgb(uiColors.info).join(","),
			rgb(uiColors.error).join(","),
		]);
	} finally {
		t.renderer.destroy();
		clearGateway();
	}
});

test("Ctrl+S collapses to the compact strip at once and expands to the full rows", async () => {
	stubGateway([
		overview("wf-running-with-a-very-long-id", "active"),
		overview("wf-attention-with-a-very-long-id", "attention-required"),
	]);
	const t = await renderShell();
	try {
		// Startup: `expanding` mode and no focus, so the sidebar is already the
		// compact strip and the body has the freed columns.
		const start = t.captureCharFrame();
		expect(compactWorkflowRows(start)).toEqual([
			["1", "…", "·"],
			["2", "!", "·"],
		]);
		expect(bodyColumn(start)).toBe(SIDEBAR_COLLAPSED_WIDTH + 1);

		// Focus (Ctrl+S): the full rows (id, phase meta, filter row) appear with the
		// slide.
		await focusSidebar(t);
		const expanded = t.captureCharFrame();
		expect(expanded).toContain("Workspaces");
		expect(expanded).toContain("wf-running-with-a-very-l");
		expect(expanded).toContain("Attention");
		// An expanded row is three lines: label, stage detail, project name. The
		// project line carries the last path segment, not the whole repository.
		const expandedRows = expanded.split("\n");
		const row = expandedRows.findIndex((line) =>
			line.includes("wf-running-with-a-very-l"),
		);
		const cell = (offset: number): string =>
			expandedRows[row + offset]
				?.slice(0, SIDEBAR_WIDTH)
				.replace(/^│\s*/, "")
				.trimEnd() ?? "";
		expect(cell(1)).toBe("Apply");
		expect(cell(2)).toBe("demo");

		// Unfocus: the very next painted frame is the compact strip again, and the
		// page body has the freed columns back — the collapse is a cut, so it never
		// waits for the width slide to finish (and an unfocused sidebar can never
		// keep painting the expanded panel).
		t.mockInput.pressKey("s", { ctrl: true });
		await t.renderOnce();
		const collapsed = t.captureCharFrame();
		expect(compactStrip(collapsed)).toMatch(COMPACT_STRIP);
		expect(collapsed).not.toContain("wf-running-with-a-very-l");
		expect(bodyColumn(expanded) - bodyColumn(collapsed)).toBe(
			SIDEBAR_WIDTH - SIDEBAR_COLLAPSED_WIDTH,
		);

		// Settled (the slide has finished): still the compact strip.
		await advance(t, 4, 60);
		expect(compactWorkflowRows(t.captureCharFrame())).toEqual([
			["1", "…", "·"],
			["2", "!", "·"],
		]);
	} finally {
		t.renderer.destroy();
		clearGateway();
	}
});

test("the collapsed strip shows no filler when there is nothing to list", async () => {
	stubGateway([]);
	const t = await renderShell();
	try {
		// Unfocused and empty: the strip is the toggle glyph and pinned entries,
		// and nothing else. The list primitive's own empty state ("No items") must
		// not leak into it.
		expect(t.captureCharFrame()).not.toContain("No items");
		expect(t.captureCharFrame()).not.toContain("Reading workflows");

		// Focused, the expanded panel is where an empty list is explained.
		await focusSidebar(t);
		expect(await renderUntil(t, "No active workflows")).toBe(true);
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
	// Keep the dashboard view pending so a fast failed read cannot replace the
	// breadcrumb with the global error modal before this route assertion paints.
	stubGateway(OVERVIEWS, "pending");
	const t = await renderShell();
	try {
		await focusSidebar(t);
		expect(await renderUntil(t, "wf-active")).toBe(true);
		// The Home pins lead the cursor space, then the first workflow row.
		await selectFirstWorkflow(t);
		t.mockInput.pressEnter();
		await advance(t, 3, 60);
		// The workflow-dashboard route names the workflow in the breadcrumb. The
		// cursor lands on the newest row
		// the default filter leaves (completed workflows are hidden), so the crumb is
		// what names it — the collapsed sidebar paints no row of its own.
		const opened = await renderUntil(t, (frame) =>
			crumbLine(frame).includes("wf-attention"),
		);
		if (!opened)
			throw new Error(`workflow route did not open\n${t.captureCharFrame()}`);
	} finally {
		t.renderer.destroy();
		clearGateway();
	}
});

test("rows show the state that needs a reader as a glyph", async () => {
	stubGateway([
		overview("wf-question", "attention-required", { pendingQuestions: 1 }),
		// A committed blocker: attention notes on a *running* workflow are
		// diagnostics, so the blocker status is what lights the `!`.
		overview("wf-blocked", "attention-required", {
			attention: ["retry limit reached"],
		}),
		overview("wf-review", "active", { stepId: "core.developer-review" }),
		overview("wf-running", "active"),
		overview("wf-idle", "paused"),
	]);
	const t = await renderShell();
	try {
		await focusSidebar(t);
		expect(await renderUntil(t, "wf-running")).toBe(true);
		const frame = t.captureCharFrame();
		expect(frame).toContain("? wf-question");
		expect(frame).toContain("! wf-blocked");
		expect(frame).toContain("✓ wf-review");
		expect(frame).toContain("… wf-running");
		expect(frame).toContain("◦ wf-idle");
	} finally {
		t.renderer.destroy();
		clearGateway();
	}
});

test("the pinned Orchestrator, OpenCode and Pi entries are always visible", async () => {
	stubGateway();
	const t = await renderShell();
	try {
		// Unfocused, the collapsed strip keeps every pinned slot as a mark.
		expect(t.captureCharFrame()).toContain("⌂");
		expect(t.captureCharFrame()).toContain("󱚞");
		expect(t.captureCharFrame()).toContain("π");
		await focusSidebar(t);
		expect(await renderUntil(t, "Orchestrator")).toBe(true);
		expect(t.captureCharFrame()).toContain("chat · launch · manage");
		expect(t.captureCharFrame()).toContain("OpenCode");
		expect(t.captureCharFrame()).toContain("sessions · prompts · code");
		expect(t.captureCharFrame()).toContain("Pi");
		expect(t.captureCharFrame()).toContain("standard · prompt · code");

		// The filter only changes the workflow rows underneath: the pinned entry is
		// chrome above them and never disappears with them.
		t.mockInput.pressKey("f");
		expect(await renderUntil(t, "wf-attention")).toBe(true);
		expect(t.captureCharFrame()).toContain("Orchestrator");
		t.mockInput.pressKey("f");
		expect(await renderUntil(t, "wf-done")).toBe(true);
		expect(t.captureCharFrame()).toContain("Orchestrator");
	} finally {
		t.renderer.destroy();
		clearGateway();
	}
});

test("the pinned entries show even with no workflows at all", async () => {
	stubGateway([]);
	const t = await renderShell();
	try {
		expect(t.captureCharFrame()).toContain("⌂");
		await focusSidebar(t);
		expect(await renderUntil(t, "No active workflows")).toBe(true);
		expect(t.captureCharFrame()).toContain("Orchestrator");
		expect(t.captureCharFrame()).toContain("OpenCode");
		expect(t.captureCharFrame()).toContain("Pi");
	} finally {
		t.renderer.destroy();
		clearGateway();
	}
});

test("Enter on the pinned Orchestrator entry opens the Orchestrator page", async () => {
	stubGateway();
	const t = await renderShell();
	try {
		await focusSidebar(t);
		expect(await renderUntil(t, "Orchestrator")).toBe(true);
		// The shell badge names the current page in lowercase and the pin's own
		// label is capitalised, so the lowercase name is the page and nothing else.
		expect(t.captureCharFrame()).not.toContain("orchestrator");
		t.mockInput.pressEnter();
		expect(
			await renderUntil(t, (frame) => frame.includes("orchestrator")),
		).toBe(true);
	} finally {
		t.renderer.destroy();
		clearGateway();
	}
});

test("orchestrator-started rows are marked, operator rows stay bare", async () => {
	stubGateway([
		overview("wf-orchestrated", "active", { startedBy: "orchestrator" }),
		overview("wf-operator", "active", { startedBy: "developer" }),
		// A row from before the attribution existed is operator work.
		overview("wf-unattributed", "active"),
	]);
	const t = await renderShell();
	try {
		await focusSidebar(t);
		expect(await renderUntil(t, "wf-orchestrated")).toBe(true);
		const frame = t.captureCharFrame();
		expect(frame).toContain("⌂ wf-orchestrated");
		expect(frame).toContain("wf-operator");
		expect(frame).not.toContain("⌂ wf-operator");
		expect(frame).toContain("wf-unattributed");
		expect(frame).not.toContain("⌂ wf-unattributed");
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

test("Shift+H/L never focus the sidebar: only Ctrl+S does", async () => {
	stubGateway();
	const t = await renderShell();
	try {
		// The page body's shifted h/l keys belong to the dashboard's own panel
		// grid; they must not reach the workspace sidebar behind it.
		t.mockInput.pressKey("h", { shift: true });
		await advance(t, 4, 60);
		expect(t.captureCharFrame()).not.toContain("wf-active");
		t.mockInput.pressKey("l", { shift: true });
		await advance(t, 4, 60);
		expect(t.captureCharFrame()).not.toContain("wf-active");

		// Ctrl+S is the one way in, and it still works after the shifted keys.
		await focusSidebar(t);
		expect(t.captureCharFrame()).toContain("wf-active");
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

		// A right click and a drag on the glyph are not taps: the mode is
		// unchanged (the shared rule gates every click-only control).
		await t.mockMouse.click(32, 1, 2);
		await advance(t, 4, 60);
		expect(persistedSidebarMode()).toBe("permanent");
		await t.mockMouse.drag(32, 1, 33, 2);
		await advance(t, 4, 60);
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

test("d confirms before deleting the selected workflow", async () => {
	stubGateway();
	const t = await renderShell();
	try {
		await focusSidebar(t);
		// The attention workflow is the first filtered row after the Home pins.
		expect(await renderUntil(t, "wf-attention")).toBe(true);
		await selectFirstWorkflow(t);

		// The key opens the question; nothing is deleted while it is open.
		t.mockInput.pressKey("d");
		expect(await renderUntil(t, "Delete workflow?")).toBe(true);
		expect(deletedWorkflows).toEqual([]);

		// Declining keeps the workflow and closes the dialog.
		t.mockInput.pressKey("n");
		expect(
			await renderUntil(t, (frame) => !frame.includes("Delete workflow?")),
		).toBe(true);
		expect(deletedWorkflows).toEqual([]);
		expect(t.captureCharFrame()).toContain("wf-attention");

		// Confirming deletes it. The row is gone from the list, which the
		// attention filter proves: nothing matches it any more (the confirmation
		// toast names the workflow, so an absence check would read the toast).
		t.mockInput.pressKey("d");
		expect(await renderUntil(t, "Delete workflow?")).toBe(true);
		t.mockInput.pressKey("y");
		expect(deletedWorkflows).toEqual([
			{ repo: "/demo", workflowId: "wf-attention" },
		]);
		t.mockInput.pressKey("f");
		expect(await renderUntil(t, "No attention workflows")).toBe(true);
	} finally {
		t.renderer.destroy();
		clearGateway();
	}
});

test("d deletes a repository-independent workflow through its target store", async () => {
	// A wiki or research workflow keeps its rows in the shared target store, so
	// its repository is empty (or the repository it was started from) and can
	// never address it: the target can. Addressing it by repository is what made
	// the delete answer "workflow not found" for a row the sidebar was showing.
	stubGateway([
		overview("research-1", "active", {
			target: "research://standalone",
			repository: "",
			definitionId: "research",
		}),
	]);
	const t = await renderShell();
	try {
		await focusSidebar(t);
		expect(await renderUntil(t, "research-1")).toBe(true);
		await selectFirstWorkflow(t);

		t.mockInput.pressKey("d");
		expect(await renderUntil(t, "Delete workflow?")).toBe(true);
		t.mockInput.pressKey("y");
		expect(deletedWorkflows).toEqual([
			{ repo: "research://standalone", workflowId: "research-1" },
		]);
		expect(await renderUntil(t, "No active workflows")).toBe(true);
	} finally {
		t.renderer.destroy();
		clearGateway();
	}
});

test("Ctrl+T opens the current view in a new tmux window", async () => {
	const previousTmux = process.env.TMUX;
	const previousUrl = process.env.AGENTIC_WORKFLOW_URL;
	delete process.env.TMUX;
	// A running server is the precondition; the spawn then reports the missing
	// tmux client instead of opening a window.
	process.env.AGENTIC_WORKFLOW_URL = "http://127.0.0.1:4050";
	const t = await renderShell();
	try {
		t.mockInput.pressKey("t", { ctrl: true });
		expect(
			await renderUntil(t, (frame) => frame.includes("tmux is not available")),
		).toBe(true);
	} finally {
		if (previousTmux !== undefined) process.env.TMUX = previousTmux;
		if (previousUrl !== undefined)
			process.env.AGENTIC_WORKFLOW_URL = previousUrl;
		else delete process.env.AGENTIC_WORKFLOW_URL;
		t.renderer.destroy();
		clearGateway();
	}
});

test("n reports an error when no tmux client is available", async () => {
	stubGateway();
	const previousTmux = process.env.TMUX;
	const previousUrl = process.env.AGENTIC_WORKFLOW_URL;
	delete process.env.TMUX;
	// A running server is the other precondition; without it the report is about
	// the missing backend, which the next test pins.
	process.env.AGENTIC_WORKFLOW_URL = "http://127.0.0.1:4050";
	const t = await renderShell();
	try {
		await focusSidebar(t);
		expect(await renderUntil(t, "wf-active")).toBe(true);
		await selectFirstWorkflow(t);
		t.mockInput.pressKey("n");
		expect(
			await renderUntil(t, (frame) => frame.includes("tmux is not available")),
		).toBe(true);
	} finally {
		if (previousTmux !== undefined) process.env.TMUX = previousTmux;
		if (previousUrl !== undefined)
			process.env.AGENTIC_WORKFLOW_URL = previousUrl;
		else delete process.env.AGENTIC_WORKFLOW_URL;
		t.renderer.destroy();
		clearGateway();
	}
});

test("n reports when no server is running to attach the window to", async () => {
	stubGateway();
	const previousUrl = process.env.AGENTIC_WORKFLOW_URL;
	delete process.env.AGENTIC_WORKFLOW_URL;
	const t = await renderShell();
	try {
		await focusSidebar(t);
		expect(await renderUntil(t, "wf-active")).toBe(true);
		await selectFirstWorkflow(t);
		t.mockInput.pressKey("n");
		expect(
			await renderUntil(t, (frame) =>
				frame.includes("Cannot open a view window: no server is running"),
			),
		).toBe(true);
	} finally {
		if (previousUrl !== undefined)
			process.env.AGENTIC_WORKFLOW_URL = previousUrl;
		t.renderer.destroy();
		clearGateway();
	}
});

test("a kitty-protocol terminal cycles back with Ctrl+H itself", async () => {
	stubGateway(OVERVIEWS, "pending");
	const t = await renderShell({ kittyKeyboard: true });
	try {
		await focusSidebar(t);
		expect(await renderUntil(t, "wf-active")).toBe(true);
		// Enter the first workflow after the Home pins, then exercise the cycle
		// from the page body. Kitty protocol keeps Ctrl+H distinct from Backspace.
		await selectFirstWorkflow(t);
		t.mockInput.pressEnter();
		expect(await renderWorkspace(t, "wf-attention")).toBe(true);
		t.mockInput.pressKey("l", { ctrl: true });
		await advance(t);
		expect(await renderWorkspace(t, "wf-active")).toBe(true);
		await dismissObservationError(t);
		t.mockInput.pressKey("h", { ctrl: true });
		await advance(t);
		expect(await renderWorkspace(t, "wf-attention")).toBe(true);
	} finally {
		t.renderer.destroy();
		clearGateway();
	}
});

test("Ctrl+L and Ctrl+H open the next and previous workspace, wrapping", async () => {
	stubGateway(OVERVIEWS, "pending");
	const t = await renderShell();
	try {
		// The cycle walks the active filter's workflow rows newest first and wraps
		// between them and the Orchestrator pin.
		await focusSidebar(t);
		expect(await renderUntil(t, "wf-active")).toBe(true);
		await selectFirstWorkflow(t);
		t.mockInput.pressEnter();
		expect(await renderWorkspace(t, "wf-attention")).toBe(true);

		t.mockInput.pressKey("l", { ctrl: true });
		await advance(t);
		expect(await renderWorkspace(t, "wf-active")).toBe(true);

		await dismissObservationError(t);
		t.mockInput.pressKey("l", { ctrl: true });
		await advance(t);
		expect(await renderWorkspace(t, "Orchestrator")).toBe(true);

		// Backwards wraps from the Orchestrator to the last workflow. Ctrl+H
		// arrives as Backspace on a terminal without the kitty protocol, so put
		// focus on the sidebar before sending it.
		await focusSidebar(t);
		t.mockInput.pressKey("h", { ctrl: true });
		await advance(t);
		expect(await renderWorkspace(t, "wf-active")).toBe(true);
	} finally {
		t.renderer.destroy();
		clearGateway();
	}
}, 10_000);

test("Ctrl+L keeps cycling while the page body holds the keys", async () => {
	stubGateway(OVERVIEWS, "pending");
	const t = await renderShell();
	try {
		await focusSidebar(t);
		expect(await renderUntil(t, "wf-active")).toBe(true);
		// Open the first workflow after the Home pins. Ctrl+L remains a shell
		// cycle key while the dashboard body holds focus.
		await selectFirstWorkflow(t);
		t.mockInput.pressEnter();
		expect(await renderWorkspace(t, "wf-attention")).toBe(true);
		t.mockInput.pressKey("l", { ctrl: true });
		await advance(t);
		expect(await renderWorkspace(t, "wf-active")).toBe(true);
		await dismissObservationError(t);
		t.mockInput.pressKey("l", { ctrl: true });
		await advance(t);
		expect(await renderWorkspace(t, "Orchestrator")).toBe(true);
	} finally {
		t.renderer.destroy();
		clearGateway();
	}
});

test("the Backspace byte cycles back only while the sidebar holds focus", async () => {
	stubGateway(OVERVIEWS, "pending");
	const t = await renderShell();
	try {
		await focusSidebar(t);
		expect(await renderUntil(t, "wf-active")).toBe(true);
		// A terminal without the kitty keyboard protocol reports Ctrl+H as the
		// Backspace byte. The sidebar is the one surface where that byte edits no
		// text, so it moves from the second workflow to the first.
		t.mockInput.pressKey("j");
		await advance(t);
		t.mockInput.pressKey("j");
		await advance(t);
		t.mockInput.pressKey("j");
		await advance(t);
		t.mockInput.pressKey("j");
		await advance(t);
		// The terminal's Ctrl+H byte, which is also what `pressBackspace` sends: the
		// two are one key on a terminal without the kitty keyboard protocol.
		t.mockInput.pressBackspace();
		await advance(t);
		expect(await renderWorkspace(t, "wf-attention")).toBe(true);

		// Everywhere else the byte keeps its own meaning: a Backspace in the page
		// body must never switch the workspace behind the reader's back.
		await dismissObservationError(t);
		t.mockInput.pressKey("l", { ctrl: true });
		await advance(t);
		expect(await renderWorkspace(t, "wf-active")).toBe(true);
		t.mockInput.pressBackspace();
		await advance(t);
		expect(crumbLine(t.captureCharFrame())).toContain("wf-active");
	} finally {
		t.renderer.destroy();
		clearGateway();
	}
});
