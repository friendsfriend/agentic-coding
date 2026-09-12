import { describe, expect, test } from "bun:test";
import { createTestKeymap } from "@opentui/keymap/testing";
import { applyKeymapRuntimeSnapshot } from "./keymap-runtime";
import { setupDevenvKeymap } from "./keymap-setup";
import type { KeyboardActions, KeyboardContext, KeyboardStores } from "./types";
import { registerWorkflowKeymapLayers } from "./workflow-keymap-layers";

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
		appActions: signalStore({ expandDependencyNode: () => {} }),
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
	viewMode = "issues",
	extra: Partial<KeyboardStores> = {},
): KeyboardStores {
	let issueSearchMode = false;
	let worktreeClosed = false;
	return {
		appStore: signalStore({
			viewMode: () => viewMode,
			activeTab: () => "applications",
			isShuttingDown: () => false,
			setViewMode: () => {},
		}),
		issueStore: signalStore({
			issues: () => [],
			selectedIssueIndex: () => 0,
			issueSearchMode: () => issueSearchMode,
			setIssueSearchMode: (v: boolean) => {
				issueSearchMode = v;
			},
			setIssueSearchQuery: () => {},
			setIssueSearchTerm: () => {},
			showIssueListFilterModal: () => false,
			showIssueListSortModal: () => false,
		}),
		logStore: signalStore(),
		changeRequestStore: signalStore(),
		providerStore: signalStore(),
		uiStore: signalStore({
			showWorktreeManagerModal: () => !worktreeClosed,
			setShowWorktreeManagerModal: (v: boolean) => {
				worktreeClosed = !v;
			},
			worktrees: () => [],
			worktreeManagerIndex: () => 0,
		}),
		agentStore: signalStore(),
		appDetailStore: signalStore({ appDetailApp: () => null }),
		...extra,
	} as unknown as KeyboardStores;
}

const setRuntime = (
	keymap: TestKeymap,
	viewMode = "issues",
	worktreeManagerActive = false,
) =>
	applyKeymapRuntimeSnapshot(keymap as never, {
		viewMode,
		activeTab: "applications",
		activeModal: "none",
		textEntryActive: false,
		shutdownActive: false,
		focusedPanel: "none",
		focusedList: viewMode,
		worktreeManagerActive,
	});

describe("workflow keymap layers", () => {
	test("issue list search routes through active view layer", () => {
		const { keymap, host, cleanup } = createTestKeymap({ defaultKeys: true });
		const stores = makeStores("issues");
		try {
			setupDevenvKeymap(keymap as never);
			setRuntime(keymap, "issues");
			registerWorkflowKeymapLayers(keymap as never, {
				stores,
				actions: actions(),
				ctx: ctx(),
			});
			host.press("/");
			expect(stores.issueStore.issueSearchMode()).toBe(true);
		} finally {
			cleanup();
		}
	});

	test("app detail escape closes detail when no sub-panel consumes it", () => {
		const { keymap, host, cleanup } = createTestKeymap({ defaultKeys: true });
		let closed = 0;
		const stores = makeStores("appDetail", {
			appDetailStore: signalStore({
				appDetailApp: () => ({ ident: "app" }),
				appDetailPanelCount: 1,
				dependencyTreeFocused: () => false,
				appDetailScrollBoxRefs: [],
				appDetailPanelIndex: () => 0,
				actionTargets: () => [],
			}) as never,
		});
		try {
			setupDevenvKeymap(keymap as never);
			setRuntime(keymap, "appDetail");
			registerWorkflowKeymapLayers(keymap as never, {
				stores,
				actions: actions({
					appActions: signalStore({
						expandDependencyNode: () => {},
						closeAppDetail: () => {
							closed += 1;
						},
					}) as never,
				}),
				ctx: ctx(),
			});
			host.press("escape");
			expect(closed).toBe(1);
		} finally {
			cleanup();
		}
	});

	test("inactive workflow view does not handle keys", () => {
		const { keymap, host, cleanup } = createTestKeymap({ defaultKeys: true });
		const stores = makeStores("issues");
		try {
			setupDevenvKeymap(keymap as never);
			setRuntime(keymap, "table");
			registerWorkflowKeymapLayers(keymap as never, {
				stores,
				actions: actions(),
				ctx: ctx(),
			});
			host.press("/");
			expect(stores.issueStore.issueSearchMode()).toBe(false);
		} finally {
			cleanup();
		}
	});

	test("worktree manager layer has modal-level priority", () => {
		const { keymap, host, cleanup } = createTestKeymap({ defaultKeys: true });
		const stores = makeStores("table");
		let underlying = 0;
		try {
			setupDevenvKeymap(keymap as never);
			setRuntime(keymap, "table", true);
			registerWorkflowKeymapLayers(keymap as never, {
				stores,
				actions: actions(),
				ctx: ctx(),
			});
			keymap.registerLayer({
				priority: 1,
				bindings: [
					{
						key: "escape",
						cmd: () => {
							underlying += 1;
						},
					},
				],
			});
			const event = host.press("escape");
			expect(event.defaultPrevented).toBe(true);
			expect(underlying).toBe(0);
		} finally {
			cleanup();
		}
	});
});
