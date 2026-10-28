/** @jsxImportSource @opentui/solid */
import { afterEach, beforeEach, expect, spyOn, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { activeKeybindCatalog, activeKeybindContext } from "@agentic-coding/ui";
import { createDefaultOpenTuiKeymap } from "@opentui/keymap/opentui";
import { testRender, useRenderer } from "@opentui/solid";
import { createSignal, onCleanup, Show } from "solid-js";
import { HostClient } from "../../src/agent-host/client.ts";
import { hostLayout } from "../../src/agent-host/layout.ts";
import * as sessionRecovery from "../../src/agent-host/recovery.ts";
import * as workflowSessions from "../../src/agent-host/workflow-session.ts";
import type { ObservationRequest } from "../../src/contracts/environment.ts";
import type {
	DashboardGateway,
	GatewayEventHandlers,
} from "../../src/contracts/gateway.ts";
import type { DashboardData } from "../../src/contracts/workflow";
import { App } from "../../src/tui/dash/App.tsx";
import { testDashboard } from "../../src/tui/dash/demo.ts";
import { clearGateway, configureGateway } from "../../src/tui/data/index.ts";
import { pressEscapeAndSettle } from "../app/support/terminal.ts";

type Test = Awaited<ReturnType<typeof testRender>>;

const roots: string[] = [];
const demoSocket = hostLayout("/demo/.herdr-workflow").socketPath;
const sessionLookups: Array<{ mockRestore: () => void }> = [];
beforeEach(() => {
	// Controls now recover the durable binding before submit/configure/abort.
	// This harness has no real store or host: keep recovery synthetic too.
	sessionLookups.push(
		spyOn(sessionRecovery, "recoverWorkflowSession").mockImplementation(
			async (target, workflowId, runId) => {
				if (target !== "/demo" || workflowId !== "demo")
					throw new Error("foreign workflow");
				return { runId, hostSocket: demoSocket, conversationId: "render-test" };
			},
		),
	);
	// The store boundary has real read-only SQL/path tests in
	// agent-host-workflow-session.test.ts. These are socket-free rendered tests.
	sessionLookups.push(
		spyOn(workflowSessions, "workflowSessionSocket").mockImplementation(
			(target, workflowId, _runId, socket) => {
				if (
					target !== "/demo" ||
					workflowId !== "demo" ||
					socket !== demoSocket
				)
					throw new Error("recorded socket does not belong to this workflow");
				return demoSocket;
			},
		),
	);
	sessionLookups.push(
		spyOn(workflowSessions, "createWorkflowSessionResolver").mockImplementation(
			(target, workflowId) => {
				let disposed = false;
				return {
					async resolve(runId, socket) {
						await Promise.resolve();
						if (disposed) throw new Error("resolver disposed");
						return workflowSessions.workflowSessionSocket(
							target,
							workflowId,
							runId,
							socket,
						);
					},
					async connection(runId, socket) {
						if (disposed) throw new Error("resolver disposed");
						return {
							socket: workflowSessions.workflowSessionSocket(
								target,
								workflowId,
								runId,
								socket,
							),
							fingerprint: "render-test",
						};
					},
					dispose() {
						disposed = true;
					},
				};
			},
		),
	);
});
afterEach(() => {
	for (const lookup of sessionLookups.splice(0)) lookup.mockRestore();
	for (const root of roots.splice(0))
		rmSync(root, { recursive: true, force: true });
});

function TestDashboard(props: {
	testData?: DashboardData;
	agentRunId?: string;
	agentRequestId?: string;
	onAgentRunRequestConsumed?: (requestId: string) => void;
	onBack?: () => boolean;
	live?: boolean;
}) {
	const renderer = useRenderer();
	const keymap = createDefaultOpenTuiKeymap(renderer);
	// Mirror the production detail keymap (src/tui/index.tsx → setupKeymap):
	// shift+letter events resolve to their uppercase binding ("J" ↔ Shift+J).
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
		agentView(value, ctx) {
			ctx.require("agent.view", String(value));
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
			profile={props.live ? undefined : "test"}
			keymap={keymap}
			testData={props.testData}
			agentRunId={props.agentRunId}
			agentRequestId={props.agentRequestId}
			onAgentRunRequestConsumed={props.onAgentRunRequestConsumed}
			{...(props.onBack ? { onBack: props.onBack } : {})}
		/>
	);
}

// Dismiss the auto-opened plan review popup; focus starts on the Change panel.
async function dashboardReady(t: Test) {
	await t.waitForFrame((frame) => frame.includes("Plan review"));
	t.mockInput.pressEscape();
	await t.waitForFrame((frame) => !frame.includes("Plan review"));
}

// Enter on the focused panel; the opened modal identifies the panel:
// Change → plan review popup, OpenSpec → artifact verdict. Agents is probed
// separately with `v` because Enter there dispatches a pane focus action.
async function openFocusedPanelModal(t: Test) {
	t.mockInput.pressEnter();
	await t.renderOnce();
	return t.captureCharFrame();
}

async function expectOpenSpec(t: Test) {
	const frame = await openFocusedPanelModal(t);
	expect(frame).toContain("OpenSpec ·");
	expect(frame).not.toContain("Plan review");
	t.mockInput.pressEscape();
	await t.waitForFrame((frame) => !frame.includes("OpenSpec ·"));
}

async function expectClassifier(t: Test) {
	const frame = await openFocusedPanelModal(t);
	expect(frame).toContain("Classifier ·");
	expect(frame).not.toContain("Plan review");
	t.mockInput.pressEscape();
	await t.waitForFrame((frame) => !frame.includes("Classifier ·"));
}

// Evidence probe: it is the one panel whose Enter hands a file to the system
// opener instead of opening a modal, so pressing Enter would spawn a real
// opener. This suite renders no footer, so the keybind context the dashboard
// publishes is what identifies the focused panel — and the always-rendered
// panel shows its empty state for the demo fixture rather than a loading one.
async function expectEvidence(t: Test) {
	for (let pass = 0; pass < 20 && activeKeybindContext() !== "evidence"; pass++)
		await t.renderOnce();
	expect(activeKeybindContext()).toBe("evidence");
	const frame = t.captureCharFrame();
	expect(frame).toContain("Evidence");
	expect(frame).toContain("No evidence attached yet");
	expect(frame).not.toContain("Loading evidence…");
}

async function expectChange(t: Test) {
	const frame = await openFocusedPanelModal(t);
	expect(frame).toContain("Plan review");
	t.mockInput.pressEscape();
	await t.waitForFrame((frame) => !frame.includes("Plan review"));
}

// Agents panel probe: move selection to the security-verifier (planner →
// worker → security-verifier) and open its result.
async function expectAgents(t: Test) {
	t.mockInput.pressKey("j");
	t.mockInput.pressKey("j");
	await t.renderOnce();
	t.mockInput.pressKey("v");
	const frame = await t.waitForFrame((value) =>
		value.includes("VERDICT: PASS"),
	);
	expect(frame).toContain("security-verifier · demo");
	t.mockInput.pressEscape();
	await t.waitForFrame((frame) => !frame.includes("VERDICT"));
}

/**
 * Poll for a frame predicate with real time between renders: OpenTUI's
 * block Markdown renderer highlights via a background tree-sitter worker,
 * so a single idle render may not yet contain the rendered text.
 */
async function waitForText(
	t: Test,
	predicate: (frame: string) => boolean,
	timeoutMs = 5000,
): Promise<string> {
	const start = Date.now();
	while (Date.now() - start < timeoutMs) {
		await t.renderOnce();
		const frame = t.captureCharFrame();
		if (predicate(frame)) return frame;
		await new Promise((resolve) => setTimeout(resolve, 20));
	}
	throw new Error(
		`Timed out waiting for frame predicate\n${t.captureCharFrame()}`,
	);
}

/** Fixture dashboard with `count` OpenSpec artifacts backed by real files. */
function artifactsFixture(count: number): DashboardData {
	const root = mkdtempSync(join(tmpdir(), "agent-dash-openspec-"));
	roots.push(root);
	const changeRoot = join(
		root,
		"openspec",
		"changes",
		"demo-optional-realisation-date",
	);
	mkdirSync(changeRoot, { recursive: true });
	for (let index = 1; index <= count; index++) {
		writeFileSync(
			join(changeRoot, `artifact-${index}.md`),
			`# Artifact ${index}\n\nBody ${index}.\n`,
		);
	}
	const dashboard = testDashboard();
	return {
		...dashboard,
		state: {
			...dashboard.state,
			worktree: root,
			// The panel lists every classification, so "no classifications" clears
			// both histories the merge reads.
			classifierDecisions: [],
			gateDecisions: [],
		},
	};
}

function noDecisionsFixture(): DashboardData {
	const dashboard = testDashboard();
	return {
		...dashboard,
		state: {
			...dashboard.state,
			classifierDecisions: [],
			gateDecisions: [],
		},
	};
}

/** The demo's classifier decisions repeated `count` times, merged into `data`:
 * panel navigation is the same geometry whether or not anything was classified,
 * so the focus probe needs a populated panel. */
function withClassifierDecisions(
	data: DashboardData,
	count: number,
): DashboardData {
	// The template comes from the demo itself, not from `data`: a fixture may
	// have cleared both histories, and this one is the shape to replicate.
	const template = testDashboard().state.classifierDecisions?.[0];
	if (!template) throw new Error("demo classifier decision missing");
	return {
		...data,
		state: {
			...data.state,
			// The count is exact only with no gate records merged in.
			gateDecisions: [],
			classifierDecisions: Array.from({ length: count }, (_, index) => ({
				...template,
				id: `decision-${index + 1}`,
				questionId: `decision-${index + 1}`,
				input: `classifier input ${index + 1}`,
			})),
		},
	};
}

function decisionsFixture(count: number): DashboardData {
	return withClassifierDecisions(testDashboard(), count);
}

test("Shift+J/K move focus vertically with wrap at both edges", async () => {
	const t = await testRender(
		() => (
			<TestDashboard
				testData={withClassifierDecisions(artifactsFixture(5), 3)}
			/>
		),
		{
			width: 120,
			height: 40,
		},
	);
	await dashboardReady(t);

	// Change → (Shift+J) → OpenSpec.
	t.mockInput.pressKey("j", { shift: true });
	await t.renderOnce();
	await expectOpenSpec(t);

	// OpenSpec → (Shift+J) → Classifications, which is always rendered.
	t.mockInput.pressKey("j", { shift: true });
	await t.renderOnce();
	await expectClassifier(t);

	// Classifications → (Shift+J) → Evidence, the full-width bottom row.
	t.mockInput.pressKey("j", { shift: true });
	await t.renderOnce();
	await expectEvidence(t);

	// Evidence → (Shift+J, bottom wraps to top) → Change.
	t.mockInput.pressKey("j", { shift: true });
	await t.renderOnce();
	await expectChange(t);

	// Change → (Shift+K, top wraps to the bottom row) → Evidence.
	t.mockInput.pressKey("k", { shift: true });
	await t.renderOnce();
	await expectEvidence(t);

	// Evidence → (Shift+K) → Classifications, which is always rendered.
	t.mockInput.pressKey("k", { shift: true });
	await t.renderOnce();
	await expectClassifier(t);

	// Classifications → (Shift+K) → OpenSpec.
	t.mockInput.pressKey("k", { shift: true });
	await t.renderOnce();
	await expectOpenSpec(t);

	t.renderer.destroy();
});

test("Shift+H/L move focus horizontally with wrap at both edges", async () => {
	const t = await testRender(() => <TestDashboard />, {
		width: 120,
		height: 40,
	});
	await dashboardReady(t);

	// Change → (Shift+L) → Agents (selection starts at the top).
	t.mockInput.pressKey("l", { shift: true });
	await t.renderOnce();
	await expectAgents(t);

	// Agents → (Shift+H) → Change.
	t.mockInput.pressKey("h", { shift: true });
	await t.renderOnce();
	await expectChange(t);

	// Change → (Shift+H, left edge wraps to the right) → Agents, then
	// Shift+L returns to Change — reaching Change again proves the wrap
	// landed on the only other panel of the row.
	t.mockInput.pressKey("h", { shift: true });
	t.mockInput.pressKey("l", { shift: true });
	await t.renderOnce();
	await expectChange(t);

	// Change → (Shift+L) → Agents, then Shift+H (right edge wraps to the
	// left) returns to Change.
	t.mockInput.pressKey("l", { shift: true });
	t.mockInput.pressKey("h", { shift: true });
	await t.renderOnce();
	await expectChange(t);

	t.renderer.destroy();
});

test("Shift+J/K without artifacts skip the empty OpenSpec cell into Classifications", async () => {
	const t = await testRender(
		() => <TestDashboard testData={decisionsFixture(3)} />,
		{
			width: 120,
			height: 40,
		},
	);
	await dashboardReady(t);

	// Change → (Shift+J): the OpenSpec cell is empty, so the move lands on
	// Classifications rather than doing nothing.
	t.mockInput.pressKey("j", { shift: true });
	await t.renderOnce();
	await expectClassifier(t);

	// Classifications → (Shift+K) → Change; Change's own upward move wraps to
	// the bottom Evidence row rather than reaching the empty OpenSpec cell.
	t.mockInput.pressKey("k", { shift: true });
	await t.renderOnce();
	await expectChange(t);
	t.mockInput.pressKey("k", { shift: true });
	await t.renderOnce();
	await expectEvidence(t);
	t.mockInput.pressKey("j", { shift: true });
	await t.renderOnce();
	await expectChange(t);

	// The spanning Agents column reaches that same row: Shift+J leaves it for
	// Evidence — where `v` still opened the selection's verdict on the way
	// (expectAgents probes the column before the move).
	t.mockInput.pressKey("l", { shift: true });
	await t.renderOnce();
	await expectAgents(t);
	t.mockInput.pressKey("j", { shift: true });
	await t.renderOnce();
	await expectEvidence(t);

	// Evidence spans the whole row, so a horizontal move stays on it, and
	// Shift+K climbs back to Classifications.
	t.mockInput.pressKey("h", { shift: true });
	await t.renderOnce();
	await expectEvidence(t);
	t.mockInput.pressKey("k", { shift: true });
	await t.renderOnce();
	await expectClassifier(t);

	t.renderer.destroy();
});

test("the full-width Evidence row has no horizontal neighbour", async () => {
	const t = await testRender(
		() => <TestDashboard testData={artifactsFixture(5)} />,
		{
			width: 120,
			height: 40,
		},
	);
	await dashboardReady(t);

	// Change → (Shift+K, the top row wraps to the bottom) → Evidence.
	t.mockInput.pressKey("k", { shift: true });
	await t.renderOnce();
	await expectEvidence(t);

	// The row spans both columns, so neither horizontal move has a distinct
	// panel to land on: focus stays on Evidence.
	t.mockInput.pressKey("l", { shift: true });
	await t.renderOnce();
	await expectEvidence(t);
	t.mockInput.pressKey("h", { shift: true });
	await t.renderOnce();
	await expectEvidence(t);

	t.renderer.destroy();
});

test("focused OpenSpec panel shows five rows and scrolls with j/k", async () => {
	const t = await testRender(
		() => <TestDashboard testData={artifactsFixture(7)} />,
		{
			width: 120,
			height: 40,
		},
	);
	await dashboardReady(t);

	// Focus the OpenSpec panel.
	t.mockInput.pressKey("j", { shift: true });
	await t.renderOnce();

	// Only five artifact rows are visible initially; the sixth is hidden.
	const initial = t.captureCharFrame();
	const initialArtifacts = initial
		.split("\n")
		.filter((line) => line.includes("artifact-"));
	expect(initialArtifacts.length).toBe(5);
	expect(initial).toContain("artifact-1.md");
	expect(initial).toContain("artifact-5.md");
	expect(initial).not.toContain("artifact-6.md");

	// j moves the selection past the initial viewport and scrolls the lower
	// artifact into view without changing panel focus.
	for (let index = 0; index < 5; index++) {
		t.mockInput.pressKey("j");
		await t.renderOnce();
	}
	expect(t.captureCharFrame()).toContain("artifact-6.md");

	// k scrolls back up toward the first artifact; the sixth leaves the
	// visible viewport while the fifth rows remain.
	t.mockInput.pressKey("k");
	await t.renderOnce();
	expect(t.captureCharFrame()).toContain("artifact-5.md");

	// Activating the scrolled selection opens the formatted artifact view.
	t.mockInput.pressKey("j");
	await t.renderOnce();
	t.mockInput.pressEnter();
	await t.waitForFrame((frame) => frame.includes("OpenSpec · artifact-6.md"));
	const verdict = await waitForText(t, (frame) => frame.includes("Body 6."));
	expect(verdict).not.toContain("Plan review");

	t.renderer.destroy();
});

test("Classifier panel renders a bounded selectable viewport and opens detail", async () => {
	const t = await testRender(
		() => <TestDashboard testData={decisionsFixture(7)} />,
		{ width: 120, height: 40 },
	);
	await dashboardReady(t);

	// With no artifacts, Shift+J skips the empty OpenSpec cell and focuses the
	// Classifier panel. Five of seven decisions are visible initially.
	t.mockInput.pressKey("j", { shift: true });
	await t.renderOnce();
	const initial = t.captureCharFrame();
	expect(initial).toContain("Classifications");
	expect(
		initial.split("\n").filter((line) => line.includes("routing · decision-")),
	).toHaveLength(5);
	expect(initial).not.toContain("decision-6");

	for (let index = 0; index < 5; index++) t.mockInput.pressKey("j");
	await t.renderOnce();
	expect(t.captureCharFrame()).toContain("decision-6");
	t.mockInput.pressEnter();
	const detail = await waitForText(t, (frame) =>
		frame.includes("Classifier · routing · decision-6"),
	);
	expect(detail).toContain("classifier input 6");

	// Closing and reopening leaves the list selection on the same decision.
	t.mockInput.pressEscape();
	await t.waitForFrame(
		(frame) => !frame.includes("Classifier · routing · decision-6"),
	);
	t.mockInput.pressEnter();
	expect(
		await t.waitForFrame((frame) =>
			frame.includes("Classifier · routing · decision-6"),
		),
	).toContain("Classifier · routing · decision-6");
	t.renderer.destroy();
});

test("Classifications panel shows its empty state when the workflow exposes no decisions", async () => {
	const t = await testRender(
		() => <TestDashboard testData={noDecisionsFixture()} />,
		{ width: 120, height: 40 },
	);
	await dashboardReady(t);
	const frame = await t.waitForFrame((value) =>
		value.includes("No classifications recorded yet"),
	);
	expect(frame).toContain("Classifications");
	t.renderer.destroy();
});

test("detail view never renders a Current task panel or row", async () => {
	const t = await testRender(
		() => <TestDashboard testData={artifactsFixture(5)} />,
		{
			width: 120,
			height: 40,
		},
	);
	await dashboardReady(t);

	expect(t.captureCharFrame()).not.toContain("Current task");

	// Visiting every direction of the reduced grid never surfaces it.
	const moves = [
		["j", { shift: true }], // Change → OpenSpec
		["l", { shift: true }], // OpenSpec → Agents
		["k", { shift: true }], // Agents → Evidence (the bottom row)
		["h", { shift: true }], // Agents → Change
	] as const;
	for (const [key, opts] of moves) {
		t.mockInput.pressKey(key, opts);
		await t.renderOnce();
		expect(t.captureCharFrame()).not.toContain("Current task");
	}

	t.renderer.destroy();
});

test("unshifted j scrolls without switching panels; Tab never moves panel focus", async () => {
	const t = await testRender(() => <TestDashboard />, {
		width: 120,
		height: 40,
	});
	await dashboardReady(t);

	// Unshifted j stays on Change (no focus change) — Enter still opens the
	// plan review popup.
	t.mockInput.pressKey("j");
	t.mockInput.pressEnter();
	await t.renderOnce();
	expect(t.captureCharFrame()).toContain("Plan review");
	t.mockInput.pressEscape();
	await t.waitForFrame((frame) => !frame.includes("Plan review"));

	// Tab is unbound for panel navigation (reserved for the shell tab bar):
	// focus stays on Change, so Enter still opens the plan review.
	t.mockInput.pressTab();
	t.mockInput.pressEnter();
	await t.renderOnce();
	expect(t.captureCharFrame()).toContain("Plan review");
	t.mockInput.pressEscape();
	await t.waitForFrame((frame) => !frame.includes("Plan review"));

	// Shift+Tab similarly leaves focus on Change.
	t.mockInput.pressKey("\t", { shift: true });
	t.mockInput.pressEnter();
	await t.renderOnce();
	expect(t.captureCharFrame()).toContain("Plan review");
	t.mockInput.pressEscape();
	await t.waitForFrame((frame) => !frame.includes("Plan review"));

	// From another panel Tab still does not move focus: Shift+J to OpenSpec
	// (artifacts present), Tab, then Enter opens the OpenSpec verdict.
	const t2 = await testRender(
		() => <TestDashboard testData={artifactsFixture(5)} />,
		{
			width: 120,
			height: 40,
		},
	);
	await dashboardReady(t2);
	t2.mockInput.pressKey("j", { shift: true });
	t2.mockInput.pressTab();
	t2.mockInput.pressEnter();
	await t2.renderOnce();
	expect(t2.captureCharFrame()).toContain("OpenSpec ·");

	t2.renderer.destroy();
	t.renderer.destroy();
});

test("help documents directional panel navigation", async () => {
	const t = await testRender(() => <TestDashboard />, {
		width: 120,
		height: 40,
	});
	await dashboardReady(t);

	t.mockInput.pressKey("?");
	const helpFrame = await t.waitForFrame((frame) => frame.includes("J/K/H/L"));
	expect(helpFrame).toContain("Move between panels");
	// In-panel scrolling stays documented alongside the new bindings.
	expect(helpFrame).toContain("Scroll focused panel");
	t.renderer.destroy();
});

test("the durable agent session opens as a page and Esc returns to the grid", async () => {
	const watch = spyOn(HostClient.prototype, "watch").mockImplementation(
		async (_runId, onFrame) => {
			onFrame({ entries: [], docs: {} });
			return () => {};
		},
	);
	const catalog = spyOn(HostClient.prototype, "catalog").mockResolvedValue({
		type: "catalog",
		models: [],
		thinkingLevels: [],
		contextWindows: {},
	});
	const dashboard = testDashboard();
	const agent = dashboard.agents[0];
	if (!agent) throw new Error("demo agent missing");
	const t = await testRender(
		() => (
			<TestDashboard
				testData={{
					...dashboard,
					agents: [
						{
							...agent,
							role: "worker",
							runtime: "pi-durable",
							runId: "run-1",
							// The successful watch boundary above makes this a page/
							// key-routing test, not an unavailable-host test.
							hostSocket: demoSocket,
						},
					],
				}}
			/>
		),
		{ width: 120, height: 40 },
	);
	try {
		await dashboardReady(t);

		t.mockInput.pressKey("l", { shift: true });
		await t.renderOnce();
		t.mockInput.pressEnter();
		const session = await t.waitForFrame((frame) =>
			frame.includes("Ask anything…"),
		);
		// The page replaced the grid rather than floating above it.
		expect(session).not.toContain("Plan review");
		// The view publishes its own catalog: the shell footer and `?` help read
		// the active surface, which is now the session rather than the panels.
		expect(activeKeybindCatalog().map((section) => section.title)).toEqual([
			"Agent session",
		]);
		// `?` on the empty prompt opens that catalog's help (the page is not a
		// dialog, so this is the dashboard's own help overlay).
		t.mockInput.pressKey("?");
		const help = await t.waitForFrame((frame) =>
			frame.includes("Choose command or browse history"),
		);
		expect(help).toContain("Send message (steer if the run is busy)");
		expect(help).toContain("New line in the prompt");

		// Escape closes the help first and leaves the page second: the page keeps
		// its keys while a dialog is on top of it.
		t.mockInput.pressEscape();
		await t.waitForFrame((frame) => !frame.includes("Dashboard keybindings"));
		expect(t.captureCharFrame()).toContain("Ask anything…");
		t.mockInput.pressEscape();
		const grid = await t.waitForFrame(
			(frame) => !frame.includes("Ask anything…"),
		);
		// The grid is showing again, with its own panel keys published.
		expect(grid).toContain("Agents");
		expect(activeKeybindCatalog().map((section) => section.title)).toContain(
			"Navigation",
		);
	} finally {
		t.renderer.destroy();
		watch.mockRestore();
		catalog.mockRestore();
	}
});

test("a shell run request opens that exact durable run only once", async () => {
	const watch = spyOn(HostClient.prototype, "watch").mockImplementation(
		async () => () => {},
	);
	const dashboard = testDashboard("apply");
	const consumed: string[] = [];
	dashboard.state.runs = [
		{
			id: "requested-run",
			role: "worker",
			stepId: "apply",
			attempt: 1,
			status: "working",
			runtime: "pi",
			profile: "default",
			hostSocket: demoSocket,
			conversationId: "durable-requested",
		},
	];
	dashboard.agents = [
		{ role: "other-role", status: "working", runId: "other-run" },
	];
	const t = await testRender(
		() => (
			<TestDashboard
				testData={dashboard}
				agentRunId="requested-run"
				agentRequestId="request-1"
				onAgentRunRequestConsumed={(id) => consumed.push(id)}
			/>
		),
		{ width: 120, height: 40 },
	);
	try {
		const session = await t.waitForFrame((frame) =>
			frame.includes("Ask anything…"),
		);
		expect(session).toContain("Worker");
		expect(session).not.toContain("Other-role");
		expect(consumed).toEqual(["request-1"]);
		t.mockInput.pressEscape();
		await t.waitForFrame((frame) => !frame.includes("Ask anything…"));
		await t.renderOnce();
		expect(t.captureCharFrame()).not.toContain("Ask anything…");
		expect(consumed).toEqual(["request-1"]);
	} finally {
		t.renderer.destroy();
		watch.mockRestore();
	}
});

test("an unavailable recorded session falls back to its exact run row, never another session", async () => {
	const dashboard = testDashboard("apply");
	dashboard.state.runs = [
		{
			id: "requested-run",
			role: "worker",
			stepId: "apply",
			attempt: 1,
			status: "working",
			runtime: "pi",
			profile: "default",
			hostSocket: demoSocket,
			conversationId: "missing-conversation",
		},
	];
	dashboard.agents = [
		{
			role: "other-role",
			status: "working",
			runId: "other-run",
			hostSocket: "/tmp/other-host.sock",
		},
		{
			role: "worker",
			status: "working",
			runId: "requested-run",
			hostSocket: demoSocket,
			conversationId: "missing-conversation",
		},
	];
	const requests: string[] = [];
	const consumed: string[] = [];
	const watch = spyOn(HostClient.prototype, "watch").mockImplementation(
		async (runId, _onFrame, options) => {
			if (options?.view === "docs") return () => {};
			requests.push(runId);
			if (requests.length === 1)
				throw new Error("recorded conversation not found");
			return () => {};
		},
	);
	const t = await testRender(
		() => (
			<TestDashboard
				testData={dashboard}
				agentRunId="requested-run"
				agentRequestId="stale-request"
				onAgentRunRequestConsumed={(id) => consumed.push(id)}
			/>
		),
		{ width: 120, height: 40 },
	);
	try {
		await t.waitForFrame(
			(frame) => requests.length === 1 && !frame.includes("Ask anything…"),
		);
		expect(activeKeybindContext()).toBe("agents");
		expect(consumed).toEqual(["stale-request"]);
		// Enter identifies the focused fallback row through its recorded handle.
		t.mockInput.pressEnter();
		await t.waitForFrame(
			(frame) => requests.length === 2 && frame.includes("Ask anything…"),
		);
		expect(requests).toEqual(["requested-run", "requested-run"]);
		expect(consumed).toEqual(["stale-request"]);
	} finally {
		t.renderer.destroy();
		watch.mockRestore();
	}
});

test("a forged socket cannot acquire activity, catalog or session watches and leaves the exact row selected", async () => {
	const dashboard = testDashboard("apply");
	const run = {
		id: "forged-handle-run",
		role: "worker",
		stepId: "apply",
		attempt: 1,
		status: "working" as const,
		runtime: "pi" as const,
		profile: "default",
		hostSocket: "/tmp/another-workflows-host.sock",
		conversationId: "another-conversation",
	};
	dashboard.state.runs = [run];
	dashboard.agents = [
		{ role: "other-role", runId: "unrelated-run", status: "working" },
		{ ...run, runId: run.id },
	];
	const consumed: string[] = [];
	const watch = spyOn(HostClient.prototype, "watch").mockImplementation(
		async () => () => {},
	);
	const catalog = spyOn(HostClient.prototype, "catalog").mockRejectedValue(
		new Error("must not connect"),
	);
	const t = await testRender(
		() => (
			<TestDashboard
				testData={dashboard}
				agentRunId={run.id}
				agentRequestId="forged-request"
				onAgentRunRequestConsumed={(id) => consumed.push(id)}
			/>
		),
		{ width: 120, height: 40 },
	);
	try {
		await t.renderOnce();
		expect(consumed).toEqual(["forged-request"]);
		expect(activeKeybindContext()).toBe("agents");
		expect(t.captureCharFrame()).not.toContain("Ask anything…");
		expect(t.captureCharFrame()).toContain("unavailable");
		expect(watch).not.toHaveBeenCalled();
		expect(catalog).not.toHaveBeenCalled();
		// Enter retries only the selected exact row; it cannot fall through to
		// the first, unrelated role or bypass the validation through grid opening.
		t.mockInput.pressEnter();
		await t.renderOnce();
		expect(workflowSessions.workflowSessionSocket).toHaveBeenLastCalledWith(
			"/demo",
			"demo",
			run.id,
			run.hostSocket,
		);
		expect(watch).not.toHaveBeenCalled();
		expect(catalog).not.toHaveBeenCalled();
		expect(t.captureCharFrame()).not.toContain("Ask anything…");
		expect(consumed).toEqual(["forged-request"]);
	} finally {
		t.renderer.destroy();
		watch.mockRestore();
		catalog.mockRestore();
	}
});

test("a missing session handle warns while retaining the exact workflow row", async () => {
	const dashboard = testDashboard("apply");
	const run = {
		id: "missing-handle",
		role: "worker",
		stepId: "apply",
		attempt: 1,
		status: "working" as const,
		runtime: "pi" as const,
		profile: "default",
	};
	const row = {
		role: "worker",
		runId: run.id,
		status: "working" as const,
		hostSocket: undefined as string | undefined,
	};
	dashboard.state.runs = [run];
	dashboard.agents = [
		{
			role: "other",
			runId: "other-run",
			status: "working",
			hostSocket: demoSocket,
		},
		row,
	];
	const sessions: string[] = [];
	const watch = spyOn(HostClient.prototype, "watch").mockImplementation(
		async (runId, onValue, options) => {
			if (options?.view !== "docs") {
				sessions.push(runId);
				onValue({ entries: [], docs: {} });
			}
			return () => {};
		},
	);
	const catalog = spyOn(HostClient.prototype, "catalog").mockRejectedValue(
		new Error("no catalog"),
	);
	const consumed: string[] = [];
	const t = await testRender(
		() => (
			<TestDashboard
				testData={dashboard}
				agentRunId={run.id}
				agentRequestId="missing-handle-request"
				onAgentRunRequestConsumed={(id) => consumed.push(id)}
			/>
		),
		{ width: 140, height: 40 },
	);
	try {
		await t.renderOnce();
		expect(activeKeybindContext()).toBe("agents");
		expect(t.captureCharFrame()).toContain(
			"no recorded session handle; showing its workflow row",
		);
		expect(t.captureCharFrame()).not.toContain("Ask anything…");
		expect(consumed).toEqual(["missing-handle-request"]);
		expect(sessions).toEqual([]);
		// Make the same row openable without changing selection. Enter must open
		// this row, not the first unrelated role, and must not replay the request.
		row.hostSocket = demoSocket;
		t.mockInput.pressEnter();
		for (let i = 0; i < 6 && sessions.length === 0; i++) await t.renderOnce();
		expect(sessions).toEqual([run.id]);
		expect(consumed).toEqual(["missing-handle-request"]);
	} finally {
		t.renderer.destroy();
		watch.mockRestore();
		catalog.mockRestore();
	}
});

function connectionDashboard(): DashboardData {
	const dashboard = testDashboard("apply");
	dashboard.state.runs = ["first", "second"].map((id) => ({
		id,
		role: `worker-${id}`,
		stepId: "apply",
		attempt: 1,
		status: "working" as const,
		runtime: "pi" as const,
		profile: "default",
		hostSocket: demoSocket,
	}));
	dashboard.agents = dashboard.state.runs.map((run) => ({
		role: run.role,
		status: "working",
		runId: run.id,
		hostSocket: demoSocket,
	}));
	return dashboard;
}

const connectionFrame = (runId: string, compacting = false) => ({
	entries: [],
	docs: {
		"pi.agent": { model: { provider: "test", modelId: runId } },
		"pi.live": compacting
			? { run: { id: "working" }, compactions: [{ reason: "manual" }] }
			: {},
	},
});

test("opening an agent renders a paused connecting page while recovery is pending", async () => {
	const recovery = Promise.withResolvers<void>();
	const recover = spyOn(
		sessionRecovery,
		"recoverWorkflowSession",
	).mockImplementation(async (_target, _workflowId, runId) => {
		await recovery.promise;
		return { runId, hostSocket: demoSocket, conversationId: "render-test" };
	});
	const watch = spyOn(HostClient.prototype, "watch").mockImplementation(
		async (runId, onFrame, options) => {
			if (options?.view !== "docs") onFrame(connectionFrame(runId));
			return () => {};
		},
	);
	const catalog = spyOn(HostClient.prototype, "catalog").mockRejectedValue(
		new Error("no catalog"),
	);
	const submit = spyOn(HostClient.prototype, "submit");
	const t = await testRender(
		() => (
			<TestDashboard
				testData={connectionDashboard()}
				agentRunId="first"
				agentRequestId="pending-recovery"
			/>
		),
		{ width: 150, height: 45 },
	);
	try {
		const connecting = await waitForText(t, (value) =>
			value.includes("Connecting to the recorded session"),
		);
		expect(connecting).toContain("controls paused");
		expect(connecting).not.toContain("stale");
		t.mockInput.pressEnter();
		await t.renderOnce();
		expect(submit).not.toHaveBeenCalled();
		recovery.resolve();
		await waitForText(
			t,
			(value) =>
				value.includes("test/first") && !value.includes("controls paused"),
		);
	} finally {
		recovery.resolve();
		t.renderer.destroy();
		recover.mockRestore();
		watch.mockRestore();
		catalog.mockRestore();
		submit.mockRestore();
	}
});

test("opening an agent route renders its recorded transcript and subsequent frames", async () => {
	let publish: ((value: unknown) => void) | undefined;
	const frame = (text: string) => ({
		...connectionFrame("first"),
		entries: [
			{
				id: "answer",
				kind: "pi.assistant",
				model: [{ role: "assistant", content: [{ type: "text", text }] }],
			},
		],
	});
	const watch = spyOn(HostClient.prototype, "watch").mockImplementation(
		async (_runId, onFrame, options) => {
			if (options?.view === "docs") return () => {};
			publish = onFrame;
			onFrame(frame("Recorded agent answer"));
			return () => {};
		},
	);
	const catalog = spyOn(HostClient.prototype, "catalog").mockRejectedValue(
		new Error("no catalog"),
	);
	const t = await testRender(
		() => (
			<TestDashboard
				testData={connectionDashboard()}
				agentRunId="first"
				agentRequestId="recorded-transcript"
			/>
		),
		{ width: 150, height: 45 },
	);
	try {
		await waitForText(t, (value) => value.includes("Recorded agent answer"));
		publish?.(frame("Updated agent answer"));
		await waitForText(t, (value) => value.includes("Updated agent answer"));
	} finally {
		t.renderer.destroy();
		watch.mockRestore();
		catalog.mockRestore();
	}
});

test("initial connection is paused without claiming a stale transcript before its first frame", async () => {
	const firstFrame = Promise.withResolvers<void>();
	let waiting = false;
	const watch = spyOn(HostClient.prototype, "watch").mockImplementation(
		async (runId, onFrame, options) => {
			if (options?.view === "docs") return () => {};
			waiting = true;
			await firstFrame.promise;
			onFrame(connectionFrame(runId));
			return () => {};
		},
	);
	const catalog = spyOn(HostClient.prototype, "catalog").mockRejectedValue(
		new Error("no catalog"),
	);
	const submitted: string[] = [];
	const submit = spyOn(HostClient.prototype, "submit").mockImplementation(
		async (runId, text) => {
			submitted.push(text);
			return { type: "submit", runId, submissionId: "sent" };
		},
	);
	const t = await testRender(
		() => (
			<TestDashboard
				testData={connectionDashboard()}
				agentRunId="first"
				agentRequestId="waiting-for-first-frame"
			/>
		),
		{ width: 150, height: 45 },
	);
	try {
		const connecting = await waitForText(
			t,
			(frame) =>
				waiting && frame.includes("Connecting to the recorded session"),
		);
		expect(connecting).toContain("controls paused");
		expect(connecting).not.toContain("stale");
		expect(connecting).not.toContain("Disconnected");
		t.mockInput.pressEnter();
		await t.renderOnce();
		expect(submitted).toEqual([]);
		firstFrame.resolve();
		const connected = await waitForText(
			t,
			(frame) =>
				frame.includes("test/first") && !frame.includes("controls paused"),
		);
		expect(connected).not.toContain("Connecting");
		expect(connected).not.toContain("Disconnected");
		for (const character of "now safe") t.mockInput.pressKey(character);
		t.mockInput.pressEnter();
		await waitForText(t, () => submitted.length === 1);
		expect(submitted).toEqual(["now safe"]);
	} finally {
		firstFrame.resolve();
		t.renderer.destroy();
		watch.mockRestore();
		catalog.mockRestore();
		submit.mockRestore();
	}
});

test("a direct row retry with no authenticated first frame returns to the exact row", async () => {
	let attempts = 0;
	const opened: string[] = [];
	const watch = spyOn(HostClient.prototype, "watch").mockImplementation(
		async (runId, _onFrame, options) => {
			if (options?.view === "docs") return () => {};
			attempts++;
			opened.push(runId);
			throw new Error("host instance identity unavailable; restart local host");
		},
	);
	const catalog = spyOn(HostClient.prototype, "catalog").mockRejectedValue(
		new Error("host instance identity unavailable"),
	);
	const t = await testRender(
		() => (
			<TestDashboard
				testData={connectionDashboard()}
				agentRunId="first"
				agentRequestId="initial-unavailable"
			/>
		),
		{ width: 150, height: 45 },
	);
	try {
		await waitForText(
			t,
			(frame) =>
				attempts === 1 &&
				activeKeybindContext() === "agents" &&
				!frame.includes("Ask anything…"),
		);
		// This is a direct Enter open, without the route's onUnavailable callback.
		t.mockInput.pressEnter();
		const frame = await waitForText(
			t,
			(frame) => attempts === 2 && !frame.includes("Ask anything…"),
		);
		expect(frame).toContain("worker-first");
		expect(frame).not.toContain("Connecting…");
		// No invisible retry survives the fallback, even past the first backoff.
		await new Promise((resolve) => setTimeout(resolve, 550));
		expect(attempts).toBe(2);
		t.mockInput.pressEnter();
		await waitForText(t, () => attempts === 3);
		expect(opened).toEqual(["first", "first", "first"]);
	} finally {
		t.renderer.destroy();
		watch.mockRestore();
		catalog.mockRestore();
	}
});

test("a dropped session marks its transcript stale and pauses controls until a fresh frame", async () => {
	let close: (() => void) | undefined;
	let attempts = 0;
	let refuseReconnect = true;
	const watch = spyOn(HostClient.prototype, "watch").mockImplementation(
		async (runId, onFrame, options) => {
			if (options?.view === "docs") return () => {};
			attempts++;
			if (attempts > 1 && refuseReconnect)
				throw new Error("fresh host-instance authentication failed");
			onFrame(connectionFrame(runId, attempts === 1));
			close = options?.onClose;
			return () => {};
		},
	);
	const catalog = spyOn(HostClient.prototype, "catalog").mockResolvedValue({
		type: "catalog",
		models: [],
		thinkingLevels: [],
		contextWindows: {},
	});
	const submitted: string[] = [];
	const submit = spyOn(HostClient.prototype, "submit").mockImplementation(
		async (runId, text) => {
			submitted.push(text);
			return { type: "submit", runId, submissionId: "sent" };
		},
	);
	const t = await testRender(
		() => (
			<TestDashboard
				testData={connectionDashboard()}
				agentRunId="first"
				agentRequestId="connected"
			/>
		),
		{ width: 150, height: 45 },
	);
	try {
		await waitForText(
			t,
			(frame) => frame.includes("test/first") && frame.includes("Compacting"),
		);
		for (const character of "keep this draft") t.mockInput.pressKey(character);
		await t.renderOnce();
		close?.();
		const stale = await waitForText(t, (frame) =>
			frame.includes("Disconnected"),
		);
		expect(stale).toContain("Transcript is stale; controls paused");
		// No live compaction indicator survives a drop, nor can Enter lose/send a draft.
		expect(stale).toContain("Compacting context"); // last-known transcript stays readable
		expect(stale.slice(stale.indexOf("Disconnected"))).not.toContain(
			"compacting",
		);
		t.mockInput.pressEnter();
		const failedRetry = await waitForText(
			t,
			(frame) => attempts >= 2 && frame.includes("Disconnected"),
		);
		expect(failedRetry).toContain("keep this draft");
		expect(submitted).toEqual([]);
		refuseReconnect = false;
		const recovered = await waitForText(
			t,
			(frame) => attempts >= 3 && !frame.includes("Disconnected"),
		);
		expect(recovered).toContain("test/first");
		expect(recovered).toContain("keep this draft");
		t.mockInput.pressEnter();
		await waitForText(t, () => submitted.length === 1);
		expect(submitted).toEqual(["keep this draft"]);
	} finally {
		t.renderer.destroy();
		watch.mockRestore();
		catalog.mockRestore();
		submit.mockRestore();
	}
});

for (const sameRun of [false, true]) {
	for (const fails of [false, true]) {
		test(`a late abort ${fails ? "failure" : "success"} cannot publish after ${sameRun ? "reopening the same run" : "switching runs"}`, async () => {
			const pending = Promise.withResolvers<void>();
			const notifications = await import("../../src/tui/dash/notifications.ts");
			const notify = spyOn(notifications, "notify").mockImplementation(
				() => {},
			);
			let publish: ((value: unknown) => void) | undefined;
			let sessionWatches = 0;
			const abort = spyOn(HostClient.prototype, "abort").mockImplementation(
				() => pending.promise,
			);
			const watch = spyOn(HostClient.prototype, "watch").mockImplementation(
				async (runId, onFrame, options) => {
					if (options?.view !== "docs") {
						sessionWatches++;
						publish = onFrame;
						onFrame(connectionFrame(runId, true));
					}
					return () => {};
				},
			);
			const catalog = spyOn(HostClient.prototype, "catalog").mockResolvedValue({
				type: "catalog",
				models: [],
				thinkingLevels: [],
				contextWindows: {},
			});
			const [route, setRoute] = createSignal({
				runId: "first",
				requestId: "one",
			});
			const t = await testRender(
				() => (
					<TestDashboard
						testData={connectionDashboard()}
						agentRunId={route().runId}
						agentRequestId={route().requestId}
					/>
				),
				{ width: 150, height: 45 },
			);
			try {
				await waitForText(
					t,
					(frame) =>
						frame.includes("test/first") && frame.includes("Compacting"),
				);
				for (const character of "/abort") t.mockInput.pressKey(character);
				t.mockInput.pressEnter();
				await waitForText(t, () => abort.mock.calls.length === 1);
				const nextRun = sameRun ? "first" : "second";
				setRoute({ runId: nextRun, requestId: "two" });
				await waitForText(
					t,
					(frame) => sessionWatches === 2 && frame.includes(`test/${nextRun}`),
				);
				notify.mockClear();
				if (fails) pending.reject(new Error("originating abort failed"));
				else pending.resolve();
				await t.renderOnce();
				// Notices are projected on a frame: force the replacement's next
				// frame so a late notice cannot remain hidden in the shared state.
				publish?.(connectionFrame(nextRun, true));
				await t.renderOnce();
				expect(notify).not.toHaveBeenCalled();
				const frame = t.captureCharFrame();
				expect(frame).toContain(`test/${nextRun}`);
				expect(frame).not.toContain("Compaction aborted");
				expect(frame).not.toContain("Abort requested");
				expect(frame).not.toContain("Could not abort the run");
			} finally {
				pending.resolve();
				t.renderer.destroy();
				abort.mockRestore();
				notify.mockRestore();
				watch.mockRestore();
				catalog.mockRestore();
			}
		});
	}
}

test("same-run requests supersede pending imports and retain only the newest watch", async () => {
	const dashboard = testDashboard("apply");
	dashboard.state.runs = [
		{
			id: "same-run",
			role: "worker",
			stepId: "apply",
			attempt: 1,
			status: "working",
			runtime: "pi",
			profile: "default",
			hostSocket: demoSocket,
		},
	];
	dashboard.agents = [];
	const [requestId, setRequestId] = createSignal("first");
	const watched: string[] = [];
	let stopped = 0;
	const watch = spyOn(HostClient.prototype, "watch").mockImplementation(
		async (runId) => {
			watched.push(runId);
			return () => {
				stopped += 1;
			};
		},
	);
	const t = await testRender(
		() => (
			<TestDashboard
				testData={dashboard}
				agentRunId="same-run"
				agentRequestId={requestId()}
				onAgentRunRequestConsumed={(id) => {
					if (id === "first") setRequestId("second");
				}}
			/>
		),
		{ width: 120, height: 40 },
	);
	try {
		await t.waitForFrame(
			(frame) => watched.length > 0 && frame.includes("Ask anything…"),
		);
		expect(requestId()).toBe("second");
		expect(watched).toEqual(["same-run"]);
	} finally {
		t.renderer.destroy();
		watch.mockRestore();
	}
	expect(stopped).toBe(1);
});

test("unmount invalidates pending session imports before they can install a watcher", async () => {
	const dashboard = testDashboard("apply");
	dashboard.state.runs = [
		{
			id: "unmounted-run",
			role: "worker",
			stepId: "apply",
			attempt: 1,
			status: "working",
			runtime: "pi",
			profile: "default",
			hostSocket: demoSocket,
		},
	];
	dashboard.agents = [];
	const [mounted, setMounted] = createSignal(true);
	const watch = spyOn(HostClient.prototype, "watch").mockImplementation(
		async () => () => {},
	);
	const t = await testRender(
		() => (
			<Show when={mounted()}>
				<TestDashboard
					testData={dashboard}
					agentRunId="unmounted-run"
					agentRequestId="unmounted-request"
					onAgentRunRequestConsumed={() => setMounted(false)}
				/>
			</Show>
		),
		{ width: 120, height: 40 },
	);
	try {
		await t.renderOnce();
		await new Promise((resolve) => setTimeout(resolve, 20));
		expect(mounted()).toBe(false);
		expect(watch).not.toHaveBeenCalled();
	} finally {
		t.renderer.destroy();
		watch.mockRestore();
	}
});

test("a run without a handle focuses its own row without opening a substitute session", async () => {
	const dashboard = testDashboard("apply");
	dashboard.state.runs = [
		{
			id: "without-handle",
			role: "worker",
			stepId: "apply",
			attempt: 1,
			status: "completed",
			runtime: "pi",
			profile: "default",
		},
	];
	dashboard.agents = [
		{
			role: "other-role",
			status: "working",
			runId: "other-run",
			hostSocket: "/tmp/other.sock",
		},
		{ role: "worker", status: "completed", runId: "without-handle" },
	];
	const consumed: string[] = [];
	const t = await testRender(
		() => (
			<TestDashboard
				testData={dashboard}
				agentRunId="without-handle"
				agentRequestId="request-2"
				onAgentRunRequestConsumed={(id) => consumed.push(id)}
			/>
		),
		{ width: 120, height: 40 },
	);
	try {
		await t.renderOnce();
		expect(consumed).toEqual(["request-2"]);
		expect(activeKeybindContext()).toBe("agents");
		expect(t.captureCharFrame()).not.toContain("Ask anything…");
	} finally {
		t.renderer.destroy();
	}
});

test("a removed or superseded requested run cannot leave an unrelated session selected", async () => {
	for (const removed of [false, true]) {
		const dashboard = testDashboard("apply");
		dashboard.state.runs = removed
			? []
			: [
					{
						id: "historical-run",
						stepId: "plan",
						role: "worker",
						attempt: 1,
						status: "completed",
						runtime: "pi",
						profile: "implementer",
					},
				];
		dashboard.agents = [
			{
				role: "worker",
				runId: "newer-run",
				hostSocket: "/fake/newer.sock",
				status: "working",
			},
		];
		const consumed: string[] = [];
		const t = await testRender(
			() => (
				<TestDashboard
					testData={dashboard}
					agentRunId="historical-run"
					agentRequestId="request-missing"
					onAgentRunRequestConsumed={(id) => consumed.push(id)}
				/>
			),
			{ width: 100, height: 40 },
		);
		try {
			await t.renderOnce();
			expect(consumed).toEqual(["request-missing"]);
			if (!removed)
				await t.waitForFrame((frame) => frame.includes("Historical run:"));
			expect(t.captureCharFrame().includes("Historical run:")).toBe(!removed);
			if (!removed) expect(t.captureCharFrame()).toContain("historical-run");
			t.mockInput.pressEnter();
			await t.renderOnce();
			expect(activeKeybindContext()).toBe("agents");
			expect(t.captureCharFrame()).not.toContain("Ask anything…");
		} finally {
			t.renderer.destroy();
		}
	}
});

test("a narrow historical fallback wraps the full requested UUID instead of clipping its identity", async () => {
	const dashboard = testDashboard("apply");
	const runId = "11111111-2222-3333-4444-555555555555";
	dashboard.state.runs = [
		{
			id: runId,
			role: "worker",
			stepId: "apply",
			attempt: 1,
			status: "completed",
			runtime: "pi",
			profile: "default",
		},
	];
	dashboard.agents = [{ role: "worker", runId: "latest", status: "working" }];
	const t = await testRender(
		() => (
			<TestDashboard
				testData={dashboard}
				agentRunId={runId}
				agentRequestId="narrow-history"
			/>
		),
		{ width: 100, height: 40 },
	);
	try {
		await t.waitForFrame(
			(frame) =>
				frame.includes("Historical run:") && frame.includes("555555555555"),
		);
		const frame = t.captureCharFrame();
		for (const part of runId.split("-")) expect(frame).toContain(part);
		expect(frame).not.toContain("Ask anything…");
	} finally {
		t.renderer.destroy();
	}
});

test("refresh retains the last latest-role selection while a historical row is projected", async () => {
	const dashboard = testDashboard("apply");
	const historicalId = "old-worker";
	dashboard.state.runs = [
		{
			id: historicalId,
			role: "worker",
			stepId: "apply",
			attempt: 1,
			status: "completed",
			runtime: "pi",
			profile: "default",
		},
		{
			id: "new-worker",
			role: "worker",
			stepId: "apply",
			attempt: 2,
			status: "working",
			runtime: "pi",
			profile: "default",
			hostSocket: demoSocket,
			conversationId: "new-conversation",
		},
	];
	dashboard.agents = [
		{
			role: "worker",
			runId: "new-worker",
			status: "working",
			hostSocket: demoSocket,
			conversationId: "new-conversation",
		},
	];
	const subscriptions: GatewayEventHandlers[] = [];
	let reads = 0;
	configureGateway({
		kind: "in-process",
		connectionState: () => "open",
		observe: async (request: ObservationRequest) => {
			if (request.kind === "dashboard") {
				reads++;
				return { ...dashboard, agents: [...dashboard.agents] };
			}
			return [];
		},
		view: async () => {
			throw new Error("no seed view");
		},
		subscribe: (handlers: GatewayEventHandlers) => {
			subscriptions.push(handlers);
			return () => {};
		},
	} as unknown as DashboardGateway);
	const watched: string[] = [];
	const watch = spyOn(HostClient.prototype, "watch").mockImplementation(
		async (runId, _onFrame, options) => {
			if (options?.view !== "docs") watched.push(runId);
			return () => {};
		},
	);
	let t: Test | undefined;
	try {
		t = await testRender(
			() => (
				<TestDashboard
					testData={dashboard}
					live
					agentRunId={historicalId}
					agentRequestId="refresh-history"
				/>
			),
			{ width: 120, height: 60 },
		);
		await t.waitForFrame((frame) => frame.includes("Historical run:"));
		t.mockInput.pressKey("j"); // Historical row at zero; last latest-role row at one.
		await t.renderOnce();
		const before = reads;
		const subscriber = subscriptions[0];
		if (!subscriber) throw new Error("live dashboard subscription missing");
		subscriber.onEvent({
			instance: "test",
			sequence: 1,
			domain: "workflow",
			kind: "workflow.updated",
			resource: "/demo",
			at: "2026-01-01T00:00:00.000Z",
			payload: {},
		});
		for (let i = 0; i < 100 && reads === before; i++) {
			await Bun.sleep(25);
			await t.renderOnce();
		}
		expect(reads).toBeGreaterThan(before);
		await t.renderOnce();
		t.mockInput.pressEnter();
		await t.waitForFrame(() => watched.length > 0);
		expect(watched.at(-1)).toBe("new-worker");
	} finally {
		t?.renderer.destroy();
		watch.mockRestore();
		clearGateway();
	}
});

test("a stale historical session retains visible exact-run focus beside its newer role retry", async () => {
	const dashboard = testDashboard("apply");
	dashboard.state.runs = [
		{
			id: "old-worker",
			stepId: "apply",
			role: "worker",
			attempt: 1,
			status: "completed",
			runtime: "pi",
			profile: "default",
			hostSocket: demoSocket,
			conversationId: "old-conversation",
		},
		{
			id: "new-worker",
			stepId: "apply",
			role: "worker",
			attempt: 2,
			status: "working",
			runtime: "pi",
			profile: "default",
			hostSocket: demoSocket,
			conversationId: "new-conversation",
		},
	];
	dashboard.agents = [
		{
			role: "worker",
			runId: "new-worker",
			status: "working",
			hostSocket: demoSocket,
			conversationId: "new-conversation",
		},
	];
	const requests: string[] = [];
	const consumed: string[] = [];
	const watch = spyOn(HostClient.prototype, "watch").mockImplementation(
		async (runId, _onFrame, options) => {
			if (options?.view === "docs") return () => {};
			requests.push(runId);
			if (requests.length === 1)
				throw new Error("historical session is unavailable");
			return () => {};
		},
	);
	const t = await testRender(
		() => (
			<TestDashboard
				testData={dashboard}
				agentRunId="old-worker"
				agentRequestId="old-request"
				onAgentRunRequestConsumed={(id) => consumed.push(id)}
			/>
		),
		{ width: 120, height: 40 },
	);
	try {
		await t.waitForFrame(
			(frame) =>
				requests.length === 1 &&
				frame.includes("Historical run:") &&
				frame.includes("old-worker") &&
				!frame.includes("Ask anything…"),
		);
		expect(activeKeybindContext()).toBe("agents");
		expect(t.captureCharFrame()).toContain("completed");
		expect(consumed).toEqual(["old-request"]);
		t.mockInput.pressEnter();
		await t.waitForFrame(
			(frame) => requests.length === 2 && frame.includes("Ask anything…"),
		);
		expect(requests).toEqual(["old-worker", "old-worker"]);
		expect(consumed).toEqual(["old-request"]);
	} finally {
		t.renderer.destroy();
		watch.mockRestore();
	}
});

test("Escape on the grid delegates to the composition root's back boundary", async () => {
	let backs = 0;
	const t = await testRender(
		() => (
			<TestDashboard
				onBack={() => {
					backs++;
					return true;
				}}
			/>
		),
		{ width: 120, height: 40 },
	);
	await dashboardReady(t);

	// The grid keeps Escape for the shell: it cannot leave the workflow page
	// itself, so it reports the boundary and lets the composition root navigate.
	// A lone Escape is only delivered after the input parser's short delay.
	await pressEscapeAndSettle(t);
	expect(backs).toBe(1);
	t.renderer.destroy();
});
