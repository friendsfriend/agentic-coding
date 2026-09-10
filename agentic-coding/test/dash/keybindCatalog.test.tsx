/** @jsxImportSource @opentui/solid */
import { describe, expect, it, test } from "bun:test";
import { testRender } from "@opentui/solid";
import {
	dashboardDetailKeybindCatalog,
	dashboardOverviewKeybindCatalog,
	panelContext,
} from "../../src/tui/dash/keybinds";
import { HelpModal } from "../../src/tui/dash/ui/HelpModal";
import { wrapHelpEntries } from "../../src/tui/shared/HelpText";
import {
	catalogKeybinds,
	footerKeybinds,
	setActiveKeybindCatalog,
	specialKeybinds,
} from "../../src/tui/shared/keybinds";

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

	it("scopes panel-specific footer keybinds to the focused panel", () => {
		const catalog = dashboardDetailKeybindCatalog({ artifactsVisible: true });
		const change = footerKeybinds(catalog, "change").map((kb) => kb.action);
		const openspec = footerKeybinds(catalog, "openspec").map((kb) => kb.action);
		const agents = footerKeybinds(catalog, "agents").map((kb) => kb.action);

		expect(change).toContain("Approve gate / review changed files");
		expect(change).not.toContain("Open selected artifact");
		expect(openspec).toContain("Open selected artifact");
		expect(openspec).not.toContain("Focus selected agent");
		expect(agents).toContain("Focus selected agent");
		expect(agents).toContain("View selected verifier result");
		expect(agents).not.toContain("Approve gate / review changed files");
	});

	it("maps every detail grid panel to a footer context", () => {
		expect(panelContext(0)).toBe("change");
		expect(panelContext(1)).toBe("agents");
		expect(panelContext(6)).toBe("openspec");
	});

	it("omits the OpenSpec section while no artifacts are listed", () => {
		const catalog = dashboardDetailKeybindCatalog({ artifactsVisible: false });
		expect(
			catalogKeybinds(catalog).some(
				(keybind) => keybind.action === "Open selected artifact",
			),
		).toBe(false);
	});

	it("overview footer keeps only special actions", () => {
		const footer = footerKeybinds(dashboardOverviewKeybindCatalog());
		const actions = footer.map((keybind) => keybind.action);
		expect(actions).toContain("New workflow");
		expect(actions).not.toContain("Select workspace");
		expect(actions).not.toContain("Quit");
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
				line.map((kb) => `${kb.key} ${kb.action}`).join("  •  ").length,
			).toBeLessThanOrEqual(24);
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
	t.renderer.destroy();
});
