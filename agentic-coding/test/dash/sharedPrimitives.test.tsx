/** @jsxImportSource @opentui/solid */
import { expect, spyOn, test } from "bun:test";
import { testRender } from "@opentui/solid";
import { createSignal } from "solid-js";
import { GenericModal as DevenvGenericModal } from "../../src/tui/dash/devenv-ui/components/GenericModal";
import { ScrollableContent as DevenvScrollableContent } from "../../src/tui/dash/devenv-ui/components/ScrollableContent";
import { setGlobalSelectionMouseUpHandler } from "../../src/tui/dash/selectionCopy";
import { GenericModal as DashGenericModal } from "../../src/tui/dash/ui/GenericModal";
import { ScrollableContent as DashScrollableContent } from "../../src/tui/dash/ui/ScrollableContent";
import { SelectableList as DashSelectableList } from "../../src/tui/dash/ui/Selectable";
import { ScrollableContent as OtelScrollableContent } from "../../src/tui/otel/components/ScrollableContent";
import { SelectableList as OtelSelectableList } from "../../src/tui/otel/components/Selectable";

// Renderer characterizations for the consolidated tui-shared-primitives:
// every family entry point delegates to the shared implementations under
// src/tui/shared, and each family's legacy rendering contract holds.

test("dashboard GenericModal renders through the shared modal shell", async () => {
	const t = await testRender(
		() => (
			<DashGenericModal
				title="Dashboard dialog"
				widthPercent={0.7}
				heightPercent={0.55}
				help={[
					{ key: "j/k", action: "Scroll" },
					{ key: "Esc", action: "Close" },
				]}
			>
				<text>dashboard body</text>
			</DashGenericModal>
		),
		{ width: 80, height: 24 },
	);
	await t.flush();
	const frame = t.captureCharFrame();
	expect(frame).toContain("Dashboard dialog");
	expect(frame).toContain("dashboard body");
	expect(frame).toContain("j/k Scroll");
	expect(frame).toContain("Esc Close");
	t.renderer.destroy();
});

test("devenv GenericModal renders through the shared modal shell", async () => {
	const t = await testRender(
		() => (
			<DevenvGenericModal
				title="Devenv dialog"
				widthPercent={0.7}
				heightPercent={0.55}
				helpText="j/k Scroll  •  Esc Close"
			>
				<text>devenv body</text>
			</DevenvGenericModal>
		),
		{ width: 80, height: 24 },
	);
	await t.flush();
	const frame = t.captureCharFrame();
	expect(frame).toContain("Devenv dialog");
	expect(frame).toContain("devenv body");
	expect(frame).toContain("j/k Scroll");
	expect(frame).toContain("Esc Close");
	t.renderer.destroy();
});

test("shared modal keeps content reachable on a narrow terminal", async () => {
	const t = await testRender(
		() => (
			<DashGenericModal
				title="Narrow"
				widthPercent={0.9}
				heightLines={3}
				help={[]}
			>
				<text>tiny content line</text>
			</DashGenericModal>
		),
		{ width: 40, height: 10 },
	);
	await t.flush();
	const frame = t.captureCharFrame();
	expect(frame).toContain("Narrow");
	expect(frame).toContain("tiny content line");
	t.renderer.destroy();
});

test("both family ScrollableContent entry points delegate to the shared scrollbox", async () => {
	const t = await testRender(
		() => (
			<box flexDirection="column" width={40} height={10}>
				<DashScrollableContent>
					<text>dash scroll child</text>
				</DashScrollableContent>
				<DevenvScrollableContent axes={["x", "y"]} keyboardAxes={["x"]}>
					<text>devenv scroll child</text>
				</DevenvScrollableContent>
				<OtelScrollableContent>
					<text>otel scroll child</text>
				</OtelScrollableContent>
			</box>
		),
		{ width: 40, height: 10 },
	);
	await t.flush();
	const frame = t.captureCharFrame();
	expect(frame).toContain("dash scroll child");
	expect(frame).toContain("devenv scroll child");
	expect(frame).toContain("otel scroll child");
	t.renderer.destroy();
});

test("SelectableList keeps the selection in view for plain-value and accessor consumers", async () => {
	const [dashSelected, setDashSelected] = createSignal(0);
	const [otelSelected, setOtelSelected] = createSignal(0);
	const items = Array.from({ length: 40 }, (_, i) => `Item ${i}`);
	const t = await testRender(
		() => (
			<box flexDirection="column" width={40} height={8}>
				<DashSelectableList
					items={items}
					selectedIndex={dashSelected()}
					renderItem={(item, active) => (
						<text fg={active ? "red" : undefined}>
							d {active ? ">" : " "} {item}
						</text>
					)}
					itemHeight={1}
				/>
				<box height={1} />
				<OtelSelectableList
					items={items}
					selectedIndex={otelSelected}
					renderItem={(item, active) => (
						<text fg={active ? "red" : undefined}>
							o {active ? ">" : " "} {item}
						</text>
					)}
					itemHeight={1}
				/>
			</box>
		),
		{ width: 40, height: 12 },
	);
	await t.flush();
	expect(t.captureCharFrame()).toContain("d > Item 0");
	expect(t.captureCharFrame()).toContain("o > Item 0");

	setDashSelected(39);
	setOtelSelected(39);
	const frame = await t.waitForFrame((f) => f.includes("d > Item 39"));
	expect(frame).toContain("d > Item 39");
	expect(frame).toContain("o > Item 39");
	t.renderer.destroy();
});

test("shared modal instances are independent: disposing one leaves the other mounted and remounting works", async () => {
	const [showFirst, setShowFirst] = createSignal(true);
	const t = await testRender(
		() => (
			<>
				{showFirst() && (
					<DashGenericModal
						title="First modal"
						help={[]}
						step={1}
						total={3}
						zIndex={1}
					>
						<text>first body</text>
					</DashGenericModal>
				)}
				<DashGenericModal title="Second modal" help={[]}>
					<text>second body</text>
				</DashGenericModal>
			</>
		),
		{ width: 80, height: 24 },
	);
	await t.flush();
	// The z-ordered instance paints above; the second stays mounted below it.
	expect(t.captureCharFrame()).toContain("First modal");

	// Disposing the first instance must not tear down or corrupt the second.
	setShowFirst(false);
	await t.waitForFrame((frame) => !frame.includes("First modal"));
	expect(t.captureCharFrame()).toContain("Second modal");

	// Remounting starts a fresh, instance-local instance again.
	setShowFirst(true);
	await t.waitForFrame((frame) => frame.includes("First modal"));
	expect(t.captureCharFrame()).toContain("first body");
	t.renderer.destroy();
});

test("selection copy registry is shared: a devenv modal dialog click invokes the global handler", async () => {
	const marker = { copy: () => {} };
	const copyHandler = spyOn(marker, "copy");
	const backdrop = { close: () => {} };
	const onBackdropClick = spyOn(backdrop, "close");
	const clear = setGlobalSelectionMouseUpHandler(marker.copy);
	try {
		const t = await testRender(
			() => (
				<DevenvGenericModal
					title="Copy probe"
					widthPercent={0.5}
					heightPercent={0.4}
					helpText=""
					onBackdropClick={onBackdropClick}
				>
					<text>dialog body</text>
				</DevenvGenericModal>
			),
			{ width: 80, height: 24 },
		);
		await t.flush();
		// Dialog spans x 20..60, y 7..17 (80x24, 0.5x0.4 → 40x9 centered).
		await t.mockMouse.click(40, 13);
		await t.flush();
		expect(copyHandler).toHaveBeenCalled();
		// The devenv path stops dialog clicks from reaching the backdrop close.
		expect(onBackdropClick).not.toHaveBeenCalled();
		// Backdrop click (outside the dialog) still closes.
		await t.mockMouse.click(5, 13);
		await t.flush();
		expect(onBackdropClick).toHaveBeenCalled();
		t.renderer.destroy();
	} finally {
		clear();
	}
});

test("legacy dash search renders the display-only header without a live cursor", async () => {
	const t = await testRender(
		() => (
			<DashGenericModal
				title="Filter"
				widthPercent={0.7}
				heightPercent={0.5}
				help={[]}
				search="open"
			>
				<text>filter body</text>
			</DashGenericModal>
		),
		{ width: 80, height: 24 },
	);
	await t.flush();
	const frame = t.captureCharFrame();
	expect(frame).toContain("/open");
	expect(frame).not.toContain("█");
	t.renderer.destroy();
});

test("explicit searchMode still renders the live input cursor", async () => {
	const t = await testRender(
		() => (
			<DevenvGenericModal
				title="Filter"
				widthPercent={0.7}
				heightPercent={0.5}
				helpText=""
				searchMode
				searchQuery="open"
			>
				<text>filter body</text>
			</DevenvGenericModal>
		),
		{ width: 80, height: 24 },
	);
	await t.flush();
	const frame = t.captureCharFrame();
	expect(frame).toContain("/open");
	expect(frame).toContain("█");
	t.renderer.destroy();
});

test("summary modals keep content and the summary table reachable on a narrow terminal", async () => {
	const t = await testRender(
		() => (
			<DashGenericModal
				title="Narrow summary"
				widthPercent={0.9}
				heightPercent={0.6}
				help={[]}
				summary={[
					{ label: "Agent", value: "planner" },
					{ label: "Mode", value: "apply" },
				]}
			>
				<text>content column stays visible</text>
			</DashGenericModal>
		),
		{ width: 50, height: 16 },
	);
	await t.flush();
	const frame = t.captureCharFrame();
	// Side-by-side is impossible at this width; the table stacks below the
	// content instead of clipping, so both remain accessible.
	expect(frame).toContain("content column stays visible");
	expect(frame).toContain("Selections");
	expect(frame).toContain("Agent");
	expect(frame).toContain("planner");
	expect(frame).toContain("Mode");
	expect(frame).toContain("apply");
	t.renderer.destroy();
});
