/** @jsxImportSource @opentui/solid */
// Pointer tests for the embedded Environments feature's shared parts
// (`unified-feature-shell`): the table row rule, a guarded dialog's backdrop
// policy and the wheel on a detail/log pane (the scroll box owns it natively).
import { expect, spyOn, test } from "bun:test";
import type { ScrollBoxRenderable } from "@opentui/core";
import { testRender } from "@opentui/solid";
import {
	FilterModal,
	GenericModal,
	ScrollableContent,
	WorkItemCard,
} from "@ui";
import { createSignal, For } from "solid-js";
import { SlotsView } from "../../packages/devenv/cli/src/tui/views/slots-view.tsx";

test("a table row selects on a tap and opens its detail on a tap of the selected row", async () => {
	const row = { select: () => {}, activate: () => {} };
	const select = spyOn(row, "select");
	const activate = spyOn(row, "activate");
	const t = await testRender(
		() => (
			<box flexDirection="column" width="100%" height="100%">
				<WorkItemCard
					marker="A"
					title="api"
					statusText="building"
					metadata="docker"
					selected={false}
					index={0}
					onMouseUp={() => row.select()}
					onActivate={() => row.activate()}
				/>
				<WorkItemCard
					marker="B"
					title="web"
					statusText="running"
					metadata="docker"
					selected={true}
					index={1}
					onMouseUp={() => row.select()}
					onActivate={() => row.activate()}
				/>
			</box>
		),
		{ width: 60, height: 10 },
	);
	await t.flush();
	// The very first pointer gesture on a fresh renderer also starts a text
	// selection; consume it outside any row before the measured taps.
	await t.mockMouse.click(55, 9);
	await t.flush();
	// The unselected row only selects: the detail stays closed.
	await t.mockMouse.click(3, 0);
	await t.flush();
	expect(select.mock.calls.length).toBe(1);
	expect(activate.mock.calls.length).toBe(0);
	// The selected row opens its detail on a tap (`Enter`): rows are two lines
	// tall, so the second card starts on line 2.
	await t.mockMouse.click(3, 2);
	await t.flush();
	expect(activate.mock.calls.length).toBe(1);
	// A drag over the rows is text selection, never a row interaction.
	await t.mockMouse.drag(3, 2, 3, 3);
	await t.flush();
	expect(activate.mock.calls.length).toBe(1);
	t.renderer.destroy();
});

test("a guarded environment dialog keeps its control on a backdrop tap", async () => {
	const guarded = { close: () => {} };
	const close = spyOn(guarded, "close");
	const t = await testRender(
		() => (
			<GenericModal
				title="Passphrase required"
				dismissKind="passphrase"
				onBackdropClick={guarded.close}
				help={[{ key: "Enter", action: "Submit" }]}
			>
				<text>secret body</text>
			</GenericModal>
		),
		{ width: 60, height: 16 },
	);
	await t.flush();
	await t.mockMouse.click(1, 1);
	await t.flush();
	expect(close).not.toHaveBeenCalled();
	t.renderer.destroy();
});

test("a slot row selects on a tap and opens its workflow on a tap of the selected row", async () => {
	const activated = { run: () => {} };
	const activate = spyOn(activated, "run");
	const selected: number[] = [];
	const rows = ["api", "web", "worker"].map((app) => ({
		app,
		holder: "workflow",
		status: "running",
		endpoints: {},
		holderSince: null,
		idleMs: null,
		idleTtlMs: null,
		waiting: [],
	}));
	const t = await testRender(
		() => (
			<SlotsView
				rows={rows}
				selectedIndex={1}
				onSelectIndex={(index) => selected.push(index)}
				nowMs={0}
				height={6}
				loading={false}
				error={null}
			/>
		),
		{ width: 120, height: 10 },
	);
	const { createDefaultOpenTuiKeymap } = await import(
		"@opentui/keymap/opentui"
	);
	const keymap = createDefaultOpenTuiKeymap(t.renderer);
	keymap.registerLayer({
		name: "probe",
		commands: [
			{
				name: "probe.openWorkflow",
				context: "global",
				run: () => {
					activated.run();
					return true;
				},
			},
		],
		bindings: [
			{ key: "enter", cmd: "probe.openWorkflow" },
			{ key: "return", cmd: "probe.openWorkflow" },
		],
	});
	await t.flush();
	// The header owns row 0, so the first slot row is row 1. It is not the
	// cursor, so the tap only selects it.
	await t.mockMouse.click(3, 1);
	await t.flush();
	expect(selected).toEqual([0]);
	expect(activate.mock.calls.length).toBe(0);
	// A tap on the selected row (row 2, the row the cursor starts on) opens it.
	await t.mockMouse.click(3, 2);
	await t.flush();
	expect(activate.mock.calls.length).toBe(1);
	t.renderer.destroy();
});

test("the wheel scrolls a detail pane without touching the keys", async () => {
	let box: ScrollBoxRenderable | undefined;
	const t = await testRender(
		() => (
			<box width="100%" height="100%" flexDirection="column">
				<ScrollableContent
					style={{ height: 4 }}
					onScrollBoxReady={(ready) => {
						box = ready;
					}}
				>
					<For each={Array.from({ length: 30 }, (_, index) => index)}>
						{(line) => <text>{`detail line ${line}`}</text>}
					</For>
				</ScrollableContent>
			</box>
		),
		{ width: 60, height: 10 },
	);
	await t.flush();
	expect(box).toBeDefined();
	expect(box?.scrollTop ?? 0).toBe(0);
	// The scroll box ramps its acceleration, so a gesture is a few notches; what
	// matters is that the nested list did not swallow them.
	for (let notch = 0; notch < 4; notch += 1)
		await t.mockMouse.scroll(2, 1, "down");
	await t.flush();
	expect(box?.scrollTop ?? 0).toBeGreaterThan(0);
	t.renderer.destroy();
});

test("a slot row the store replaced still completes the press it started", async () => {
	const selected: number[] = [];
	const row = (app: string) => ({
		app,
		holder: "workflow",
		status: "running",
		endpoints: {},
		holderSince: null,
		idleMs: null,
		idleTtlMs: null,
		waiting: [],
	});
	const [rows, setRows] = createSignal([row("api"), row("web")]);
	const t = await testRender(
		() => (
			<SlotsView
				rows={rows()}
				selectedIndex={1}
				onSelectIndex={(index) => selected.push(index)}
				nowMs={0}
				height={6}
				loading={false}
				error={null}
			/>
		),
		{ width: 120, height: 10 },
	);
	await t.flush();
	// Press the first row, then let the store replace that row object (a status
	// message rebuilds it), which recreates the row component.
	await t.mockMouse.pressDown(3, 1);
	setRows([row("api"), row("web")]);
	await t.flush();
	await t.mockMouse.release(3, 1);
	await t.flush();
	// The list's shared gesture holder still knows which row was pressed.
	expect(selected).toEqual([0]);
	t.renderer.destroy();
});

test("a filter dialog row selects through the pane's own callback", async () => {
	const parameters: number[] = [];
	const values: number[] = [];
	const t = await testRender(
		() => (
			<FilterModal
				parameters={[
					{
						key: "status",
						label: "Status",
						values: [
							{ value: "open", label: "Open" },
							{ value: "closed", label: "Closed" },
						],
					},
					{
						key: "type",
						label: "Type",
						values: [{ value: "bug", label: "Bug" }],
					},
				]}
				selectedParameterIndex={0}
				selectedValueIndex={1}
				focusedPane="value"
				activeFilters={{}}
				onSelectParameter={(index) => parameters.push(index)}
				onSelectValue={(index) => values.push(index)}
			/>
		),
		{ width: 90, height: 20 },
	);
	await t.flush();
	const lines = t.captureCharFrame().split("\n");
	// The value pane lists the selected parameter's values.
	const rowY = lines.findIndex((line) => line.includes("Closed"));
	expect(rowY).toBeGreaterThan(0);
	// A value row reports through the value pane's setter (the value column sits
	// to the right of the criteria column).
	await t.mockMouse.click(45, rowY);
	await t.flush();
	expect(values.at(-1)).toBe(1);
	expect(parameters).toEqual([]);
	// A drag and a right click change nothing.
	await t.mockMouse.drag(45, rowY, 47, rowY + 1);
	await t.mockMouse.click(45, rowY, 2);
	await t.flush();
	expect(values.length).toBe(1);
	t.renderer.destroy();
});

test("a tap on the selected filter row runs the surface's own apply key", async () => {
	const parameters: number[] = [];
	const values: number[] = [];
	const applied: string[] = [];
	const t = await testRender(
		() => (
			<FilterModal
				parameters={[
					{
						key: "status",
						label: "Status",
						values: [
							{ value: "open", label: "Open" },
							{ value: "closed", label: "Closed" },
						],
					},
				]}
				selectedParameterIndex={0}
				selectedValueIndex={0}
				focusedPane="value"
				activeFilters={{}}
				onSelectParameter={(index) => parameters.push(index)}
				onSelectValue={(index) => values.push(index)}
				// The environment applies with Space; Enter closes the dialog there.
				activateKey="Space"
			/>
		),
		{ width: 90, height: 20 },
	);
	const { createDefaultOpenTuiKeymap } = await import(
		"@opentui/keymap/opentui"
	);
	const keymap = createDefaultOpenTuiKeymap(t.renderer);
	keymap.registerLayer({
		name: "probe",
		commands: [
			{
				name: "probe.apply",
				context: "global",
				run: ({ event }) => {
					if (event.sequence !== " ") return false;
					applied.push("space");
					return true;
				},
			},
		],
		bindings: [{ key: "space", cmd: "probe.apply" }],
	});
	await t.flush();
	const lines = t.captureCharFrame().split("\n");
	const rowY = lines.findIndex((line) => line.includes("Open"));
	expect(rowY).toBeGreaterThan(0);
	// The first tap selects the already-selected row again and the *second* is the
	// surface's activation: the tap on the selected row applies.
	await t.mockMouse.click(45, rowY);
	await t.flush();
	const afterFirst = values.length;
	await t.mockMouse.click(45, rowY);
	await t.flush();
	expect(values.length).toBe(afterFirst);
	expect(applied).toEqual(["space"]);
	expect(parameters).toEqual([]);
	t.renderer.destroy();
});
