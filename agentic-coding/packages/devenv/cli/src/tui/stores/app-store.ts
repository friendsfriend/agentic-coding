import type { ScrollBoxRenderable } from "@opentui/core";
import { createMemo, createSignal } from "solid-js";

export const KUBERNETES_PANEL_COUNT = 4;

import type {
	App,
	InfraService,
	KubernetesClusterStatus,
	ScriptNode,
	ScriptVisibleRow,
	TableRow,
} from "@devenv/types";
import type { TableTab } from "@devenv/ui";
import { runtimeState } from "@devenv/ui";

export type ViewMode =
	| "table"
	| "changeRequests"
	| "changeRequestDetail"
	| "changedFiles"
	| "discussionsView"
	| "testResults"
	| "jobs"
	| "providers"
	| "help"
	| "agentView"
	| "sshPicker"
	| "appDetail"
	| "issues"
	| "issueDetail"
	| "issueTimeline"
	| "issueScopePicker"
	| "changeRequestLinkedIssues"
	| "references"
	| "actions";

export interface ViewRoute {
	mode: ViewMode;
}

export interface ModalRoute {
	name: string;
}

export type TabType =
	| "applications"
	| "infrastructure"
	| "libraries"
	| "scripts"
	| "kubernetes"
	| "ui-test";

type TableSortKey =
	| "status"
	| "git"
	| "name"
	| "interpreter"
	| "path"
	| "params";
type TableSortDirection = "asc" | "desc" | "none";
export interface TableSortRule {
	key: TableSortKey;
	label: string;
	direction: TableSortDirection;
}

export type StartupPhase =
	| "connecting"
	| "server-ready"
	| "loading-action-registry"
	| "loading-applications"
	| "loading-infrastructure"
	| "loading-scripts"
	| "loading-providers"
	| "complete"
	| "failed";

export interface StartupState {
	phase: StartupPhase;
	message: string;
	error: string | null;
}

export type ShutdownPhase =
	| "idle"
	| "preparing"
	| "canceling-background-work"
	| "stopping-input"
	| "stopping-server"
	| "destroying-renderer"
	| "complete"
	| "failed";

export type ShutdownStepPhase = Exclude<ShutdownPhase, "idle" | "failed">;
export type ShutdownStepStatus = "done" | "current" | "pending" | "failed";

export interface ShutdownState {
	phase: ShutdownPhase;
	message: string;
	error: string | null;
	failedPhase?: ShutdownStepPhase;
}

export const SHUTDOWN_PHASE_ORDER: ShutdownStepPhase[] = [
	"preparing",
	"canceling-background-work",
	"stopping-input",
	"stopping-server",
	"destroying-renderer",
	"complete",
];

export const SHUTDOWN_PHASE_LABELS: Record<ShutdownStepPhase, string> = {
	preparing: "Preparing shutdown",
	"canceling-background-work": "Canceling background work",
	"stopping-input": "Stopping input",
	"stopping-server": "Stopping server",
	"destroying-renderer": "Destroying renderer",
	complete: "Shutdown complete",
};

export function getShutdownPhaseStatus(
	state: ShutdownState,
	phase: ShutdownStepPhase,
): ShutdownStepStatus {
	const phaseIndex = SHUTDOWN_PHASE_ORDER.indexOf(phase);
	if (state.phase === "idle") return "pending";
	if (state.phase === "failed") {
		const failedPhase = state.failedPhase;
		if (!failedPhase) return "pending";
		const failedIndex = SHUTDOWN_PHASE_ORDER.indexOf(failedPhase);
		if (phaseIndex < failedIndex) return "done";
		if (phaseIndex === failedIndex) return "failed";
		return "pending";
	}
	const currentIndex = SHUTDOWN_PHASE_ORDER.indexOf(state.phase);
	if (phaseIndex < currentIndex) return "done";
	if (phaseIndex === currentIndex) return "current";
	return "pending";
}

function flattenScriptTree(
	nodes: ScriptNode[],
	expandedFolders: Set<string>,
	depth = 0,
): ScriptVisibleRow[] {
	const out: ScriptVisibleRow[] = [];
	for (const node of nodes) {
		out.push({
			name: node.name,
			relativePath: node.relativePath,
			absolutePath: node.absolutePath,
			nodeType: node.nodeType,
			interpreter: node.interpreter,
			parameters: node.parameters,
			depth,
		});

		if (
			node.nodeType === "folder" &&
			expandedFolders.has(node.relativePath) &&
			node.children?.length
		) {
			out.push(...flattenScriptTree(node.children, expandedFolders, depth + 1));
		}
	}
	return out;
}

function folderPaths(nodes: ScriptNode[]): string[] {
	const paths: string[] = [];
	for (const node of nodes) {
		if (node.nodeType === "folder") {
			paths.push(node.relativePath);
			if (node.children?.length) {
				paths.push(...folderPaths(node.children));
			}
		}
	}
	return paths;
}

function appStatusRank(app: TableRow): number {
	return runtimeState(
		app.runtimeStatus,
		app.status || app.dockerInfo?.Status,
	) === "running"
		? 0
		: 1;
}

function appGitRank(app: TableRow): number {
	const status = app.rowKind === "app" ? app.gitStatus?.trim() || "" : "";
	return status.includes("+") ||
		status.includes("~") ||
		status.includes("-") ||
		status.includes("*")
		? 0
		: 1;
}

function tableSearchText(app: TableRow): string {
	return [
		app.ident,
		app.displayName,
		app.localDirectoryPath,
		app.repositoryPath,
		app.branch,
		app.containerBaseName,
		app.status,
		app.dockerInfo?.Status,
		app.rowKind === "app" ? app.provider : "",
		app.rowKind === "app" ? app.sourceType : "",
		app.rowKind === "script" ? app.scriptRelativePath : "",
		app.rowKind === "script" ? app.interpreter : "",
		app.rowKind === "infra" ? app.type : "",
	]
		.filter(Boolean)
		.join("\n")
		.toLowerCase();
}

function compareByRule(a: TableRow, b: TableRow, rule: TableSortRule): number {
	let result = 0;
	if (rule.key === "status") result = appStatusRank(a) - appStatusRank(b);
	if (rule.key === "git") result = appGitRank(a) - appGitRank(b);
	if (rule.key === "name") result = a.displayName.localeCompare(b.displayName);
	if (rule.key === "interpreter")
		result = (a.rowKind === "script" ? a.interpreter || "" : "").localeCompare(
			b.rowKind === "script" ? b.interpreter || "" : "",
		);
	if (rule.key === "path")
		result = (
			a.rowKind === "script"
				? a.scriptRelativePath || ""
				: a.rowKind === "app"
					? a.localDirectoryPath
					: ""
		).localeCompare(
			b.rowKind === "script"
				? b.scriptRelativePath || ""
				: b.rowKind === "app"
					? b.localDirectoryPath
					: "",
		);
	if (rule.key === "params")
		result =
			(a.scriptParameters?.length ?? 0) - (b.scriptParameters?.length ?? 0);
	return rule.direction === "desc" ? -result : result;
}

function sortApps(items: TableRow[], rules: TableSortRule[]): TableRow[] {
	const activeRules = rules.filter((rule) => rule.direction !== "none");
	return items
		.map((app, index) => ({ app, index }))
		.sort((a, b) => {
			for (const rule of activeRules) {
				const result = compareByRule(a.app, b.app, rule);
				if (result !== 0) return result;
			}
			return a.index - b.index;
		})
		.map(({ app }) => app);
}

export function uiTestTabEnabled(
	env: NodeJS.ProcessEnv = process.env,
): boolean {
	return env.DEVENV_UI_TEST === "true";
}

export function createAppStore(env: NodeJS.ProcessEnv = process.env) {
	const [apps, setApps] = createSignal<App[]>([]);
	const [infraServices, setInfraServices] = createSignal<InfraService[]>([]);
	const [kubernetesClusterStatus, setKubernetesClusterStatus] =
		createSignal<KubernetesClusterStatus | null>(null);
	const [kubernetesClusterLoading, setKubernetesClusterLoading] =
		createSignal(false);
	const [kubernetesClusterError, setKubernetesClusterError] = createSignal<
		string | null
	>(null);
	const [kubernetesCPUHistory, setKubernetesCPUHistory] = createSignal<
		number[]
	>([]);
	const [kubernetesMemoryHistory, setKubernetesMemoryHistory] = createSignal<
		number[]
	>([]);

	// Panel focus navigation (Kubernetes tab)
	const [kubernetesPanelIndex, setKubernetesPanelIndex] = createSignal(0);
	const kubernetesScrollBoxRefs: (ScrollBoxRenderable | undefined)[] = [];
	const [loading, setLoading] = createSignal(true);
	const [error, setError] = createSignal<string | null>(null);
	const [viewStack, setViewStack] = createSignal<ViewRoute[]>([
		{ mode: "table" },
	]);
	const [modalStack, setModalStack] = createSignal<ModalRoute[]>([]);
	const viewMode = () => viewStack().at(-1)?.mode ?? "table";
	const replaceView = (mode: ViewMode) => {
		setViewStack((stack) =>
			stack.length === 0 ? [{ mode }] : [...stack.slice(0, -1), { mode }],
		);
	};
	const pushView = (mode: ViewMode) => {
		setViewStack((stack) => {
			const current = stack.at(-1)?.mode;
			if (current === mode) return stack;
			return [...stack, { mode }];
		});
	};
	const popView = (): ViewMode => {
		let nextMode: ViewMode = "table";
		setViewStack((stack) => {
			if (stack.length <= 1) {
				nextMode = "table";
				return [{ mode: "table" }];
			}
			const next = stack.slice(0, -1);
			nextMode = next.at(-1)?.mode ?? "table";
			return next;
		});
		return nextMode;
	};
	const resetViewStack = (mode: ViewMode = "table") => setViewStack([{ mode }]);
	const canGoBack = () => viewStack().length > 1;
	const setViewMode = replaceView;
	const pushModal = (name: string) => {
		setModalStack((stack) =>
			stack.at(-1)?.name === name
				? stack
				: [...stack.filter((route) => route.name !== name), { name }],
		);
	};
	const popModal = (name?: string): string | undefined => {
		let popped: string | undefined;
		setModalStack((stack) => {
			if (stack.length === 0) return stack;
			if (!name) {
				popped = stack.at(-1)?.name;
				return stack.slice(0, -1);
			}
			popped = name;
			return stack.filter((route) => route.name !== name);
		});
		return popped;
	};
	const resetModalStack = () => setModalStack([]);
	const activeModal = () => modalStack().at(-1)?.name ?? "none";
	const syncModalStack = (openModals: string[]) => {
		const openSet = new Set(openModals);
		setModalStack((stack) => {
			const kept = stack.filter((route) => openSet.has(route.name));
			const known = new Set(kept.map((route) => route.name));
			const added = openModals
				.filter((name) => !known.has(name))
				.map((name) => ({ name }));
			const next = [...kept, ...added];
			if (
				next.length === stack.length &&
				next.every((route, index) => route.name === stack[index]?.name)
			)
				return stack;
			return next;
		});
	};
	const showUiTestTab = uiTestTabEnabled(env);
	const [activeTab, setActiveTab] = createSignal<TabType>("applications");
	const [selectedIndex, setSelectedIndex] = createSignal(0);
	const [liveUpdatesActive, setLiveUpdatesActive] = createSignal(false);
	const [lastUpdateTime, setLastUpdateTime] = createSignal<Date | null>(null);
	const [previousViewMode, setPreviousViewMode] = createSignal<ViewMode | null>(
		"table",
	);
	const [helpSearchActive, setHelpSearchActive] = createSignal(false);
	const [helpSearchQuery, setHelpSearchQuery] = createSignal("");
	const [helpAllContexts, setHelpAllContexts] = createSignal(false);
	const [helpActiveTab, setHelpActiveTab] = createSignal<"keybinds" | "guides">(
		"keybinds",
	);
	const [helpGuideIndex, setHelpGuideIndex] = createSignal(-1);
	const [tableSearchMode, setTableSearchMode] = createSignal(false);
	const [tableSearchQuery, setTableSearchQuery] = createSignal("");
	const [showTableFilterModal, setShowTableFilterModal] = createSignal(false);
	const [tableFilterParameterIndex, setTableFilterParameterIndex] =
		createSignal(0);
	const [tableFilterValueIndex, setTableFilterValueIndex] = createSignal(0);
	const [tableFilterFocusedPane, setTableFilterFocusedPane] = createSignal<
		"parameter" | "value"
	>("parameter");
	const [tableFiltersByTab, setTableFiltersByTab] = createSignal<
		Record<TabType, Record<string, string[]>>
	>({
		applications: {},
		infrastructure: {},
		libraries: {},
		scripts: {},
		kubernetes: {},
		"ui-test": {},
	});
	const [showTableSortModal, setShowTableSortModal] = createSignal(false);
	const [tableSortSelectedIndex, setTableSortSelectedIndex] = createSignal(0);
	const appSortRules = (): TableSortRule[] => [
		{ key: "status", label: "Status", direction: "none" },
		{ key: "git", label: "Git", direction: "none" },
		{ key: "name", label: "Name", direction: "none" },
	];
	const scriptSortRules = (): TableSortRule[] => [
		{ key: "name", label: "Name", direction: "asc" },
		{ key: "interpreter", label: "Interpreter", direction: "none" },
		{ key: "params", label: "Parameters", direction: "none" },
		{ key: "path", label: "Path", direction: "none" },
	];
	const [tableSortRulesByTab, setTableSortRulesByTab] = createSignal<
		Record<TabType, TableSortRule[]>
	>({
		applications: appSortRules(),
		infrastructure: appSortRules(),
		libraries: appSortRules(),
		scripts: scriptSortRules(),
		kubernetes: appSortRules(),
		"ui-test": appSortRules(),
	});
	const [operationInProgressForApp, setOperationInProgressForApp] =
		createSignal<string | null>(null);
	const hasActiveOperation = createMemo(() =>
		apps().some((app) => app.operationStatus?.status === "active"),
	);
	const [startupState, setStartupState] = createSignal<StartupState>({
		phase: "connecting",
		message: "Connecting to DevEnv server...",
		error: null,
	});
	const [isShuttingDown, setIsShuttingDown] = createSignal(false);
	const [shutdownState, setShutdownState] = createSignal<ShutdownState>({
		phase: "idle",
		message: "",
		error: null,
	});
	const [scriptsTree, setScriptsTree] = createSignal<ScriptNode[]>([]);
	const [firstStepsDismissed, setFirstStepsDismissed] = createSignal(false);
	const [exampleConfigLoading, setExampleConfigLoading] = createSignal(false);
	const [exampleConfigMessage, setExampleConfigMessage] = createSignal<
		string | null
	>(null);
	const [firstStepsSelectedIndex, setFirstStepsSelectedIndex] = createSignal(0);
	const [expandedScriptFolders, setExpandedScriptFolders] = createSignal<
		Set<string>
	>(new Set());

	const scriptVisibleRows = createMemo(() =>
		flattenScriptTree(scriptsTree(), expandedScriptFolders()),
	);

	const scriptRows = createMemo<TableRow[]>(() =>
		scriptVisibleRows().map(
			(row): TableRow => ({
				rowKind: "script",
				ident: `script:${row.relativePath}`,
				displayName: row.name,
				localDirectoryPath: row.absolutePath,
				repositoryPath: "",
				branch: row.nodeType === "script" ? row.interpreter || "" : "folder",
				nodeType: row.nodeType,
				resourceType:
					row.nodeType === "folder" ? "script-folder" : "script-file",
				scriptPath: row.absolutePath,
				scriptRelativePath: row.relativePath,
				scriptDepth: row.depth,
				scriptExpanded:
					row.nodeType === "folder"
						? expandedScriptFolders().has(row.relativePath)
						: undefined,
				scriptExecutable: row.nodeType === "script",
				interpreter: row.interpreter,
				scriptParameters: row.parameters,
			}),
		),
	);

	const appFilterValue = (app: TableRow, key: string) => {
		if (key === "status")
			return runtimeState(
				app.runtimeStatus,
				app.status || app.dockerInfo?.Status,
			);
		if (key === "git" && app.rowKind === "app")
			return appGitRank(app) === 0
				? "dirty"
				: app.gitStatus === "✓"
					? "clean"
					: "unknown";
		if (key === "provider" && app.rowKind === "app")
			return app.provider || app.sourceType || "unknown";
		if (key === "interpreter" && app.rowKind === "script")
			return (
				app.interpreter || (app.nodeType === "folder" ? "folder" : "unknown")
			);
		if (key === "params") {
			const count = app.scriptParameters?.length ?? 0;
			if (count === 0) return "none";
			if (count === 1) return "1 parameter";
			return "2+ parameters";
		}
		return "";
	};

	const tableFilters = createMemo(() => tableFiltersByTab()[activeTab()]);
	const setTableFilters = (
		value:
			| Record<string, string[]>
			| ((filters: Record<string, string[]>) => Record<string, string[]>),
	) => {
		const tab = activeTab();
		setTableFiltersByTab((byTab) => ({
			...byTab,
			[tab]: typeof value === "function" ? value(byTab[tab]) : value,
		}));
	};
	const tableSortRules = createMemo(() => tableSortRulesByTab()[activeTab()]);
	const setTableSortRules = (
		value: TableSortRule[] | ((rules: TableSortRule[]) => TableSortRule[]),
	) => {
		const tab = activeTab();
		setTableSortRulesByTab((byTab) => ({
			...byTab,
			[tab]: typeof value === "function" ? value(byTab[tab]) : value,
		}));
	};

	const applyTableFilters = (items: TableRow[]) => {
		const filters = tableFilters();
		return items.filter((app) =>
			Object.entries(filters).every(
				([key, values]) =>
					values.length === 0 || values.includes(appFilterValue(app, key)),
			),
		);
	};

	const filteredAppsUnsorted = createMemo(() => {
		const allApps = apps();
		const tab = activeTab();
		if (tab === "applications")
			return allApps
				.filter((app) => app.appType === "APP")
				.map((app) => ({ ...app, rowKind: "app" as const }));
		if (tab === "libraries")
			return allApps
				.filter((app) => app.appType === "LIB")
				.map((app) => ({ ...app, rowKind: "app" as const }));
		if (tab === "scripts") return scriptRows();
		if (tab === "kubernetes" || tab === "ui-test") return [];
		if (tab === "infrastructure") {
			return infraServices().map(
				(svc): TableRow => ({
					rowKind: "infra",
					ident: svc.ident,
					displayName: svc.displayName,
					localDirectoryPath: "",
					repositoryPath: "",
					branch: "",
					containerBaseName: svc.containerBaseName || svc.ident,
					dockerInfo: svc.dockerInfo,
					operationStatus: svc.operationStatus,
					runtimeStatus: svc.runtimeStatus,
					status: svc.status,
					type: svc.type,
					shellPath: svc.shellPath,
					powerShellPath: svc.powerShellPath,
					defaultRunner: svc.defaultRunner,
					logPath: svc.logPath,
				}),
			);
		}
		return allApps.map((app) => ({ ...app, rowKind: "app" as const }));
	});

	const tableFilterParameters = createMemo(() => {
		const base = filteredAppsUnsorted();
		const params =
			activeTab() === "scripts"
				? [
						{ key: "interpreter", label: "Interpreter" },
						{ key: "params", label: "Parameters" },
					]
				: [
						{ key: "status", label: "Status" },
						{ key: "git", label: "Git" },
						{ key: "provider", label: "Provider" },
					];
		return params.map((param) => {
			const counts = new Map<string, number>();
			for (const app of base) {
				const value = appFilterValue(app, param.key);
				counts.set(value, (counts.get(value) ?? 0) + 1);
			}
			return {
				...param,
				values: Array.from(counts.entries()).map(([value, count]) => ({
					value,
					label: value,
					count,
				})),
			};
		});
	});

	const filteredApps = createMemo(() =>
		sortApps(applyTableFilters(filteredAppsUnsorted()), tableSortRules()),
	);

	const tableFilteredApps = createMemo(() => {
		const q = tableSearchQuery().trim().toLowerCase();
		const filtered = applyTableFilters(filteredAppsUnsorted());
		const items = q
			? filtered.filter((app) => tableSearchText(app).includes(q))
			: filtered;
		return sortApps(items, tableSortRules());
	});

	const showFirstSteps = createMemo(
		() =>
			!firstStepsDismissed() &&
			startupState().phase === "complete" &&
			apps().length === 0 &&
			infraServices().length === 0 &&
			scriptVisibleRows().length === 0,
	);

	const tableTabs = createMemo((): TableTab<TabType>[] => {
		const allApps = apps();
		return [
			{
				id: "applications",
				label: "Applications",
				count: allApps.filter((app) => app.appType === "APP").length,
			},
			{
				id: "infrastructure",
				label: "Infrastructure",
				count: infraServices().length,
			},
			{
				id: "libraries",
				label: "Libraries",
				count: allApps.filter((app) => app.appType === "LIB").length,
			},
			{ id: "scripts", label: "Tasks", count: scriptVisibleRows().length },
			{
				id: "kubernetes",
				label: "Kubernetes",
				count: kubernetesClusterStatus()?.exists ? 1 : 0,
			},
			...(showUiTestTab ? [{ id: "ui-test" as const, label: "UI Test" }] : []),
		];
	});

	const setAllScriptFoldersExpanded = () => {
		setExpandedScriptFolders(new Set(folderPaths(scriptsTree())));
	};

	return {
		apps,
		setApps,
		infraServices,
		setInfraServices,
		kubernetesClusterStatus,
		setKubernetesClusterStatus,
		kubernetesClusterLoading,
		setKubernetesClusterLoading,
		kubernetesClusterError,
		setKubernetesClusterError,
		kubernetesCPUHistory,
		setKubernetesCPUHistory,
		kubernetesMemoryHistory,
		setKubernetesMemoryHistory,

		// Panel focus navigation (Kubernetes tab)
		kubernetesPanelIndex,
		setKubernetesPanelIndex,
		kubernetesPanelCount: KUBERNETES_PANEL_COUNT,
		get kubernetesScrollBoxRefs() {
			return kubernetesScrollBoxRefs;
		},
		loading,
		startupState,
		setStartupState,
		isShuttingDown,
		setIsShuttingDown,
		shutdownState,
		setShutdownState,
		setLoading,
		error,
		setError,
		viewMode,
		setViewMode,
		viewStack,
		setViewStack,
		modalStack,
		setModalStack,
		pushModal,
		popModal,
		resetModalStack,
		activeModal,
		syncModalStack,
		pushView,
		replaceView,
		popView,
		resetViewStack,
		canGoBack,
		activeTab,
		setActiveTab,
		selectedIndex,
		setSelectedIndex,
		liveUpdatesActive,
		setLiveUpdatesActive,
		lastUpdateTime,
		setLastUpdateTime,
		previousViewMode,
		setPreviousViewMode,
		helpSearchActive,
		setHelpSearchActive,
		helpSearchQuery,
		setHelpSearchQuery,
		helpAllContexts,
		setHelpAllContexts,
		helpActiveTab,
		setHelpActiveTab,
		helpGuideIndex,
		setHelpGuideIndex,
		tableSearchMode,
		setTableSearchMode,
		tableSearchQuery,
		setTableSearchQuery,
		showTableFilterModal,
		setShowTableFilterModal,
		tableFilterParameterIndex,
		setTableFilterParameterIndex,
		tableFilterValueIndex,
		setTableFilterValueIndex,
		tableFilterFocusedPane,
		setTableFilterFocusedPane,
		tableFilters,
		setTableFilters,
		tableFilterParameters,
		showTableSortModal,
		setShowTableSortModal,
		tableSortSelectedIndex,
		setTableSortSelectedIndex,
		tableSortRules,
		setTableSortRules,
		operationInProgressForApp,
		setOperationInProgressForApp,
		hasActiveOperation,
		scriptsTree,
		setScriptsTree,
		firstStepsDismissed,
		setFirstStepsDismissed,
		exampleConfigLoading,
		setExampleConfigLoading,
		exampleConfigMessage,
		setExampleConfigMessage,
		firstStepsSelectedIndex,
		setFirstStepsSelectedIndex,
		showFirstSteps,
		expandedScriptFolders,
		setExpandedScriptFolders,
		scriptVisibleRows,
		setAllScriptFoldersExpanded,
		filteredApps,
		tableFilteredApps,
		tableTabs,
	};
}

export type AppStore = ReturnType<typeof createAppStore>;
