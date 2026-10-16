/** @jsxImportSource @opentui/solid */
// Renderer tests for the shared pointer layer: the tap/drag/wheel/dismiss
// semantics are asserted at the renderer boundary, with the same mock pointer
// input the existing surfaces use.
import { expect, spyOn, test } from "bun:test";
import { testRender } from "@opentui/solid";
import {
	GenericModal,
	ListViewModal,
	Panel,
	ScrollableContent,
	ScrollableList,
	StatusBar,
	useModalBackdrop,
	useTap,
} from "@ui";
import { createSignal } from "solid-js";
import {
	Overlays,
	type OverlaysState,
} from "../../src/tui/dash/modals/Overlays.tsx";

type Counters = {
	selected: number[];
	activated: number[];
};

const newCounters = (): Counters => ({ selected: [], activated: [] });

function ProbeList(props: {
	counters: Counters;
	selectedIndex?: () => number;
	label?: string;
}) {
	const items = () => ["alpha", "bravo", "charlie", "delta", "echo"];
	return (
		<ScrollableList
			items={items()}
			selectedIndex={props.selectedIndex?.() ?? 0}
			availableLines={6}
			showScrollIndicator={false}
			estimatedItemHeight={1}
			onSelect={(index) => props.counters.selected.push(index)}
			onActivate={(index) => props.counters.activated.push(index)}
			renderItem={(item) => (
				<box height={1}>
					<text>{item}</text>
				</box>
			)}
		/>
	);
}

test("a tap selects the row under the pointer", async () => {
	const counters = newCounters();
	const t = await testRender(() => <ProbeList counters={counters} />, {
		width: 40,
		height: 10,
	});
	await t.flush();
	await t.mockMouse.click(2, 1);
	await t.flush();
	expect(counters.selected).toEqual([1]);
	expect(counters.activated).toEqual([]);
	t.renderer.destroy();
});

test("a tap on the selected row activates it", async () => {
	const counters = newCounters();
	// The cursor starts on row 2, so activation can only come from the
	// selected-row branch: no earlier tap on that row is involved.
	const [selected, setSelected] = createSignal(2);
	const t = await testRender(
		() => <ProbeList counters={counters} selectedIndex={selected} />,
		{ width: 40, height: 10 },
	);
	await t.flush();
	await t.mockMouse.click(2, 2);
	await t.flush();
	expect(counters.selected).toEqual([]);
	expect(counters.activated).toEqual([2]);
	setSelected(0);
	await t.flush();
	await t.mockMouse.click(2, 2);
	await t.flush();
	expect(counters.selected).toEqual([2]);
	expect(counters.activated).toEqual([2]);
	t.renderer.destroy();
});

test("a tap on a scrolled window selects the row under the pointer", async () => {
	// 20 rows in a 4-line window: the renderer hands each row its absolute index,
	// so a tap cannot resolve to a window-relative one (design D4).
	const counters = newCounters();
	const [selected, setSelected] = createSignal(19);
	const items = Array.from({ length: 20 }, (_, index) => `row ${index}`);
	const t = await testRender(
		() => (
			<ScrollableList
				items={items}
				selectedIndex={selected()}
				availableLines={4}
				showScrollIndicator={false}
				estimatedItemHeight={1}
				onSelect={(index) => counters.selected.push(index)}
				onActivate={(index) => counters.activated.push(index)}
				renderItem={(item) => (
					<box height={1}>
						<text>{item}</text>
					</box>
				)}
			/>
		),
		{ width: 40, height: 10 },
	);
	await t.flush();
	// The window starts at row 16, so the first painted row is 16 and the last is 19.
	await t.mockMouse.click(1, 0);
	await t.flush();
	expect(counters.selected).toEqual([16]);
	await t.mockMouse.click(2, 3);
	await t.flush();
	expect(counters.activated).toEqual([19]);
	// The scrollbar column belongs to no row, and a tap above the window
	// selects nothing.
	await t.mockMouse.click(39, 1);
	await t.mockMouse.click(2, 6);
	await t.flush();
	expect(counters.selected).toEqual([16]);
	expect(counters.activated).toEqual([19]);
	setSelected(0);
	t.renderer.destroy();
});

test("a double tap selects and then activates exactly once", async () => {
	const counters = newCounters();
	// Selection is synchronous, so the tap itself is what moves the cursor: the
	// first tap selects, the second lands on the selected row and activates.
	const [selected, setSelected] = createSignal(0);
	const t = await testRender(
		() => (
			<ScrollableList
				items={["alpha", "bravo", "charlie", "delta", "echo"]}
				selectedIndex={selected()}
				availableLines={6}
				showScrollIndicator={false}
				estimatedItemHeight={1}
				onSelect={(index) => {
					counters.selected.push(index);
					setSelected(index);
				}}
				onActivate={(index) => counters.activated.push(index)}
				renderItem={(item) => (
					<box height={1}>
						<text>{item}</text>
					</box>
				)}
			/>
		),
		{ width: 40, height: 10 },
	);
	await t.flush();
	await t.mockMouse.click(3, 3);
	await t.flush();
	await t.mockMouse.click(3, 3);
	await t.flush();
	expect(counters.selected).toEqual([3]);
	expect(counters.activated).toEqual([3]);
	t.renderer.destroy();
});

test("a tap outside the rows changes nothing", async () => {
	const counters = newCounters();
	const t = await testRender(() => <ProbeList counters={counters} />, {
		width: 40,
		height: 10,
	});
	await t.flush();
	// Below the last visible row (6 rows are rendered at y 0..5).
	await t.mockMouse.click(2, 8);
	await t.flush();
	expect(counters.selected).toEqual([]);
	expect(counters.activated).toEqual([]);
	t.renderer.destroy();
});

test("a drag across rows never selects or activates", async () => {
	const counters = newCounters();
	const t = await testRender(() => <ProbeList counters={counters} />, {
		width: 40,
		height: 10,
	});
	await t.flush();
	await t.mockMouse.drag(2, 1, 2, 4);
	await t.flush();
	expect(counters.selected).toEqual([]);
	expect(counters.activated).toEqual([]);
	t.renderer.destroy();
});

test("the wheel moves the cursor of the list under the pointer only", async () => {
	const upper = newCounters();
	const lower = newCounters();
	const t = await testRender(
		() => (
			<box flexDirection="column" width="100%" height="100%">
				<box height={3} flexShrink={0}>
					<ProbeList counters={upper} />
				</box>
				<box height={3} flexShrink={0}>
					<ProbeList counters={lower} />
				</box>
			</box>
		),
		{ width: 40, height: 10 },
	);
	await t.flush();
	await t.mockMouse.scroll(2, 4, "down");
	await t.flush();
	expect(lower.selected).toEqual([1]);
	expect(upper.selected).toEqual([]);
	t.renderer.destroy();
});

test("a hidden region takes no tap", async () => {
	const counters = newCounters();
	const t = await testRender(
		() => (
			<box width="100%" height="100%">
				<box visible={false} width="100%" height={6}>
					<ProbeList counters={counters} />
				</box>
			</box>
		),
		{ width: 40, height: 10 },
	);
	await t.flush();
	await t.mockMouse.click(2, 2);
	await t.flush();
	expect(counters.selected).toEqual([]);
	t.renderer.destroy();
});

test("tapping a panel requests focus for it, and a hidden panel never does", async () => {
	const visible = { focus: () => {} };
	const hidden = { focus: () => {} };
	const visibleFocus = spyOn(visible, "focus");
	const hiddenFocus = spyOn(hidden, "focus");
	const t = await testRender(
		() => (
			<box flexDirection="column" width="100%" height="100%">
				<Panel
					title="Change"
					style={{ width: "100%", height: 4, flexShrink: 0 }}
					onFocusRequest={visible.focus}
				>
					<text>body</text>
				</Panel>
				<box visible={false} height={4}>
					<Panel title="Hidden" onFocusRequest={hidden.focus}>
						<text>hidden body</text>
					</Panel>
				</box>
			</box>
		),
		{ width: 40, height: 10 },
	);
	await t.flush();
	await t.mockMouse.click(2, 2);
	await t.flush();
	expect(visibleFocus).toHaveBeenCalledTimes(1);
	await t.mockMouse.drag(2, 2, 4, 4);
	await t.flush();
	expect(visibleFocus).toHaveBeenCalledTimes(1);
	expect(hiddenFocus).not.toHaveBeenCalled();
	t.renderer.destroy();
});

test("a backdrop tap dismisses a read-only dialog and never a guarded one", async () => {
	const readOnly = { close: () => {} };
	const guarded = { close: () => {} };
	const withDraft = { close: () => {} };
	const readOnlyClose = spyOn(readOnly, "close");
	const guardedClose = spyOn(guarded, "close");
	const draftClose = spyOn(withDraft, "close");
	const t = await testRender(
		() => (
			<>
				<GenericModal
					title="Read-only"
					dismissKind="help"
					onBackdropClick={readOnly.close}
					help={[{ key: "Esc", action: "Close" }]}
				>
					<text>read-only body</text>
				</GenericModal>
			</>
		),
		{ width: 40, height: 10 },
	);
	await t.flush();
	await t.mockMouse.click(1, 1);
	await t.flush();
	expect(readOnlyClose).toHaveBeenCalledTimes(1);
	// A tap inside the dialog never reaches the backdrop.
	await t.mockMouse.click(20, 5);
	await t.flush();
	expect(readOnlyClose).toHaveBeenCalledTimes(1);
	t.renderer.destroy();

	const guardedRender = await testRender(
		() => (
			<GenericModal
				title="Wizard"
				dismissKind="new-workflow"
				onBackdropClick={guarded.close}
				help={[{ key: "Esc", action: "Back" }]}
			>
				<text>wizard body</text>
			</GenericModal>
		),
		{ width: 40, height: 10 },
	);
	await guardedRender.flush();
	await guardedRender.mockMouse.click(1, 1);
	await guardedRender.flush();
	expect(guardedClose).not.toHaveBeenCalled();
	guardedRender.renderer.destroy();

	const draftRender = await testRender(
		() => (
			<GenericModal
				title="Forms"
				dismissKind="help"
				dismissBlocked
				onBackdropClick={withDraft.close}
			>
				<text>draft body</text>
			</GenericModal>
		),
		{ width: 40, height: 10 },
	);
	await draftRender.flush();
	await draftRender.mockMouse.click(1, 1);
	await draftRender.flush();
	expect(draftClose).not.toHaveBeenCalled();
	draftRender.renderer.destroy();
});

test("a backdrop tap runs the dialogue's Escape, never its confirmation", async () => {
	const confirmed = { run: () => {} };
	const dismissed = { run: () => {} };
	const confirm = spyOn(confirmed, "run");
	const dismiss = spyOn(dismissed, "run");
	const Prop = () => {
		// The shipped wiring: the backdrop binding dispatches the dialog's own
		// `Esc`, and activation stays on the row (`Enter`).
		const backdrop = useModalBackdrop({ kind: "plan-rejection" });
		return (
			<ListViewModal
				{...backdrop}
				title="Reject plan"
				items={["reason one", "reason two"]}
				selectedIndex={0}
				onSelect={() => {}}
				onActivate={() => confirmed.run()}
				renderItem={(item) => <text>{item}</text>}
			/>
		);
	};
	const t = await testRender(() => <Prop />, { width: 60, height: 16 });
	const { createDefaultOpenTuiKeymap } = await import(
		"@opentui/keymap/opentui"
	);
	const keymap = createDefaultOpenTuiKeymap(t.renderer);
	keymap.registerLayer({
		name: "probe",
		commands: [
			{
				name: "probe.escape",
				context: "global",
				run: () => {
					dismissed.run();
					return true;
				},
			},
		],
		bindings: [{ key: "escape", cmd: "probe.escape" }],
	});
	await t.flush();
	// A stray click on the dimmed backdrop cancels: it must never reject a plan.
	await t.mockMouse.click(1, 1);
	await t.flush();
	expect(confirm.mock.calls.length).toBe(0);
	expect(dismiss.mock.calls.length).toBe(1);
	t.renderer.destroy();
});

test("a backdrop tap on the shipped overlays runs the dialogue's Escape, never Enter", async () => {
	// Mount the real `Overlays` with only the plan-rejection picker open: the
	// wiring under test is the one the dashboard ships, not a copy of it.
	const confirmed = { run: () => {} };
	const dismissed = { run: () => {} };
	const confirm = spyOn(confirmed, "run");
	const dismiss = spyOn(dismissed, "run");
	const state = {
		repairSelection: () => 0,
		completedSelection: () => 0,
		actionReason: () => "",
		userActionSelection: () => 0,
		helpOffset: () => 0,
		workflowGraphOffset: () => 0,
		themeIndex: () => 0,
		themeQuery: () => "",
		themeFiltering: () => false,
		selectedFinding: () => 0,
		costSelection: () => 0,
		costAgent: () => null,
		costOffset: () => 0,
		debugRequestsSelection: () => 0,
		debugRequestsOffset: () => 0,
		presetSwitcherChoices: () => [],
		presetSwitcherHandler: () => undefined,
		verdictOffset: () => 0,
		verdictRenderMarkdown: () => false,
		setRepairSelection: () => {},
		setCompletedSelection: () => {},
		setUserActionSelection: () => {},
		setSelectedFinding: () => {},
		setCostSelection: () => {},
		setDebugRequestsSelection: () => {},
		setDebugRequestsOffset: () => {},
	} as unknown as OverlaysState;
	const t = await testRender(
		() => (
			<Overlays
				state={state}
				helpLines={0}
				planRejection={{
					reasons: ["reason one", "reason two"],
					selected: 0,
					onSelectIndex: () => {},
				}}
			/>
		),
		{ width: 70, height: 18 },
	);
	const { createDefaultOpenTuiKeymap } = await import(
		"@opentui/keymap/opentui"
	);
	const keymap = createDefaultOpenTuiKeymap(t.renderer);
	keymap.registerLayer({
		name: "probe",
		commands: [
			{
				name: "probe.reject",
				context: "global",
				run: () => {
					confirmed.run();
					return true;
				},
			},
			{
				name: "probe.cancel",
				context: "global",
				run: () => {
					dismissed.run();
					return true;
				},
			},
		],
		bindings: [
			{ key: "enter", cmd: "probe.reject" },
			{ key: "return", cmd: "probe.reject" },
			{ key: "escape", cmd: "probe.cancel" },
		],
	});
	await t.flush();
	// A stray click outside the dialog cancels it: it must never reject a plan.
	await t.mockMouse.click(1, 1);
	await t.flush();
	expect(confirm.mock.calls.length).toBe(0);
	expect(dismiss.mock.calls.length).toBe(1);
	t.renderer.destroy();
});

test("an unnamed dialog kind leaves the backdrop inert", async () => {
	const closed = { run: () => {} };
	const close = spyOn(closed, "run");
	const t = await testRender(
		() => (
			<GenericModal
				title="Unnamed"
				onBackdropClick={() => closed.run()}
				help={[{ key: "Esc", action: "Close" }]}
			>
				<text>body</text>
			</GenericModal>
		),
		{ width: 40, height: 10 },
	);
	await t.flush();
	await t.mockMouse.click(1, 1);
	await t.flush();
	expect(close.mock.calls.length).toBe(0);
	t.renderer.destroy();
});

test("a footer chip runs its key, and a composite chip stays inert", async () => {
	const opened = { open: () => {} };
	const open = spyOn(opened, "open");
	// The chip dispatches the key through the renderer, so a keymap must be
	// installed exactly as the application installs it.
	const { createDefaultOpenTuiKeymap } = await import(
		"@opentui/keymap/opentui"
	);
	const t = await testRender(
		() => (
			<box width="100%" height="100%">
				<StatusBar
					keybinds={[
						{ key: "Enter", action: "Open" },
						{ key: "j/k", action: "Move" },
					]}
				/>
			</box>
		),
		{ width: 60, height: 6 },
	);
	const keymap = createDefaultOpenTuiKeymap(t.renderer);
	keymap.registerLayer({
		name: "probe",
		commands: [
			{
				name: "probe.open",
				context: "global",
				run: () => {
					opened.open();
					return true;
				},
			},
		],
		bindings: [
			{ key: "enter", cmd: "probe.open" },
			{ key: "return", cmd: "probe.open" },
		],
	});
	await t.flush();
	// The footer renders `Enter Open • j/k Move` with `? help` pinned right;
	// the first chip is the Enter one (`Enter Open` occupies x 1..10).
	await t.mockMouse.click(3, 0);
	await t.flush();
	const afterEnterChip = open.mock.calls.length;
	expect(afterEnterChip).toBe(1);
	// The composite chip (`j/k`) is not a stroke: tapping it does nothing.
	await t.mockMouse.click(18, 0);
	await t.flush();
	expect(open.mock.calls.length).toBe(afterEnterChip);
	// A right click and a drag ending on the chip are not taps.
	await t.mockMouse.click(3, 0, 2);
	await t.mockMouse.drag(3, 0, 5, 0);
	await t.flush();
	expect(open.mock.calls.length).toBe(afterEnterChip);
	// Keyboard/pointer parity: the key the chip advertises reaches the same
	// command, so the chip adds a path without adding a behaviour.
	t.mockInput.pressEnter();
	await t.flush();
	expect(open.mock.calls.length).toBe(afterEnterChip + 1);
	t.renderer.destroy();
});

test("a list that cannot act lets the wheel reach the scroll box around it", async () => {
	let box: import("@opentui/core").ScrollBoxRenderable | undefined;
	const items = Array.from({ length: 40 }, (_, index) => `row ${index}`);
	const t = await testRender(
		() => (
			<box width="100%" height="100%" flexDirection="column">
				<ScrollableContent
					style={{ height: 4 }}
					onScrollBoxReady={(ready) => {
						box = ready;
					}}
				>
					{/* Neither onSelect nor onScroll: the list has nothing to do, so it
					    must not swallow the event (test-quality TQ-201). */}
					<ScrollableList
						items={items}
						selectedIndex={0}
						availableLines={40}
						showScrollIndicator={false}
						estimatedItemHeight={1}
						renderItem={(item) => (
							<box height={1}>
								<text>{item}</text>
							</box>
						)}
					/>
				</ScrollableContent>
			</box>
		),
		{ width: 60, height: 10 },
	);
	await t.flush();
	expect(box).toBeDefined();
	expect(box?.scrollTop ?? 0).toBe(0);
	// The scroll box ramps its acceleration, so a gesture is a few notches.
	for (let notch = 0; notch < 4; notch += 1)
		await t.mockMouse.scroll(2, 1, "down");
	await t.flush();
	expect(box?.scrollTop ?? 0).toBeGreaterThan(0);
	t.renderer.destroy();
});

test("a list whose selection triggers I/O leaves the wheel alone", async () => {
	const counters = newCounters();
	const [selected, setSelected] = createSignal(0);
	const items = Array.from({ length: 8 }, (_, index) => `row ${index}`);
	const t = await testRender(
		() => (
			<ScrollableList
				items={items}
				selectedIndex={selected()}
				availableLines={6}
				showScrollIndicator={false}
				estimatedItemHeight={1}
				wheelMovesCursor={false}
				onSelect={(index) => {
					counters.selected.push(index);
					setSelected(index);
				}}
				renderItem={(item) => (
					<box height={1}>
						<text>{item}</text>
					</box>
				)}
			/>
		),
		{ width: 40, height: 10 },
	);
	await t.flush();
	await t.mockMouse.scroll(2, 2, "down");
	await t.flush();
	// No read-triggering selection move, and no cursor change either.
	expect(counters.selected).toEqual([]);
	expect(selected()).toBe(0);
	t.renderer.destroy();
});

test("a release that lands on another row after a window move is not a tap", async () => {
	const counters = newCounters();
	const [selected, setSelected] = createSignal(15);
	const items = Array.from({ length: 20 }, (_, index) => `row ${index}`);
	const t = await testRender(
		() => (
			<ScrollableList
				items={items}
				selectedIndex={selected()}
				availableLines={4}
				showScrollIndicator={false}
				estimatedItemHeight={1}
				onSelect={(index) => counters.selected.push(index)}
				onActivate={(index) => counters.activated.push(index)}
				renderItem={(item) => (
					<box height={1}>
						<text>{item}</text>
					</box>
				)}
			/>
		),
		{ width: 40, height: 10 },
	);
	await t.flush();
	// Press the last painted row of the window that holds index 15.
	await t.mockMouse.pressDown(2, 3);
	// The window recomputes (the keyboard moved the cursor): the same cell now
	// belongs to a recreated row, whose index must not inherit the press.
	setSelected(0);
	await t.flush();
	await t.mockMouse.release(2, 3);
	await t.flush();
	expect(counters.selected).toEqual([]);
	expect(counters.activated).toEqual([]);
	t.renderer.destroy();
});

test("a control nested in a region consumes its tap", async () => {
	const calls: string[] = [];
	const t = await testRender(
		() => {
			const region = useTap(() => calls.push("region"));
			const glyph = useTap(() => calls.push("glyph"), {
				stopPropagation: true,
			});
			return (
				<box {...region} style={{ width: "100%", height: 4 }}>
					<box {...glyph} style={{ width: 10, height: 1 }}>
						<text>glyph</text>
					</box>
					<text>body</text>
				</box>
			);
		},
		{ width: 40, height: 10 },
	);
	await t.flush();
	await t.mockMouse.click(1, 0);
	await t.flush();
	// One gesture, one action: the glyph acted and the region did not.
	expect(calls).toEqual(["glyph"]);
	await t.mockMouse.click(1, 2);
	await t.flush();
	expect(calls).toEqual(["glyph", "region"]);
	t.renderer.destroy();
});

test("a chip dispatching Space carries the sequence a real keypress carries", async () => {
	const toggled: string[] = [];
	const t = await testRender(
		() => (
			<box width="100%" height="100%">
				<StatusBar keybinds={[{ key: "Space", action: "Toggle" }]} />
			</box>
		),
		{ width: 60, height: 6 },
	);
	const { createDefaultOpenTuiKeymap } = await import(
		"@opentui/keymap/opentui"
	);
	const keymap = createDefaultOpenTuiKeymap(t.renderer);
	keymap.registerLayer({
		name: "probe",
		commands: [
			{
				name: "probe.toggle",
				context: "global",
				run: ({ event }) => {
					// The environment layer's own predicate.
					if (event.sequence !== " ") return false;
					toggled.push("space");
					return true;
				},
			},
		],
		bindings: [{ key: "space", cmd: "probe.toggle" }],
	});
	await t.flush();
	await t.mockMouse.click(3, 0);
	await t.flush();
	expect(toggled).toEqual(["space"]);
	// The real key still works the same way.
	t.mockInput.pressKey(" ");
	await t.flush();
	expect(toggled).toEqual(["space", "space"]);
	t.renderer.destroy();
});
