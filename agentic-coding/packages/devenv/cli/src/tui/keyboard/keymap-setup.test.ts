import { describe, expect, test } from "bun:test";
import {
	applyKeymapRuntimeSnapshot,
	getFocusedPanelName,
} from "./keymap-runtime";
import { setupDevenvKeymap } from "./keymap-setup";
import {
	activeKeyStrings,
	createKeyboardTestHarness,
	dispatchKey,
	expectActiveKeys,
	expectCommandNames,
} from "./keymap-test-helpers";

describe("keymap foundation", () => {
	test("registers app activation and metadata fields", () => {
		const { keymap, host, cleanup } = createKeyboardTestHarness();
		try {
			setupDevenvKeymap(keymap as never);
			let ran = false;
			keymap.setData("app.viewMode", "table");
			keymap.registerLayer({
				appViewMode: "table",
				commands: [
					{
						name: "table.search.open",
						context: "table",
						category: "List",
						title: "Search",
						footer: "/",
						discoverable: true,
						run: () => {
							ran = true;
						},
					},
				],
				bindings: [
					{
						key: "/",
						cmd: "table.search.open",
						context: "table",
						category: "List",
						footer: "/",
						discoverable: true,
					},
				],
			});

			expect(activeKeyStrings(keymap)).toContain("/");
			expect(
				keymap.getActiveKeys({ includeMetadata: true })[0]?.commandAttrs?.title,
			).toBe("Search");
			expect(
				keymap.getActiveKeys({ includeMetadata: true })[0]?.bindingAttrs
					?.footer,
			).toBe("/");
			dispatchKey(host, "/");
			expect(ran).toBe(true);
		} finally {
			cleanup();
		}
	});

	test("runtime state gates layers", () => {
		const { keymap, cleanup } = createKeyboardTestHarness();
		try {
			setupDevenvKeymap(keymap as never);
			keymap.registerLayer({
				appViewMode: "table",
				bindings: [{ key: "t", cmd: () => true }],
			});
			applyKeymapRuntimeSnapshot(keymap as never, {
				viewMode: "table",
				activeTab: "apps",
				activeModal: "none",
				textEntryActive: false,
				shutdownActive: false,
				focusedPanel: "none",
				focusedList: "table",
				worktreeManagerActive: false,
			});
			expectActiveKeys(keymap, ["t"]);
			applyKeymapRuntimeSnapshot(keymap as never, {
				viewMode: "help",
				activeTab: "apps",
				activeModal: "none",
				textEntryActive: false,
				shutdownActive: false,
				focusedPanel: "none",
				focusedList: "help",
				worktreeManagerActive: false,
			});
			expectActiveKeys(keymap, []);
		} finally {
			cleanup();
		}
	});

	test("runtime focused panel derives from panel-based views", () => {
		const fn = (value: unknown) => () => value;
		const stores = {
			appStore: {
				viewMode: fn("changeRequestDetail"),
				activeTab: fn("applications"),
				isShuttingDown: fn(false),
			},
			changeRequestStore: { crDetailPanelIndex: fn(2) },
			appDetailStore: {},
			issueStore: {},
			logStore: {},
			providerStore: {},
			uiStore: {},
			agentStore: {},
		} as never;
		expect(getFocusedPanelName(stores)).toBe("changeRequestDetail:2");
	});

	test("uppercase bindings match shifted lowercase key events", () => {
		const { keymap, host, cleanup } = createKeyboardTestHarness();
		try {
			setupDevenvKeymap(keymap as never);
			let ran = false;
			keymap.registerLayer({
				bindings: [
					{
						key: "F",
						cmd: () => {
							ran = true;
						},
					},
				],
			});
			host.press("f", { shift: true });
			expect(ran).toBe(true);
		} finally {
			cleanup();
		}
	});

	test("test helpers expose command and active-key assertions", () => {
		const { keymap, cleanup } = createKeyboardTestHarness();
		try {
			keymap.registerLayer({
				commands: [{ name: "help.open", run: () => true }],
				bindings: [{ key: "?", cmd: "help.open" }],
			});
			expectCommandNames(keymap, ["help.open"]);
			expectActiveKeys(keymap, ["?"]);
		} finally {
			cleanup();
		}
	});
});
