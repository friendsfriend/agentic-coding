import { describe, expect, test } from "bun:test";
import { createTestKeymap } from "@opentui/keymap/testing";
import { applyKeymapRuntimeSnapshot } from "./keymap-runtime";
import { setupDevenvKeymap } from "./keymap-setup";
import { registerModalKeymapLayers } from "./modal-keymap-layers";
import type { KeyboardActions, KeyboardContext, KeyboardStores } from "./types";

type TestKeymap = ReturnType<typeof createTestKeymap>["keymap"];

const signalStore = (overrides: Record<string, unknown> = {}) =>
	new Proxy(overrides, {
		get(target, prop: string) {
			if (prop in target) return target[prop];
			return () => false;
		},
	});

const actions = (): KeyboardActions =>
	({
		appActions: signalStore(),
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

const stores = (uiOverrides: Record<string, unknown>): KeyboardStores =>
	({
		appStore: signalStore({
			viewMode: () => "table",
			activeTab: () => "apps",
			isShuttingDown: () => false,
			showFirstSteps: () => false,
		}),
		issueStore: signalStore(),
		logStore: signalStore(),
		changeRequestStore: signalStore(),
		providerStore: signalStore(),
		uiStore: signalStore(uiOverrides),
		agentStore: signalStore(),
		appDetailStore: signalStore(),
	}) as unknown as KeyboardStores;

const setRuntime = (
	keymap: TestKeymap,
	activeModal: string,
	textEntryActive = false,
) =>
	applyKeymapRuntimeSnapshot(keymap as never, {
		viewMode: "table",
		activeTab: "apps",
		activeModal,
		textEntryActive,
		shutdownActive: false,
		focusedPanel: "none",
		focusedList: "table",
		worktreeManagerActive: false,
	});

describe("modal keymap layers", () => {
	test("modal layer wins over underlying view binding", () => {
		const { keymap, host, cleanup } = createTestKeymap({ defaultKeys: true });
		let confirmed = 0;
		let underlying = 0;
		const s = stores({
			showConfirmDialog: () => true,
			setShowConfirmDialog: () => {},
			confirmDialogAction: () => {
				confirmed += 1;
			},
		});
		try {
			setupDevenvKeymap(keymap as never);
			setRuntime(keymap, "confirm");
			registerModalKeymapLayers(keymap as never, {
				stores: s,
				actions: actions(),
				ctx: ctx(),
			});
			keymap.registerLayer({
				priority: 1,
				bindings: [
					{
						key: "y",
						cmd: () => {
							underlying += 1;
						},
					},
				],
			});
			host.press("y");
			expect(confirmed).toBe(1);
			expect(underlying).toBe(0);
		} finally {
			cleanup();
		}
	});

	test("text entry printable input is consumed by active modal", () => {
		const { keymap, host, cleanup } = createTestKeymap({ defaultKeys: true });
		let query = "";
		let underlying = 0;
		const s = stores({
			showThemePicker: () => true,
			themePickerFilterActive: () => true,
			themePickerFilterQuery: () => query,
			setThemePickerFilterQuery: (fn: (prev: string) => string) => {
				query = fn(query);
			},
			setThemePickerSelectedIndex: () => {},
			activeThemeName: () => "default",
			themePickerOriginalTheme: () => "default",
		});
		try {
			setupDevenvKeymap(keymap as never);
			setRuntime(keymap, "theme-picker", true);
			registerModalKeymapLayers(keymap as never, {
				stores: s,
				actions: actions(),
				ctx: ctx(),
			});
			keymap.registerLayer({
				priority: 1,
				bindings: [
					{
						key: "a",
						cmd: () => {
							underlying += 1;
						},
					},
				],
			});
			const event = host.press("a");
			expect(event.defaultPrevented).toBe(true);
			expect(underlying).toBe(0);
		} finally {
			cleanup();
		}
	});
});
