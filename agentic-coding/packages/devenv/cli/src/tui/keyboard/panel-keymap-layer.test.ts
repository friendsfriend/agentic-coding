import { describe, expect, test } from "bun:test";
import { createTestKeymap } from "@opentui/keymap/testing";
import { applyKeymapRuntimeSnapshot } from "./keymap-runtime";
import { setupDevenvKeymap } from "./keymap-setup";
import { registerTableKeymapLayer } from "./table-keymap-layer";
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
		renderer: {},
		client: {},
		getSelectedApp: () => undefined,
		launchPi: () => {},
		getSelectableRows: () => [],
		showError: () => {},
	}) as unknown as KeyboardContext;

const stores = (): KeyboardStores =>
	({
		appStore: signalStore({
			viewMode: () => "table",
			activeTab: () => "kubernetes",
			isShuttingDown: () => false,
			kubernetesPanelIndex: () => 2,
			kubernetesPanelCount: 4,
			kubernetesScrollBoxRefs: [],
		}),
		issueStore: signalStore(),
		logStore: signalStore(),
		changeRequestStore: signalStore(),
		providerStore: signalStore(),
		uiStore: signalStore(),
		agentStore: signalStore(),
		appDetailStore: signalStore(),
	}) as unknown as KeyboardStores;

const setRuntime = (keymap: TestKeymap, focusedPanel: string) =>
	applyKeymapRuntimeSnapshot(keymap as never, {
		viewMode: "table",
		activeTab: "kubernetes",
		activeModal: "none",
		textEntryActive: false,
		shutdownActive: false,
		focusedPanel,
		focusedList: "table",
		worktreeManagerActive: false,
	});

describe("panel-gated keymap layers", () => {
	test("focused panel layer only exposes current panel metadata", () => {
		const { keymap, cleanup } = createTestKeymap({ defaultKeys: true });
		try {
			setupDevenvKeymap(keymap as never);
			registerTableKeymapLayer(keymap as never, {
				stores: stores(),
				actions: actions(),
				ctx: ctx(),
			});
			setRuntime(keymap, "kubernetes:2");
			const activeCommands = keymap
				.getActiveKeys({ includeMetadata: true, includeBindings: true })
				.flatMap((active) => active.bindings ?? [])
				.map((binding) => binding.command)
				.filter((command): command is string => typeof command === "string");
			expect(activeCommands).toContain("kubernetes.panel.2.scroll");
			expect(activeCommands).toContain("kubernetes.panel.2.half-page");
			expect(activeCommands).toContain("kubernetes.panel.2.edge");
			expect(activeCommands).not.toContain("kubernetes.panel.1.scroll");
		} finally {
			cleanup();
		}
	});

	test("detail panel layer exposes only focused panel action", () => {
		const { keymap, cleanup } = createTestKeymap({ defaultKeys: true });
		try {
			setupDevenvKeymap(keymap as never);
			registerWorkflowKeymapLayers(keymap as never, {
				stores: stores(),
				actions: actions(),
				ctx: ctx(),
			});
			applyKeymapRuntimeSnapshot(keymap as never, {
				viewMode: "issueDetail",
				activeTab: "apps",
				activeModal: "none",
				textEntryActive: false,
				shutdownActive: false,
				focusedPanel: "issueDetail:1",
				focusedList: "table",
				worktreeManagerActive: false,
			});
			const activeCommands = keymap
				.getActiveKeys({ includeMetadata: true, includeBindings: true })
				.flatMap((active) => active.bindings ?? [])
				.map((binding) => binding.command)
				.filter((command): command is string => typeof command === "string");
			expect(activeCommands).toContain("issue-detail.panel.references.o");
			expect(activeCommands).not.toContain("issue-detail.panel.body.o");
		} finally {
			cleanup();
		}
	});
});
