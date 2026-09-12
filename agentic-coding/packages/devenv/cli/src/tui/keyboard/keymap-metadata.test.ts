import { describe, expect, test } from "bun:test";
import { createTestKeymap } from "@opentui/keymap/testing";
import {
	allContextHelpSectionsFromKeymap,
	getActiveFooterKeybindsFromKeymap,
	helpSectionsFromKeymap,
} from "./keymap-metadata";
import { setupDevenvKeymap } from "./keymap-setup";

describe("keymap metadata projection", () => {
	test("footer entries come from active keymap metadata", () => {
		const { keymap, cleanup } = createTestKeymap({ defaultKeys: true });
		try {
			setupDevenvKeymap(keymap as never);
			keymap.setData("app.viewMode", "table");
			keymap.registerLayer({
				appViewMode: "table",
				commands: [
					{
						name: "table.search.open",
						context: "table",
						category: "List controls",
						title: "Search",
						desc: "Open search",
						footer: "/",
						discoverable: true,
						run: () => true,
					},
				],
				bindings: [
					{
						key: "/",
						cmd: "table.search.open",
						context: "table",
						category: "List controls",
						footer: "/",
						discoverable: true,
					},
				],
			});
			expect(
				getActiveFooterKeybindsFromKeymap(keymap).some(
					(entry) => entry.key === "/" && entry.action === "Search",
				),
			).toBe(true);
		} finally {
			cleanup();
		}
	});

	test("help sections search command metadata by context", () => {
		const { keymap, cleanup } = createTestKeymap({ defaultKeys: true });
		try {
			setupDevenvKeymap(keymap as never);
			keymap.registerLayer({
				commands: [
					{
						name: "kubernetes.refresh",
						context: "kubernetes",
						category: "Kubernetes",
						title: "Refresh Kubernetes",
						desc: "Refresh Kubernetes cluster status",
						footer: "r",
						discoverable: true,
						run: () => true,
					},
				],
				bindings: [
					{
						key: "r",
						cmd: "kubernetes.refresh",
						context: "kubernetes",
						category: "Kubernetes",
						footer: "r",
						discoverable: true,
					},
				],
			});
			const sections = helpSectionsFromKeymap(keymap, "kubernetes");
			expect(
				sections.some(
					(section) =>
						section.title === "Kubernetes" &&
						section.items.some(
							(item) =>
								item.key === "r" &&
								item.description === "Refresh Kubernetes cluster status",
						),
				),
			).toBe(true);
		} finally {
			cleanup();
		}
	});

	test("all-context projection includes required Kubernetes/panel/reverse-tab entries from metadata", () => {
		const { keymap, cleanup } = createTestKeymap({ defaultKeys: true });
		try {
			setupDevenvKeymap(keymap as never);
			keymap.registerLayer({
				commands: [
					{
						name: "kubernetes.panel.next",
						context: "kubernetes",
						category: "Navigation",
						title: "Next panel",
						desc: "Cycle panel focus in Kubernetes cluster view",
						footer: "J",
						discoverable: true,
						run: () => true,
					},
					{
						name: "table.tab.previous",
						context: "table",
						category: "Navigation",
						title: "Previous tab",
						desc: "Reverse tab cycle",
						footer: "Shift+Tab",
						discoverable: true,
						run: () => true,
					},
				],
				bindings: [
					{
						key: "J",
						cmd: "kubernetes.panel.next",
						context: "kubernetes",
						category: "Navigation",
						footer: "J",
						discoverable: true,
					},
					{
						key: "shift+tab",
						cmd: "table.tab.previous",
						context: "table",
						category: "Navigation",
						footer: "Shift+Tab",
						discoverable: true,
					},
				],
			});
			const sections = allContextHelpSectionsFromKeymap(keymap);
			expect(
				sections.some(
					(section) =>
						section.title === "kubernetes" &&
						section.items.some((item) =>
							item.description.includes("Kubernetes"),
						),
				),
			).toBe(true);
			expect(
				sections.some(
					(section) =>
						section.title === "table" &&
						section.items.some(
							(item) =>
								item.key === "shift+tab" &&
								item.description === "Reverse tab cycle",
						),
				),
			).toBe(true);
		} finally {
			cleanup();
		}
	});
});
