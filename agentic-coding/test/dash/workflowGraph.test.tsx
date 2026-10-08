/** @jsxImportSource @opentui/solid */
/** custom-workflow-presentation: the Change panel's custom badge and rationale
 * line, the workflow graph dialog (`g`), its keybind in the footer and `?` help,
 * and the pure row projection behind it. */
import { expect, test } from "bun:test";
import { parseColor } from "@opentui/core";
import { createDefaultOpenTuiKeymap } from "@opentui/keymap/opentui";
import { testRender, useRenderer } from "@opentui/solid";
import { StatusBar, uiColors } from "@ui";
import { createSignal, onCleanup } from "solid-js";
import {
	type DashboardData,
	decodeWorkflowDefinitionGraph,
	type WorkflowDefinitionGraph,
} from "../../src/contracts/workflow.ts";
import { App as DashApp } from "../../src/tui/dash/App.tsx";
import { testDashboard } from "../../src/tui/dash/demo.ts";
import {
	WorkflowGraphModal,
	workflowGraphRows,
	workflowGraphTitle,
} from "../../src/tui/dash/modals/WorkflowGraphModal.tsx";
import { ChangePanel } from "../../src/tui/dash/panels/ChangePanel.tsx";
import { credentialPromptBridge } from "../../src/tui/dash/ui/CredentialsModal.tsx";

type Test = Awaited<ReturnType<typeof testRender>>;

/** A small compiled graph: the three shapes the dialog has to distinguish —
 * logical agent and developer steps, and the routing/gate machinery the engine
 * inserts around them. */
const graph: WorkflowDefinitionGraph = {
	steps: [
		{
			id: "core.route-implementation",
			label: "Route: implementation",
			actor: "system",
			inserted: true,
		},
		{
			id: "core.implementation",
			label: "Implementation",
			actor: "agent",
			inserted: false,
		},
		{
			id: "core.review-gate",
			label: "Review gate",
			actor: "system",
			inserted: true,
		},
		{
			id: "core.developer-review",
			label: "Developer review",
			actor: "developer",
			inserted: false,
		},
		{
			id: "core.closed",
			label: "Closed",
			actor: "system",
			inserted: false,
		},
	],
	edges: [
		{
			from: "core.route-implementation",
			outcome: "complete",
			to: "core.implementation",
		},
		{
			from: "core.implementation",
			outcome: "complete",
			to: "core.review-gate",
		},
		{
			from: "core.implementation",
			outcome: "blocked",
			to: "core.implementation",
			loop: { maxAttempts: 6 },
		},
		{ from: "core.review-gate", outcome: "run", to: "core.developer-review" },
		{ from: "core.developer-review", outcome: "approve", to: "core.closed" },
	],
};

const RATIONALE =
	"One implementation agent, start to finish.\nThe rest of the rationale stays in the record.";

/** The demo dashboard with the pinned custom definition the panel and dialog
 * read, so the render tests exercise the same props the live route passes. */
function customDashboard(phase = "proposed"): DashboardData {
	const demo = testDashboard(phase);
	return {
		...demo,
		state: {
			...demo.state,
			stepId: "core.developer-review",
			stepLabel: "Developer review",
			definition: {
				id: "custom.abc123def456",
				version: 1,
				digest: "definition-digest",
				label: "Orchestrator shape",
			},
			definitionOrigin: { kind: "custom", origin: "blueprint" },
			blueprintRationale: RATIONALE,
			definitionGraph: graph,
		},
	};
}

function builtinDashboard(): DashboardData {
	const demo = testDashboard();
	return {
		...demo,
		state: {
			...demo.state,
			definition: {
				id: "no-openspec",
				version: 106,
				digest: "builtin-digest",
				label: "No OpenSpec",
			},
			definitionOrigin: { kind: "built-in" },
			definitionGraph: graph,
		},
	};
}

function longGraph(): WorkflowDefinitionGraph {
	const steps = Array.from({ length: 18 }, (_, index) => ({
		id: index === 0 ? "core.route-start" : `stage.${index}`,
		label: index === 0 ? "Route start" : `Stage ${index}`,
		actor: index === 0 ? ("system" as const) : ("agent" as const),
		inserted: index === 0,
	}));
	const edges = steps.flatMap((step, index) => {
		const next = steps[index + 1];
		return next ? [{ from: step.id, outcome: "complete", to: next.id }] : [];
	});
	return { steps, edges };
}

function scrollingDashboard(): DashboardData {
	const demo = customDashboard();
	return {
		...demo,
		state: {
			...demo.state,
			stepId: "stage.9",
			stepLabel: "Stage 9",
			definitionGraph: longGraph(),
		},
	};
}

function dashboardWithGraph(graph: unknown): DashboardData {
	const demo = customDashboard();
	return {
		...demo,
		state: {
			...demo.state,
			definitionGraph: graph as DashboardData["state"]["definitionGraph"],
		},
	};
}

test("the graph rows list every step in walk order with its own edges", () => {
	const rows = workflowGraphRows(graph, "core.developer-review");
	expect(
		rows.map((row) => (row.kind === "step" ? row.id : `→ ${row.to}`)),
	).toEqual([
		"core.route-implementation",
		"→ core.implementation",
		"core.implementation",
		"→ core.review-gate",
		"→ core.implementation",
		"core.review-gate",
		"→ core.developer-review",
		"core.developer-review",
		"→ core.closed",
		"core.closed",
	]);
	const steps = rows.filter((row) => row.kind === "step");
	expect(steps.map((step) => step.current)).toEqual([
		false,
		false,
		false,
		true,
		false,
	]);
	// Inserted machinery is marked so the dialog can dim it; logical steps are not.
	expect(steps.map((step) => step.inserted)).toEqual([
		true,
		false,
		true,
		false,
		false,
	]);
	// An edge names its target by label, and carries the loop bound when it re-enters.
	const edges = rows.filter((row) => row.kind === "edge");
	expect(
		edges.filter((edge) => edge.toLabel === "Implementation"),
	).toHaveLength(2);
	expect(
		edges
			.filter((edge) => edge.maxAttempts !== undefined)
			.map((edge) => edge.outcome),
	).toEqual(["blocked"]);
});

test("the dialog keeps the origin in its title and truncates the definition label separately", async () => {
	const t = await testRender(
		() => (
			<WorkflowGraphModal
				definition={{
					label:
						"A very long orchestrator-authored workflow label that will not fit in the dialog header or body row",
					version: 1,
				}}
				origin={{ kind: "custom", origin: "blueprint" }}
				graph={graph}
				currentStep="core.implementation"
				offset={0}
				lines={4}
			/>
		),
		{ width: 80, height: 30 },
	);
	await t.flush();
	const frame = t.captureCharFrame();
	expect(frame).toContain("Workflow graph · custom · blueprint");
	const labelRow = frame
		.split("\n")
		.find((line) => line.includes("A very long orchestrator-"));
	expect(labelRow).toBeDefined();
	expect(labelRow).toContain("...");
	const stepRow = frame
		.split("\n")
		.find((line) => line.includes("Route: implementation"));
	expect(stepRow).toBeDefined();
	expect(stepRow).toContain("...");
	t.renderer.destroy();
});

test("the dialog title names the definition and where it came from", () => {
	expect(workflowGraphTitle({ kind: "custom", origin: "blueprint" })).toBe(
		"Workflow graph · custom · blueprint",
	);
	expect(workflowGraphTitle({ kind: "built-in" })).toBe(
		"Workflow graph · built-in",
	);
	expect(workflowGraphTitle(undefined)).toBe(
		"Workflow graph · origin unavailable",
	);
});

test("the graph dialog marks the current step, dims inserted steps and lists edges", async () => {
	const t = await testRender(
		() => (
			<WorkflowGraphModal
				definition={{ label: "Orchestrator shape", version: 1 }}
				origin={{ kind: "custom", origin: "blueprint" }}
				graph={graph}
				currentStep="core.developer-review"
				offset={0}
				lines={20}
			/>
		),
		{ width: 110, height: 40 },
	);
	await t.flush();
	const frame = t.captureCharFrame();
	expect(frame).toContain("Workflow graph · custom · blueprint");
	expect(frame).toContain("Orchestrator shape · v1");
	// Steps in walk order, with the inserted machinery present and distinguishable.
	expect(frame).toContain("Route: implementation");
	expect(frame).toContain("(core.route-implementation · system)");
	expect(frame).toContain("Implementation");
	expect(frame).toContain("(core.implementation · agent)");
	// The current step carries the marker; the others do not.
	expect(frame).toContain("▸ Developer review");
	expect(frame).not.toContain("▸ Implementation");
	// The text alone does not show dimming; pin the painted foregrounds for both
	// inserted/logical step labels and inserted/logical outcome edges.
	const foreground = (text: string) => {
		for (const line of t.captureSpans().lines) {
			for (const span of line.spans) {
				if (span.text.includes(text)) return span.fg;
			}
		}
		return undefined;
	};
	const rgb = (color: unknown) => {
		const buffer = (color as { buffer: Record<string, number> }).buffer;
		return [buffer[0], buffer[1], buffer[2]].map(Math.round).join(",");
	};
	const theme = (hex: string) => {
		const parsed = parseColor(hex) as unknown as {
			r: number;
			g: number;
			b: number;
		};
		return [parsed.r, parsed.g, parsed.b]
			.map((part) => Math.round(part * 255))
			.join(",");
	};
	expect(rgb(foreground("Route: implementation"))).toBe(
		theme(uiColors.textMuted),
	);
	expect(rgb(foreground("Implementation (core.implementation · agent)"))).toBe(
		theme(uiColors.textPrimary),
	);
	expect(rgb(foreground("complete → Implementation"))).toBe(
		theme(uiColors.textMuted),
	);
	expect(rgb(foreground("complete → Review gate"))).toBe(
		theme(uiColors.textPrimary),
	);
	// Outcome edges are indented under the step that owns them, including loop bounds.
	expect(frame).toContain("    complete → Implementation");
	expect(frame).toContain("    run → Developer review");
	expect(frame).toContain("    blocked → Implementation ↻6");
	t.renderer.destroy();
});

test("the graph dialog scrolls and says so when a pin has no graph", async () => {
	const scroll = await testRender(
		() => (
			<WorkflowGraphModal
				definition={{ label: "No OpenSpec", version: 106 }}
				origin={{ kind: "built-in" }}
				graph={graph}
				currentStep="core.implementation"
				offset={20}
				lines={2}
			/>
		),
		{ width: 110, height: 40 },
	);
	await scroll.flush();
	const frame = scroll.captureCharFrame();
	// Past-end offsets are clamped onto the last rows instead of blanking the dialog.
	expect(frame).toContain("Closed");
	scroll.renderer.destroy();

	const empty = await testRender(
		() => (
			<WorkflowGraphModal
				definition={{ label: "Pin mismatch", version: 1 }}
				currentStep="core.implementation"
				offset={0}
				lines={10}
			/>
		),
		{ width: 110, height: 40 },
	);
	await empty.flush();
	const emptyFrame = empty.captureCharFrame();
	expect(emptyFrame).toContain(
		"No compiled graph is available for this definition.",
	);
	empty.renderer.destroy();

	const malformed = await testRender(
		() => (
			<WorkflowGraphModal
				definition={{ label: "Malformed response", version: 1 }}
				currentStep="core.implementation"
				graph={
					{
						steps: ["not-a-step"],
						edges: [],
					} as unknown as WorkflowDefinitionGraph
				}
				offset={0}
				lines={10}
			/>
		),
		{ width: 110, height: 40 },
	);
	await malformed.flush();
	expect(malformed.captureCharFrame()).toContain(
		"No compiled graph is available for this definition.",
	);
	malformed.renderer.destroy();
});

test("the Change panel shows the custom badge and the rationale's first line", async () => {
	const t = await testRender(
		() => <ChangePanel data={customDashboard()} active={false} />,
		{ width: 100, height: 30 },
	);
	const frame = await t.waitForFrame((value) => value.includes("FLOW"));
	expect(frame).toContain("Orchestrator shape · v1");
	expect(frame).toContain("custom · blueprint");
	// Only the first line lands in the panel; the rest stays in the record.
	expect(frame).toContain("One implementation agent, start to finish.");
	expect(frame).not.toContain("The rest of the rationale stays in the record.");
	t.renderer.destroy();
});

test("a narrow Change panel truncates the definition label before the fixed custom badge", async () => {
	const t = await testRender(
		() => <ChangePanel data={customDashboard()} active={false} />,
		{ width: 44, height: 30 },
	);
	const frame = await t.waitForFrame((value) => value.includes("FLOW"));
	expect(frame).toContain("custom · blueprint");
	const flowRow = frame
		.split("\n")
		.find((line) => line.includes("custom · blueprint"));
	expect(flowRow).toBeDefined();
	if (!flowRow) throw new Error("custom origin row not rendered");
	expect(flowRow).toContain("...");
	expect(flowRow.indexOf("...")).toBeLessThan(
		flowRow.indexOf("custom · blueprint"),
	);
	t.renderer.destroy();
});

test("the Change panel shows no custom badge or rationale for a built-in definition", async () => {
	const t = await testRender(
		() => <ChangePanel data={builtinDashboard()} active={false} />,
		{ width: 100, height: 30 },
	);
	const frame = await t.waitForFrame((value) => value.includes("FLOW"));
	expect(frame).toContain("No OpenSpec · v106");
	expect(frame).not.toContain("custom ·");
	expect(frame).not.toContain("WHY");
	t.renderer.destroy();
});

test("the Change panel ignores malformed custom origin and rationale values", async () => {
	const demo = customDashboard();
	const malformed = {
		...demo,
		state: {
			...demo.state,
			definitionOrigin: { kind: "custom", origin: 42 },
			blueprintRationale: 42,
		} as unknown as DashboardData["state"],
	};
	const t = await testRender(
		() => <ChangePanel data={malformed} active={false} />,
		{ width: 100, height: 30 },
	);
	const frame = await t.waitForFrame((value) => value.includes("FLOW"));
	expect(frame).not.toContain("custom ·");
	expect(frame).not.toContain("WHY");
	t.renderer.destroy();
});

/** The dashboard route with the production keymap fields, so the detail layer's
 * bindings (`g`) and the footer's active catalog behave as they do in the shell. */
function TestDashboard(props: {
	testData: DashboardData;
	active?: () => boolean;
}) {
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
		agentView(value, ctx) {
			ctx.require("agent.view", String(value));
		},
	});
	onCleanup(() => {
		disposeKeymap();
		dispose();
	});
	return (
		<box style={{ width: "100%", height: "100%", flexDirection: "column" }}>
			<box style={{ flexGrow: 1, minHeight: 0 }}>
				<DashApp
					repo="/demo"
					workflowId="demo"
					profile="test"
					keymap={keymap}
					active={props.active}
					testData={props.testData}
				/>
			</box>
			<StatusBar />
		</box>
	);
}

async function dashboardReady(t: Test) {
	await t.waitForFrame((frame) => frame.includes("Plan review"));
	t.mockInput.pressEscape();
	await t.waitForFrame((frame) => !frame.includes("Plan review"));
}

test("`g` on the Change panel opens the graph dialog and the footer advertises it", async () => {
	const t = await testRender(
		() => <TestDashboard testData={scrollingDashboard()} />,
		{
			width: 140,
			height: 32,
		},
	);
	await dashboardReady(t);

	// The Change panel is focused by default: its catalog carries the graph key.
	const change = t.captureCharFrame();
	expect(change).toContain("g graph");
	expect(change).not.toContain("Show workflow graph");

	// Shift+L focuses Agents: `g` is absent from that footer and pressing it does
	// not open the graph, even though the detail keymap has a g binding.
	t.mockInput.pressKey("l", { shift: true });
	const agents = await t.waitForFrame((frame) => frame.includes("Enter focus"));
	expect(agents).not.toContain("g graph");
	t.mockInput.pressKey("g");
	await t.renderOnce();
	expect(t.captureCharFrame()).not.toContain("Workflow graph");

	// Return to Change: the same key now opens the pinned graph.
	t.mockInput.pressKey("h", { shift: true });
	await t.waitForFrame((frame) => frame.includes("g graph"));
	t.mockInput.pressKey("g");
	const opened = await t.waitForFrame((frame) =>
		frame.includes("Workflow graph"),
	);
	expect(opened).toContain("custom · blueprint");
	expect(opened).toContain("Route start");
	expect(opened).not.toContain("Stage 17");

	// Exercise the modal's own key layer: scrolling past the end stays populated,
	// and scrolling back reveals the first inserted step again.
	for (let index = 0; index < 30; index++) t.mockInput.pressKey("j");
	const bottom = await t.waitForFrame((frame) => frame.includes("Stage 17"));
	expect(bottom).not.toContain("Route start");
	for (let index = 0; index < 30; index++) t.mockInput.pressKey("k");
	const top = await t.waitForFrame((frame) => frame.includes("Route start"));
	expect(top).not.toContain("Stage 17");
	// Close it while scrolled at the bottom, then reopening starts from row zero.
	for (let index = 0; index < 30; index++) t.mockInput.pressKey("j");
	await t.waitForFrame((frame) => frame.includes("Stage 17"));
	// The dialog's own `?` help lists what it does, and Esc closes it again.
	t.mockInput.pressKey("?");
	const help = await t.waitForFrame((frame) => frame.includes("Keybindings"));
	expect(help).toContain("Scroll");
	t.mockInput.pressEscape();
	await t.waitForFrame((frame) => !frame.includes("Keybindings"));
	t.mockInput.pressEscape();
	await t.waitForFrame((frame) => !frame.includes("Workflow graph"));
	expect(t.captureCharFrame()).toContain("g graph");
	t.mockInput.pressKey("g");
	const reopened = await t.waitForFrame(
		(frame) =>
			frame.includes("Workflow graph") && frame.includes("Route start"),
	);
	expect(reopened).not.toContain("Stage 17");
	t.mockInput.pressEscape();
	await t.waitForFrame((frame) => !frame.includes("Workflow graph"));

	// The dashboard's own `?` help lists the full action, not the footer's short label.
	t.mockInput.pressKey("?");
	const dashboardHelp = await t.waitForFrame((frame) =>
		frame.includes("Dashboard keybindings"),
	);
	expect(dashboardHelp).toContain("Show workflow graph");
	t.renderer.destroy();
});

test("malformed aggregate graphs stay unavailable when scrolling", async () => {
	const oversized = {
		steps: Array.from({ length: 65 }, (_, index) => ({
			id: `step.${index}`,
			label: `Step ${index}`,
			actor: "agent",
			inserted: false,
		})),
		edges: [],
	};
	expect(decodeWorkflowDefinitionGraph(oversized)).toBeUndefined();
	const t = await testRender(
		() => (
			<TestDashboard
				testData={dashboardWithGraph({ steps: undefined, edges: [] })}
			/>
		),
		{ width: 140, height: 32 },
	);
	await dashboardReady(t);
	t.mockInput.pressKey("g");
	await t.waitForFrame((frame) =>
		frame.includes("No compiled graph is available for this definition."),
	);
	t.mockInput.pressKey("j");
	t.mockInput.pressKey("down");
	await t.renderOnce();
	expect(t.captureCharFrame()).toContain(
		"No compiled graph is available for this definition.",
	);
	t.renderer.destroy();
});

test("a hidden dashboard does not restore a cleared graph modal after credential abort", async () => {
	const [active, setActive] = createSignal(true);
	const t = await testRender(
		() => <TestDashboard testData={customDashboard("apply")} active={active} />,
		{ width: 140, height: 32 },
	);
	await t.waitForFrame((frame) => frame.includes("g graph"));
	t.mockInput.pressKey("g");
	await t.waitForFrame((frame) => frame.includes("Workflow graph"));

	const controller = new AbortController();
	const credential = credentialPromptBridge()(
		"Enter passphrase for test key:",
		controller.signal,
	);
	await t.waitForFrame((frame) => frame.includes("SSH credential required"));
	setActive(false);
	await t.renderOnce();
	controller.abort();
	await expect(credential).resolves.toBe("");
	setActive(true);
	await t.renderOnce();

	// The hidden transition cleared the modal stack; a stale saved kind must
	// not keep its modal layer active after the credential prompt aborts.
	t.mockInput.pressKey("l", { shift: true });
	const agents = await t.waitForFrame((frame) => frame.includes("Enter focus"));
	expect(agents).not.toContain("Workflow graph");
	t.renderer.destroy();
});
