import { describe, expect, test } from "bun:test";
import { createTestKeymap } from "@opentui/keymap/testing";
import { applyKeymapRuntimeSnapshot } from "./keymap-runtime";
import { setupDevenvKeymap } from "./keymap-setup";
import { registerTableKeymapLayer } from "./table-keymap-layer";
import { handleTableKeys } from "./table-keys";
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
		...overrides,
	}) as unknown as KeyboardActions;

const ctx = (): KeyboardContext =>
	({
		renderer: {},
		client: {},
		getSelectedApp: () => undefined,
		launchPi: () => {},
		getSelectableRows: () => [],
		showError: () => {},
	}) as unknown as KeyboardContext;

function makeStores(
	appOverrides: Record<string, unknown> = {},
): KeyboardStores {
	let searchMode = false;
	let searchQuery = "old";
	let filterOpen = false;
	let sortOpen = false;
	let selectedIndex = 3;
	return {
		appStore: signalStore({
			viewMode: () => "table",
			activeTab: () => "applications",
			isShuttingDown: () => false,
			tableSearchMode: () => searchMode,
			setTableSearchMode: (v: boolean) => {
				searchMode = v;
			},
			tableSearchQuery: () => searchQuery,
			setTableSearchQuery: (v: string | ((prev: string) => string)) => {
				searchQuery = typeof v === "function" ? v(searchQuery) : v;
			},
			setSelectedIndex: (v: number | ((prev: number) => number)) => {
				selectedIndex = typeof v === "function" ? v(selectedIndex) : v;
			},
			selectedIndex: () => selectedIndex,
			tableFilteredApps: () => [],
			filteredApps: () => [],
			showTableFilterModal: () => filterOpen,
			setShowTableFilterModal: (v: boolean) => {
				filterOpen = v;
			},
			showTableSortModal: () => sortOpen,
			setShowTableSortModal: (v: boolean) => {
				sortOpen = v;
			},
			kubernetesPanelCount: 1,
			...appOverrides,
		}),
		issueStore: signalStore(),
		logStore: signalStore(),
		changeRequestStore: signalStore(),
		providerStore: signalStore(),
		uiStore: signalStore({ activeThemeName: () => "default" }),
		agentStore: signalStore(),
		appDetailStore: signalStore(),
	} as unknown as KeyboardStores;
}

const setRuntime = (
	keymap: TestKeymap,
	activeTab = "applications",
	viewMode = "table",
	activeModal = "none",
) =>
	applyKeymapRuntimeSnapshot(keymap as never, {
		viewMode,
		activeTab,
		activeModal,
		textEntryActive: false,
		shutdownActive: false,
		focusedPanel: "none",
		focusedList: viewMode,
		worktreeManagerActive: false,
	});

describe("table keymap layer", () => {
	test("standard list controls route through table layer", () => {
		const { keymap, host, cleanup } = createTestKeymap({ defaultKeys: true });
		const stores = makeStores();
		try {
			setupDevenvKeymap(keymap as never);
			setRuntime(keymap);
			registerTableKeymapLayer(keymap as never, {
				stores,
				actions: actions(),
				ctx: ctx(),
			});
			host.press("/");
			expect(stores.appStore.tableSearchMode()).toBe(true);
			expect(stores.appStore.tableSearchQuery()).toBe("");
			stores.appStore.setTableSearchMode(false);
			host.press("f", { shift: true });
			expect(stores.appStore.showTableFilterModal()).toBe(true);
			stores.appStore.setShowTableFilterModal(false);
			host.press("o", { shift: true });
			expect(stores.appStore.showTableSortModal()).toBe(true);
		} finally {
			cleanup();
		}
	});

	test("s starts selected infrastructure service even though getSelectedApp excludes infra rows", async () => {
		const infra = {
			ident: "postgres",
			displayName: "Postgres",
			type: "docker",
			operationStatus: undefined,
		};
		const stores = makeStores({
			activeTab: () => "infrastructure",
			tableFilteredApps: () => [{ rowKind: "infra", ident: "postgres" }],
			infraServices: () => [infra],
			selectedIndex: () => 0,
			operationInProgressForApp: () => null,
			apps: () => [],
		});
		let started: unknown;
		const keyboardActions = actions({
			dockerActions: signalStore({
				openInfrastructureStartTargetPicker: (service: unknown) => {
					started = ["picker", service];
				},
			}) as never,
		});
		await handleTableKeys(
			{ name: "s", sequence: "s" },
			stores,
			keyboardActions,
			ctx(),
		);
		expect(started).toEqual(["picker", infra]);
	});

	test("l opens live logs and uppercase L opens action history", () => {
		const { keymap, host, cleanup } = createTestKeymap({ defaultKeys: true });
		let pushed = "";
		let openedLogs = 0;
		const stores = makeStores({
			pushModal: (name: string) => {
				pushed = name;
			},
			tableFilteredApps: () => [{ ident: "api" }],
		});
		try {
			setupDevenvKeymap(keymap as never);
			setRuntime(keymap);
			registerTableKeymapLayer(keymap as never, {
				stores,
				actions: actions({
					logActions: signalStore({
						loadContainerLogs: () => {
							openedLogs++;
						},
					}) as never,
				}),
				ctx: ctx(),
			});
			host.press("l");
			expect(openedLogs).toBe(1);
			expect(pushed).toBe("");
			host.press("l", { shift: true });
			expect(pushed).toBe("actions");
			expect(
				keymap
					.getCommandEntries()
					.some((entry) => entry.command.name === "actions.toggle"),
			).toBe(true);
		} finally {
			cleanup();
		}
	});

	test("inactive view layer does not handle table keys", () => {
		const { keymap, host, cleanup } = createTestKeymap({ defaultKeys: true });
		const stores = makeStores();
		try {
			setupDevenvKeymap(keymap as never);
			setRuntime(keymap, "applications", "help");
			registerTableKeymapLayer(keymap as never, {
				stores,
				actions: actions(),
				ctx: ctx(),
			});
			host.press("/");
			expect(stores.appStore.tableSearchMode()).toBe(false);
		} finally {
			cleanup();
		}
	});

	test("escape at the table root is yielded instead of swallowed", () => {
		const { keymap, host, cleanup } = createTestKeymap({ defaultKeys: true });
		let popped = 0;
		const stores = makeStores({
			canGoBack: () => false,
			resetViewStack: () => {
				popped += 1;
			},
		});
		let shellHandled = 0;
		// The fixture starts with a query typed; the root case has none.
		stores.appStore.setTableSearchQuery("");
		try {
			setupDevenvKeymap(keymap as never);
			setRuntime(keymap);
			registerTableKeymapLayer(keymap as never, {
				stores,
				actions: actions(),
				ctx: ctx(),
			});
			// Stand-in for the shell's lowest-priority layer: the key reaches it
			// only when the table layer does not consume the Escape.
			keymap.registerLayer({
				name: "Shell stand-in",
				priority: 1,
				commands: [
					{
						name: "test.shell.escape",
						context: "global",
						run: () => {
							shellHandled += 1;
							return true;
						},
					},
				],
				bindings: [{ key: "escape", cmd: "test.shell.escape" }],
			});
			host.press("escape");
			expect(popped).toBe(0);
			expect(shellHandled).toBe(1);

			// An active search still clears first and keeps the key.
			stores.appStore.setTableSearchQuery("checkout");
			host.press("escape");
			expect(stores.appStore.tableSearchQuery()).toBe("");
			expect(shellHandled).toBe(1);
		} finally {
			cleanup();
		}
	});

	test("escape in a deeper view mode still pops one level", async () => {
		let popped = 0;
		const stores = makeStores({
			canGoBack: () => true,
			resetViewStack: () => {
				popped += 1;
			},
		});
		stores.appStore.setTableSearchQuery("");
		expect(
			await handleTableKeys(
				{ name: "escape" } as never,
				stores,
				actions(),
				ctx(),
			),
		).toBe(true);
		expect(popped).toBe(1);

		// At the root the same key is not consumed, so the shell can step up a
		// page from the category body.
		const root = makeStores({ canGoBack: () => false });
		root.appStore.setTableSearchQuery("");
		expect(
			await handleTableKeys(
				{ name: "escape" } as never,
				root,
				actions(),
				ctx(),
			),
		).toBe(false);
	});

	test("kubernetes actions gate on active tab", () => {
		const { keymap, host, cleanup } = createTestKeymap({ defaultKeys: true });
		let refreshed = 0;
		let activeTab = "kubernetes";
		const stores = makeStores({ activeTab: () => activeTab });
		try {
			setupDevenvKeymap(keymap as never);
			setRuntime(keymap, "kubernetes");
			registerTableKeymapLayer(keymap as never, {
				stores,
				actions: actions({
					dockerActions: signalStore({
						refreshKubernetesCluster: () => {
							refreshed += 1;
						},
					}) as never,
				}),
				ctx: ctx(),
			});
			host.press("r");
			expect(refreshed).toBe(1);
			activeTab = "applications";
			setRuntime(keymap, "applications");
			host.press("r");
			expect(refreshed).toBe(1);
		} finally {
			cleanup();
		}
	});
});
