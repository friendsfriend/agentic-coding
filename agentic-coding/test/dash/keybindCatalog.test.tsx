/** @jsxImportSource @opentui/solid */
import { describe, expect, it, test } from "bun:test";
import { testRender } from "@opentui/solid";
import {
	catalogKeybinds,
	footerKeybinds,
	HelpModal,
	helpModalRowCount,
	helpModalRows,
	setActiveKeybindCatalog,
	specialKeybinds,
	wrapHelpEntries,
} from "@ui";
import { createSignal } from "solid-js";
import {
	agentSessionKeybindCatalog,
	dashboardDetailKeybindCatalog,
	evidenceSubviewKeybindCatalog,
	panelContext,
	workflowLaunchKeybindCatalog,
} from "../../src/tui/dash/keybinds.ts";
import { EVIDENCE_PANEL } from "../../src/tui/dash/panel-grid.ts";

describe("keybind catalog contract", () => {
	it("hides standard keys from footers but keeps them in the catalog", () => {
		const catalog = dashboardDetailKeybindCatalog({ artifactsVisible: true });
		const all = catalogKeybinds(catalog);
		expect(all.some((keybind) => keybind.standard)).toBe(true);

		const footer = footerKeybinds(catalog, "change");
		expect(footer.some((keybind) => keybind.standard)).toBe(false);
		expect(footer.map((keybind) => keybind.action)).not.toContain(
			"Scroll focused panel",
		);
		expect(all.map((keybind) => keybind.action)).toContain(
			"Scroll focused panel",
		);
	});

	it("keeps the workspace cycle in the detail catalog's global keys", () => {
		const catalog = dashboardDetailKeybindCatalog({ artifactsVisible: false });
		const cycle = catalogKeybinds(catalog).filter(
			(keybind) => keybind.key === "Ctrl+H" || keybind.key === "Ctrl+L",
		);
		expect(cycle.map((keybind) => keybind.action)).toEqual([
			"previous workspace",
			"next workspace",
		]);
		// A dashboard is one of the entries the cycle walks, so the keys are live
		// here; they are navigation, hence `?` help and not the footer.
		expect(cycle.every((keybind) => keybind.standard === true)).toBe(true);
		expect(
			footerKeybinds(catalog, "change").map((keybind) => keybind.key),
		).not.toContain("Ctrl+L");
	});

	it("scopes panel-specific footer keybinds to the focused panel", () => {
		const catalog = dashboardDetailKeybindCatalog({ artifactsVisible: true });
		const change = footerKeybinds(catalog, "change").map((kb) => kb.action);
		const openspec = footerKeybinds(catalog, "openspec").map((kb) => kb.action);
		const agents = footerKeybinds(catalog, "agents").map((kb) => kb.action);

		expect(change).toContain("Approve gate / review changed files");
		expect(change).not.toContain("Open selected artifact");
		expect(openspec).toContain("Open selected artifact");
		expect(openspec).not.toContain(
			"Focus selected agent / open durable agent session",
		);
		expect(agents).toContain(
			"Focus selected agent / open durable agent session",
		);
		expect(agents).toContain("View selected verifier result");
		expect(agents).not.toContain("Approve gate / review changed files");
	});

	it("scopes the Evidence panel's actions to the evidence context", () => {
		// The panel is always rendered (empty state included), so the way into the
		// evidence view is always in the catalog and always context-scoped. The
		// listing's own actions belong to the view's catalog, not the grid's.
		const catalog = dashboardDetailKeybindCatalog({ artifactsVisible: false });
		expect(catalogKeybinds(catalog).map((keybind) => keybind.action)).toContain(
			"Open the evidence view",
		);
		const evidence = footerKeybinds(catalog, "evidence").map(
			(keybind) => keybind.action,
		);
		expect(evidence).toContain("Open the evidence view");
		// The listing's own actions are the view's, so the grid advertises neither.
		expect(evidence).not.toContain("Copy selected evidence path");
		expect(evidence).not.toContain("Open stage flow page");
		expect(
			footerKeybinds(catalog, "change").map((keybind) => keybind.action),
		).not.toContain("Open the evidence view");
		// The view publishes its own surface while it replaces the grid.
		const view = evidenceSubviewKeybindCatalog({ flow: true });
		expect(view.map((section) => section.title)).toEqual(["Evidence view"]);
		expect(footerKeybinds(view).map((keybind) => keybind.short)).toEqual([
			"agents",
			"back",
			"open",
			"copy",
			"scroll",
			"flow",
		]);
		expect(catalogKeybinds(view).map((keybind) => keybind.action)).toContain(
			"Move in the evidence list",
		);
	});

	it("publishes the session's keys while the agent page replaces the grid", () => {
		const catalog = agentSessionKeybindCatalog();
		const all = catalogKeybinds(catalog);
		expect(catalog.map((section) => section.title)).toEqual(["Agent session"]);
		// The footer keeps the special keys and hides pure navigation, while
		// `?` help still documents the prompt's standard keys.
		expect(footerKeybinds(catalog).map((keybind) => keybind.short)).toEqual([
			"agents",
			"back",
			"send",
			"scroll",
		]);
		expect(all.map((keybind) => keybind.action)).toContain(
			"Choose command or browse history (prompt edges)",
		);
		expect(all.map((keybind) => keybind.action)).toContain(
			"New line in the prompt",
		);
		// No panel context: the grid's keybindings are not advertised here.
		expect(
			all.some(
				(keybind) =>
					keybind.context !== undefined &&
					keybind.action === "Move between panels",
			),
		).toBe(false);
	});

	it("publishes global agent focus in both the footer and help on subpages", () => {
		for (const catalog of [
			evidenceSubviewKeybindCatalog({ flow: true }),
			agentSessionKeybindCatalog(),
		]) {
			const globalKey = catalogKeybinds(catalog).find(
				(keybind) => keybind.key === "Ctrl+A",
			);
			if (!globalKey) throw new Error("global Ctrl+A key missing from catalog");
			expect(globalKey.short).toBe("agents");
			expect(globalKey.action).toContain("agent");
			expect(footerKeybinds(catalog)).toContainEqual(globalKey);
			expect(JSON.stringify(helpModalRows(catalog))).toContain("Ctrl+A");
		}
	});

	it("maps every detail grid panel to a footer context", () => {
		expect(panelContext(0)).toBe("change");
		expect(panelContext(1)).toBe("agents");
		expect(panelContext(6)).toBe("openspec");
		expect(panelContext(7)).toBe("classifier");
		expect(panelContext(EVIDENCE_PANEL)).toBe("evidence");
	});

	it("always scopes the Classifications section to its panel", () => {
		// The panel is always rendered (empty state included), so its keybind is
		// always in the catalog and always context-scoped.
		const catalog = dashboardDetailKeybindCatalog({ artifactsVisible: false });
		expect(catalogKeybinds(catalog).map((keybind) => keybind.action)).toContain(
			"View selected classification",
		);
		expect(
			footerKeybinds(catalog, "classifier").map((keybind) => keybind.action),
		).toContain("View selected classification");
		expect(
			footerKeybinds(catalog, "change").map((keybind) => keybind.action),
		).not.toContain("View selected classification");
	});

	it("omits the OpenSpec section while no artifacts are listed", () => {
		const catalog = dashboardDetailKeybindCatalog({ artifactsVisible: false });
		expect(
			catalogKeybinds(catalog).some(
				(keybind) => keybind.action === "Open selected artifact",
			),
		).toBe(false);
	});

	it("the contextual creation footer names the form's own actions", () => {
		const footer = footerKeybinds(workflowLaunchKeybindCatalog());
		const actions = footer.map((keybind) => keybind.action);
		expect(actions).toContain("Select / create");
		expect(actions).toContain("Filter list");
		// No workflow-browser actions survive anywhere in the catalog.
		expect(actions).not.toContain("New workflow");
		expect(actions).not.toContain("Switch active workspace");
	});

	it("specialKeybinds never mutates its input", () => {
		const entries = [
			{ key: "j/k", action: "nav", standard: true },
			{ key: "r", action: "refresh" },
		];
		expect(specialKeybinds(entries)).toHaveLength(1);
		expect(entries).toHaveLength(2);
	});

	it("wraps footer entries without splitting a key from its action", () => {
		const entries = [
			{ key: "j/k", action: "scroll panel" },
			{ key: "Shift+O", action: "repair guidance" },
			{ key: "?", action: "help" },
		];
		const lines = wrapHelpEntries(entries, 24);
		expect(lines.length).toBeGreaterThan(1);
		expect(lines.flat()).toEqual(entries);
		for (const line of lines)
			expect(
				line.map((kb) => `${kb.key} ${kb.action}`).join(" • ").length,
			).toBeLessThanOrEqual(24);
	});

	it("measures footer wrapping by the compact label, not the long action", () => {
		const entries = [
			{ key: "f", action: "Open filter modal", short: "filter" },
			{ key: "o", action: "Open sort modal", short: "sort" },
		];
		// Long actions would need 41 columns; the short labels fit in 19.
		const lines = wrapHelpEntries(entries, 20);
		expect(lines).toHaveLength(1);
		expect(lines[0].map((kb) => `${kb.key} ${kb.short}`).join(" • ")).toBe(
			"f filter • o sort",
		);
	});
});

test("help modal lists every keybind from the active catalog", async () => {
	const catalog = dashboardDetailKeybindCatalog({ artifactsVisible: true });
	setActiveKeybindCatalog(catalog, "change");
	const t = await testRender(
		() => <HelpModal title="Dashboard keybindings" offset={0} lines={30} />,
		{ width: 90, height: 34 },
	);
	await t.flush();
	const frame = t.captureCharFrame();
	expect(frame).toContain("Dashboard keybindings");
	expect(frame).toContain("Move between panels");
	expect(frame).toContain("Scroll focused panel");
	expect(frame).toContain("Open selected artifact");
	expect(frame).toContain("View selected verifier result");
	expect(frame).toContain("View selected classification");
	t.renderer.destroy();
});

test("the `?` help lists the evidence view's own catalog while the view is open", async () => {
	// The view replaces the grid, so it publishes its catalog like the agent
	// session does: the `?` modal then lists the sidebar actions, the report scroll
	// (standard keys included) and, with a journal, the open-flow action.
	setActiveKeybindCatalog(
		evidenceSubviewKeybindCatalog({ flow: true }),
		undefined,
	);
	const t = await testRender(
		() => <HelpModal title="Dashboard keybindings" offset={0} lines={40} />,
		{ width: 100, height: 40 },
	);
	await t.flush();
	const frame = t.captureCharFrame();
	expect(frame).toContain("Evidence view");
	expect(frame).toContain("Back to the dashboard panels");
	expect(frame).toContain("Open selected evidence");
	expect(frame).toContain("Copy selected evidence path");
	expect(frame).toContain("Scroll the report");
	expect(frame).toContain("Open stage flow page");
	// The grid's panel actions are not part of the page's catalog.
	expect(frame).not.toContain("Open the evidence view");
	expect(frame).not.toContain("Move between panels");
	t.renderer.destroy();
});

test("help modal rows keep their line instead of overlapping when they overflow", async () => {
	const t = await testRender(
		() => (
			<HelpModal
				title="Keybindings"
				offset={0}
				lines={40}
				sections={[
					{
						title: "Navigation",
						keybinds: [
							{ key: "j/k", action: "select" },
							{ key: "Enter", action: "open" },
						],
					},
					{
						title: "Actions",
						keybinds: [
							{ key: "f", action: "filter" },
							{ key: "r", action: "refresh" },
						],
					},
				]}
			/>
		),
		// A 10-row terminal leaves a 3-row modal body, so a 6-row catalog must
		// overflow. Shrinking rows compress onto each other (e.g. the title and
		// "open" merge into "Actions openct") instead of being clipped, so the
		// rows that do fit must stay intact and one per line.
		{ width: 90, height: 10 },
	);
	await t.flush();
	const frame = t.captureCharFrame();
	// The last row that fits owns its line with key and action intact; the
	// rows below it are clipped, not smeared over the visible ones.
	expect(frame).toMatch(/Enter\s+open/);
	expect(frame).toContain("Navigation");
	expect(frame).not.toContain("Actions");
	t.renderer.destroy();
});

describe("artifact help section naming", () => {
	it("names the artifact help section after the workflow's family", () => {
		const debug = dashboardDetailKeybindCatalog({
			artifactsVisible: true,
			definitionId: "debug",
		});
		expect(debug.map((section) => section.title)).toContain(
			"Debug report panel",
		);
		const openspec = dashboardDetailKeybindCatalog({
			artifactsVisible: true,
			definitionId: "openspec",
		});
		expect(openspec.map((section) => section.title)).toContain(
			"OpenSpec panel",
		);
	});
});

test("the help row contract counts what the modal paints, Mouse section last", () => {
	const sections = [
		{ title: "Navigation", keybinds: [{ key: "j/k", action: "select" }] },
		{
			title: "Actions",
			keybinds: [
				{ key: "Enter", action: "open" },
				{ key: "Esc", action: "close" },
			],
		},
	];
	// The count the scroll clamps use and the rows the modal paints are one
	// contract: a section appended to one is appended to the other.
	expect(helpModalRowCount(sections)).toBe(helpModalRows(sections).length);
	expect(helpModalRows(sections)[0]).toEqual({ title: "Navigation" });
	expect(helpModalRows(sections).at(-1)).toEqual({
		key: "wheel",
		action: "Scroll the pane under the pointer",
	});
});

test("the `?` modal renders the Mouse section and its rows", async () => {
	const t = await testRender(
		() => (
			<HelpModal
				title="Keybindings"
				offset={0}
				lines={40}
				sections={[
					{ title: "Actions", keybinds: [{ key: "Enter", action: "open" }] },
				]}
			/>
		),
		{ width: 90, height: 30 },
	);
	await t.flush();
	const frame = t.captureCharFrame();
	expect(frame).toContain("Mouse");
	expect(frame).toContain("tap");
	expect(frame).toContain("again");
	expect(frame).toContain("wheel");
	t.renderer.destroy();
});

test("the `?` help modal scrolls under the wheel through the caller's offset", async () => {
	const offsets: number[] = [];
	const [offset, setOffset] = createSignal(3);
	const t = await testRender(
		() => (
			<HelpModal
				title="Keybindings"
				offset={offset()}
				lines={5}
				onScrollOffset={(next) => {
					offsets.push(next);
					setOffset(next);
				}}
				sections={[
					{
						title: "Actions",
						keybinds: Array.from({ length: 20 }, (_, index) => ({
							key: `k${index}`,
							action: `action ${index}`,
						})),
					},
				]}
			/>
		),
		{ width: 90, height: 20 },
	);
	await t.flush();
	// The dialog is centred: its rows start inside its padding, so scroll over the
	// painted rows rather than over the dialog's own padding.
	const lines = t.captureCharFrame().split("\n");
	const rowY = lines.findIndex((line) => line.includes("k3"));
	expect(rowY).toBeGreaterThan(0);
	await t.mockMouse.scroll(30, rowY, "down");
	await t.flush();
	// One notch moves the offset the caller owns by one row.
	expect(offsets.at(-1)).toBe(4);
	await t.mockMouse.scroll(30, rowY, "up");
	await t.flush();
	expect(offsets.at(-1)).toBe(3);
	t.renderer.destroy();
});
