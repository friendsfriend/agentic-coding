import { describe, expect, test } from "bun:test";
import { createTestKeymap } from "@opentui/keymap/testing";
import { registerGlobalKeymapLayers } from "./global-keymap-layer";
import { applyKeymapRuntimeSnapshot } from "./keymap-runtime";
import { setupDevenvKeymap } from "./keymap-setup";
import type { KeyboardActions, KeyboardContext, KeyboardStores } from "./types";

type TestKeymap = ReturnType<typeof createTestKeymap>["keymap"];

const signalStore = (overrides: Record<string, unknown> = {}) =>
	new Proxy(overrides, {
		get(target, prop: string) {
			if (prop in target) return target[prop];
			return () => false;
		},
	});

const stores = (
	appOverrides: Record<string, unknown> = {},
	uiOverrides: Record<string, unknown> = {},
): KeyboardStores =>
	({
		appStore: signalStore({
			viewMode: () => "table",
			activeTab: () => "apps",
			showFirstSteps: () => false,
			isShuttingDown: () => false,
			...appOverrides,
		}),
		issueStore: signalStore(),
		logStore: signalStore(),
		changeRequestStore: signalStore(),
		providerStore: signalStore(),
		uiStore: signalStore({
			setNotification: () => {},
			runningTextEnabled: () => false,
			setRunningTextEnabled: () => {},
			setRunningTextOffset: () => {},
			...uiOverrides,
		}),
		agentStore: signalStore(),
		appDetailStore: signalStore(),
	}) as unknown as KeyboardStores;

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
		renderer: {
			console: { visible: false, toggle: () => {}, hide: () => {} },
			getSelection: () => null,
		},
		client: {},
		getSelectedApp: () => undefined,
		launchPi: () => {},
		getSelectableRows: () => [],
		showError: () => {},
	}) as unknown as KeyboardContext;

const setRuntime = (keymap: TestKeymap, shutdownActive = false) =>
	applyKeymapRuntimeSnapshot(keymap as never, {
		viewMode: "table",
		activeTab: "apps",
		activeModal: "none",
		textEntryActive: false,
		shutdownActive,
		focusedPanel: "none",
		focusedList: "table",
		worktreeManagerActive: false,
	});

describe("global keymap layer", () => {
	test("global help command preserves behavior", () => {
		const { keymap, host, cleanup } = createTestKeymap({ defaultKeys: true });
		let helpOpened = 0;
		const s = stores();
		try {
			setupDevenvKeymap(keymap as never);
			setRuntime(keymap);
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
			host.press("?");
			expect(helpOpened).toBe(1);
		} finally {
			cleanup();
		}
	});

	test("global quit wins outside table when lower-priority view binds q", () => {
		const { keymap, host, cleanup } = createTestKeymap({ defaultKeys: true });
		let viewQuit = 0;
		let notification = "";
		try {
			setupDevenvKeymap(keymap as never);
			applyKeymapRuntimeSnapshot(keymap as never, {
				viewMode: "issueDetail",
				activeTab: "apps",
				activeModal: "none",
				textEntryActive: false,
				shutdownActive: false,
				focusedPanel: "issueDetail:0",
				focusedList: "issueDetail",
				worktreeManagerActive: false,
			});
			registerGlobalKeymapLayers(keymap as never, {
				stores: stores(
					{ viewMode: () => "issueDetail" },
					{
						setNotification: (text: string) => {
							notification = text;
						},
					},
				),
				actions: actions(),
				ctx: ctx(),
			});
			keymap.registerLayer({
				priority: 100,
				appViewMode: "issueDetail",
				bindings: [
					{
						key: "q",
						cmd: () => {
							viewQuit += 1;
						},
					},
				],
			});
			host.press("q");
			expect(notification).toContain("press q again");
			expect(viewQuit).toBe(0);
		} finally {
			cleanup();
		}
	});

	test("global escape falls through when console is not visible", () => {
		const { keymap, host, cleanup } = createTestKeymap({ defaultKeys: true });
		let viewEsc = 0;
		try {
			setupDevenvKeymap(keymap as never);
			applyKeymapRuntimeSnapshot(keymap as never, {
				viewMode: "issueDetail",
				activeTab: "apps",
				activeModal: "none",
				textEntryActive: false,
				shutdownActive: false,
				focusedPanel: "issueDetail:0",
				focusedList: "issueDetail",
				worktreeManagerActive: false,
			});
			registerGlobalKeymapLayers(keymap as never, {
				stores: stores({ viewMode: () => "issueDetail" }),
				actions: actions(),
				ctx: ctx(),
			});
			keymap.registerLayer({
				priority: 100,
				appViewMode: "issueDetail",
				bindings: [
					{
						key: "escape",
						cmd: () => {
							viewEsc += 1;
						},
					},
				],
			});
			host.press("escape");
			expect(viewEsc).toBe(1);
		} finally {
			cleanup();
		}
	});

	test("shutdown guard suppresses normal global commands", () => {
		const { keymap, host, cleanup } = createTestKeymap({ defaultKeys: true });
		let helpOpened = 0;
		try {
			setupDevenvKeymap(keymap as never);
			setRuntime(keymap, true);
			registerGlobalKeymapLayers(keymap as never, {
				stores: stores({ isShuttingDown: () => true }),
				actions: actions({
					helpActions: signalStore({
						showHelp: () => {
							helpOpened += 1;
						},
					}) as never,
				}),
				ctx: ctx(),
			});
			const event = host.press("?");
			expect(event.defaultPrevented).toBe(true);
			expect(helpOpened).toBe(0);
		} finally {
			cleanup();
		}
	});
});
