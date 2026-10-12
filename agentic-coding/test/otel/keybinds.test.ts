import { describe, expect, it } from "bun:test";
import { catalogKeybinds, footerKeybinds, keybindFooterLabel } from "@ui";
import {
	observabilityKeybindCatalog,
	workspaceSidebarKeybindCatalog,
	workspaceSidebarPanelSection,
} from "../../src/tui/otel/app/keybinds.ts";

/** The label a footer surface actually renders for an entry. */
const footerLabels = (
	...args: Parameters<typeof observabilityKeybindCatalog>
): string[] =>
	footerKeybinds(observabilityKeybindCatalog(...args)).map(keybindFooterLabel);

const actions = (options: Parameters<typeof observabilityKeybindCatalog>[0]) =>
	catalogKeybinds(observabilityKeybindCatalog(options)).map((kb) => kb.action);

describe("observability shell keybind catalog", () => {
	it("advertises the wiki actions WikiView implements", () => {
		const wiki = actions({ tab: "wiki", view: "selection" });
		expect(wiki).toContain("comment");
		expect(wiki).toContain("visual line selection");
		expect(wiki).toContain("next/previous note");
		expect(wiki).toContain("finish review");
		expect(wiki).toContain("refresh");
		expect(wiki).toContain("Open help");
	});

	it("does not advertise the theme picker on the wiki tab", () => {
		// The shell returns before its Shift+T handler on the wiki tab and
		// WikiView consumes the key, so theme is a no-op there.
		const wiki = actions({ tab: "wiki", view: "selection" });
		expect(wiki).not.toContain("theme picker");
	});

	it("gives every shell tab a special `?` help entry so the footer is never empty", () => {
		for (const tab of ["wiki", "metrics", "logs", "topology"] as const) {
			const footer = footerKeybinds(
				observabilityKeybindCatalog({ tab, view: "selection" }),
			);
			expect(footer.map(keybindFooterLabel)).toContain("help");
		}
		for (const view of ["selection", "detail", "span"] as const) {
			const footer = footerKeybinds(
				observabilityKeybindCatalog({ tab: "traces", view }),
			);
			expect(footer.length).toBeGreaterThan(0);
		}
	});

	it("keeps standard navigation out of the footer but in the catalog", () => {
		const catalog = observabilityKeybindCatalog({
			tab: "traces",
			view: "selection",
		});
		const all = catalogKeybinds(catalog).map((kb) => kb.action);
		const footer = footerKeybinds(catalog).map(keybindFooterLabel);
		expect(all).toContain("select trace");
		expect(footer).not.toContain("select trace");
		expect(footerLabels({ tab: "traces", view: "selection" })).toContain(
			"help",
		);
	});

	it("advertises the view-independent traces keys in the detail and span views", () => {
		for (const view of ["detail", "span"] as const) {
			const viewActions = actions({ tab: "traces", view });
			expect(viewActions).toContain("search");
			expect(viewActions).toContain("filter");
			expect(viewActions).toContain("sort");
			expect(viewActions).toContain("all workspaces");
		}
	});

	it("lists a standard Esc back key for the wiki tab", () => {
		const wiki = catalogKeybinds(
			observabilityKeybindCatalog({
				tab: "wiki",
				view: "selection",
			}),
		).find((kb) => kb.key === "Esc");
		expect(wiki?.standard).toBe(true);
	});

	it("scopes note-only wiki keys to the note footer context", () => {
		const catalog = observabilityKeybindCatalog({
			tab: "wiki",
			view: "selection",
		});
		const treeFooter = footerKeybinds(catalog).map((kb) => kb.action);
		expect(treeFooter).not.toContain("visual line selection");
		expect(treeFooter).not.toContain("next/previous note");
		// In note state the shell publishes the `note` context and they appear.
		const noteFooter = footerKeybinds(catalog, "note").map((kb) => kb.action);
		expect(noteFooter).toContain("visual line selection");
		expect(noteFooter).toContain("next/previous note");
		expect(noteFooter).toContain("comment");
		// `?` help still lists every keybind, context included.
		const all = catalogKeybinds(catalog).map((kb) => kb.action);
		expect(all).toContain("visual line selection");
		expect(all).toContain("next/previous note");
	});
});

describe("workspace sidebar keybind catalog", () => {
	it("lists the workspace cycle with the sidebar's own keys", () => {
		const catalog = workspaceSidebarKeybindCatalog();
		const all = catalogKeybinds(catalog);
		expect(all.find((kb) => kb.key === "Ctrl+H")?.action).toBe(
			"previous workspace",
		);
		expect(all.find((kb) => kb.key === "Ctrl+L")?.action).toBe(
			"next workspace",
		);
		// Navigation, so `?` help documents it and the footer keeps advertising
		// the sidebar's own actions.
		expect(all.find((kb) => kb.key === "Ctrl+H")?.standard).toBe(true);
		expect(all.find((kb) => kb.key === "Ctrl+L")?.standard).toBe(true);
		expect(footerKeybinds(catalog).map((kb) => kb.key)).not.toContain("Ctrl+H");
	});

	it("names the cycle in the page body's panel section", () => {
		// The page body advertises how to reach and walk the sidebar, so the
		// cycle travels with the Ctrl+S toggle rather than living only in the
		// panel's own catalog.
		expect(
			catalogKeybinds([workspaceSidebarPanelSection()]).map((kb) => kb.key),
		).toEqual(["Ctrl+S", "Ctrl+H", "Ctrl+L"]);
	});
});
