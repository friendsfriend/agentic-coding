import { describe, expect, test } from "bun:test";
import { createTestKeymap } from "@opentui/keymap/testing";
import { registerGlobalKeymapLayers } from "./global-keymap-layer";
import { applyKeymapRuntimeSnapshot } from "./keymap-runtime";
import { setupDevenvKeymap } from "./keymap-setup";
import { registerModalKeymapLayers } from "./modal-keymap-layers";
import { registerTableKeymapLayer } from "./table-keymap-layer";
import type { KeyboardActions, KeyboardContext, KeyboardStores } from "./types";

type TestKeymap = ReturnType<typeof createTestKeymap>["keymap"];

const signalStore = (overrides: Record<string, unknown> = {}) =>
	new Proxy(overrides, {
		get(target, prop: string) {
			if (prop in target) return target[prop];
			return () => false;
		},
	});

const actions = (overrides: Partial<KeyboardActions> = {}): KeyboardActions =>
	({
		appActions: signalStore({ exitApp: () => {} }),
		issueActions: signalStore(),
		logActions: signalStore(),
		crActions: signalStore(),
		dockerActions: signalStore(),
		gitActions: signalStore(),
		providerActions: signalStore(),
		agentActions: signalStore(),
		utilActions: signalStore(),
		pipelineActions: signalStore(),
		helpActions: signalStore(),
		...overrides,
	}) as unknown as KeyboardActions;

const ctx = (): KeyboardContext =>
	({
		renderer: { console: { visible: false }, getSelection: () => null },
		client: {},
		getSelectedApp: () => undefined,
		launchPi: () => {},
		getSelectableRows: () => [],
		showError: () => {},
	}) as unknown as KeyboardContext;

function stores(
	overrides: {
		viewMode?: string;
		activeModal?: string;
		shutdown?: boolean;
		confirm?: boolean;
	} = {},
): KeyboardStores {
	let searchMode = false;
	return {
		appStore: signalStore({
			viewMode: () => overrides.viewMode ?? "table",
			activeTab: () => "applications",
			isShuttingDown: () => overrides.shutdown ?? false,
			showFirstSteps: () => false,
			tableSearchMode: () => searchMode,
			setTableSearchMode: (v: boolean) => {
				searchMode = v;
			},
			setTableSearchQuery: () => {},
			setSelectedIndex: () => {},
			tableFilteredApps: () => [],
			filteredApps: () => [],
		}),
		issueStore: signalStore(),
		logStore: signalStore(),
		changeRequestStore: signalStore(),
		providerStore: signalStore(),
		uiStore: signalStore({
			showConfirmDialog: () => overrides.confirm ?? false,
			setShowConfirmDialog: () => {},
			confirmDialogAction: () => {},
		}),
		agentStore: signalStore(),
		appDetailStore: signalStore(),
	} as unknown as KeyboardStores;
}

const setRuntime = (
	keymap: TestKeymap,
	viewMode = "table",
	activeModal = "none",
	shutdownActive = false,
) =>
	applyKeymapRuntimeSnapshot(keymap as never, {
		viewMode,
		activeTab: "applications",
		activeModal,
		textEntryActive: false,
		shutdownActive,
		focusedPanel: "none",
		focusedList: viewMode,
		worktreeManagerActive: false,
	});

describe("keymap conflict regression", () => {
	test("modal consumes conflicting help key before global help", () => {
		const { keymap, host, cleanup } = createTestKeymap({ defaultKeys: true });
		let helpOpened = 0;
		const s = stores({ confirm: true });
		try {
			setupDevenvKeymap(keymap as never);
			setRuntime(keymap, "table", "confirm");
			registerGlobalKeymapLayers(keymap as never, {
				stores: s,
				actions: actions({
					helpActions: signalStore({
						showHelp: () => {
							helpOpened += 1;
						},
					}) as never,
				}),
				ctx: ctx(),
			});
			registerModalKeymapLayers(keymap as never, {
				stores: s,
				actions: actions(),
				ctx: ctx(),
			});
			const event = host.press("?");
			expect(event.defaultPrevented).toBe(true);
			expect(helpOpened).toBe(0);
		} finally {
			cleanup();
		}
	});

	test("shutdown guard wins over table and modal commands", () => {
		const { keymap, host, cleanup } = createTestKeymap({ defaultKeys: true });
		const s = stores({ shutdown: true, confirm: true });
		try {
			setupDevenvKeymap(keymap as never);
			setRuntime(keymap, "table", "confirm", true);
			registerGlobalKeymapLayers(keymap as never, {
				stores: s,
				actions: actions(),
				ctx: ctx(),
			});
			registerModalKeymapLayers(keymap as never, {
				stores: s,
				actions: actions(),
				ctx: ctx(),
			});
			registerTableKeymapLayer(keymap as never, {
				stores: s,
				actions: actions(),
				ctx: ctx(),
			});
			const event = host.press("/");
			expect(event.defaultPrevented).toBe(true);
			expect(s.appStore.tableSearchMode()).toBe(false);
		} finally {
			cleanup();
		}
	});

	test("fallthrough command allows lower-priority binding to run", () => {
		const { keymap, host, cleanup } = createTestKeymap({ defaultKeys: true });
		let lower = 0;
		try {
			keymap.registerLayer({
				priority: 10,
				bindings: [{ key: "x", fallthrough: true, cmd: () => false }],
			});
			keymap.registerLayer({
				priority: 1,
				bindings: [
					{
						key: "x",
						cmd: () => {
							lower += 1;
						},
					},
				],
			});
			host.press("x");
			expect(lower).toBe(1);
		} finally {
			cleanup();
		}
	});
});
