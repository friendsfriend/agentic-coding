/** @jsxImportSource @opentui/solid */

import { join } from "node:path";
import type { Renderable } from "@opentui/core";
import { type KeyEvent, TextAttributes } from "@opentui/core";
import type { Keymap } from "@opentui/keymap";
import { useRenderer, useTerminalDimensions } from "@opentui/solid";
import {
	createEffect,
	createMemo,
	createSignal,
	type JSX,
	onCleanup,
	onMount,
} from "solid-js";
import type { ProjectOption } from "../../../workflow/project-catalog";
import {
	fetchProjectCatalog,
	projectCanonicalRoots,
	syncCatalogWatchers,
} from "../../../workflow/project-catalog";
import {
	researchWorkflowTarget,
	wikiWorkflowDataRoot,
} from "../../../workflow/runtime";
import type { WikiReviewComment } from "../../../workflow/wiki";
import { copyToClipboard } from "../../clipboard";
import { App as DashApp } from "../../dash/App";
import {
	startSidebarPresentation,
	startWikiCommentWorkflowInProcess,
} from "../../dash/engine";
import { Home as DashHome } from "../../dash/Home";
import {
	registerShellFeatureField,
	registerShellKeyLayer,
} from "../../dash/keymap-setup";
import {
	discoverProjectsAsync,
	listWorkflowsAsync,
} from "../../dash/observations";
import { isKeyTraceSuppressed, traceTui } from "../../dash/tracing";
import type { WorkflowOverview } from "../../dash/types";
import { Header } from "../../dash/ui/Header";
import { watchDirectories } from "../../dash/watchRefresh";
import { phase } from "../../lifecycle";
import { ErrorModalOverlay } from "../../shared/ErrorModalOverlay";
import {
	activeErrorModal,
	dismissErrorModal,
	showErrorModal,
} from "../../shared/errorModal";
import { HelpModal } from "../../shared/HelpModal";
import {
	activeKeybindCatalog,
	type KeybindSection,
	setActiveKeybindCatalog,
} from "../../shared/keybinds";
import { ModalHelpOverlay } from "../../shared/ModalHelpOverlay";
import {
	closeModalHelp,
	handleModalHelpKey,
	modalHelpOpen,
} from "../../shared/modalHelp";
import {
	createModalStackState,
	registerFocusRestorer,
} from "../../shared/modalStack";
import {
	createFeatureNavigation,
	createFeatureRouterState,
	type FeatureId,
	type FeatureRoute,
} from "../../shared/routes";
import { Badge } from "../components/Badge";
import { HighlightedText } from "../components/Highlight";
import { NotificationOverlay } from "../components/Notification";
import { StatusBar } from "../components/StatusBar";
import { TabBar } from "../components/TabBar";
import { ThemePickerModal } from "../components/ThemePickerModal";
import {
	FilterModal,
	SortModal,
	statusOptions,
} from "../components/TraceModals";
import type { TraceDb } from "../model/db";
import type { LogStore } from "../model/logStore";
import type { MetricStore } from "../model/metricStore";
import type { TopologyStore } from "../model/topologyStore";
import type { SortCriterion, TraceStore } from "../model/traceStore";
import type { TreeNode } from "../model/types";
import { uiColors } from "../ui/colors";
import { LogDetailView } from "../views/LogDetailView";
import { LogsView } from "../views/LogsView";
import { MetricDetailView } from "../views/MetricDetailView";
import { MetricsView } from "../views/MetricsView";
import { ServiceDetailView } from "../views/ServiceDetailView";
import { SpanDetailView } from "../views/SpanDetailView";
import { TopologyView } from "../views/TopologyView";
import { TraceListView } from "../views/TraceListView";
import { TraceTreeView } from "../views/TraceTreeView";
import {
	WikiView,
	wikiCommentEntryActive,
	wikiNoteActive,
} from "../views/WikiView";
import {
	environmentsKeybindCatalog,
	observabilityKeybindCatalog,
} from "./keybinds";
import { createNavigation } from "./navigation";
import { notify } from "./notifications";
import {
	applyTheme,
	getActiveThemeName,
	loadThemeName,
	saveThemeName,
	themeNames,
} from "./theme";

type Tab =
	| "environments"
	| "workflow"
	| "wiki"
	| "traces"
	| "metrics"
	| "logs"
	| "topology";
type Workspace = { changeId: string; path: string; spanCount: number };

export interface WorkflowHeaderInfo {
	change: string;
	phase: string;
	branch: string;
	updated: string;
}

export interface DashboardTab {
	mode: "home" | "dash";
	repo?: string;
	change?: string;
	profile?: string;
	keymap: Keymap<Renderable, KeyEvent>;
	/** Workflow header context pushed up from the dashboard tab content. */
}

export function App(props: {
	repos: string[];
	db: TraceDb;
	traceStore: TraceStore;
	metricStore: MetricStore;
	logStore: LogStore;
	topologyStore: TopologyStore;
	tracesOnly?: boolean;
	/** When set, the unified shell exposes the Environments feature. */
	environments?: { serverUrl: string };
	/** Composition hook supplied by the shell root (src/tui/app) so this feature
	 * layer never imports the tui-app shell (source-layer boundary). The shell
	 * root passes a callback the embedded environment uses to publish its live
	 * command registrations (task 3.6). */
	renderEnvironments?: (
		onCatalog: (catalog: KeybindSection[]) => void,
		active: () => boolean,
		onModalChange: (open: boolean) => void,
	) => JSX.Element;
	/** When set, a Workflow tab is prepended that renders the dashboard. */
	dashboard?: DashboardTab;
}) {
	const renderer = useRenderer();
	const dimensions = useTerminalDimensions();
	const nav = createNavigation();
	const [helpOffset, setHelpOffset] = createSignal(0);
	const helpLines = () =>
		Math.max(5, Math.floor(dimensions().height * 0.78) - 5);
	const helpMaxOffset = () =>
		Math.max(
			0,
			activeKeybindCatalog().reduce(
				(count, section) => count + section.keybinds.length + 1,
				0,
			) - helpLines(),
		);
	// Typed feature router (compose-unified-feature-shell task 2.2): the shell's
	// active feature, per-feature history and cross-feature origin live here
	// instead of a flat signal, so `back()` restores the originating resource.
	const initialFeature: FeatureId = props.dashboard
		? "workflows"
		: props.environments
			? "environments"
			: "observability";
	const initialRoot: FeatureRoute =
		initialFeature === "workflows"
			? {
					feature: "workflows",
					view: props.dashboard?.mode === "dash" ? "detail" : "home",
				}
			: initialFeature === "environments"
				? { feature: "environments", view: "applications" }
				: { feature: "observability", view: "traces" };
	const router = createFeatureNavigation(
		createFeatureRouterState(initialFeature, initialRoot),
	);
	const activeFeature = (): FeatureId => router.active();
	const disposeShellFeatureField = props.dashboard
		? registerShellFeatureField(props.dashboard.keymap)
		: undefined;
	onCleanup(() => disposeShellFeatureField?.());
	createEffect(() => {
		props.dashboard?.keymap.setData("shell.feature", activeFeature());
	});
	// The legacy flat tab is a projection of the active route identity so the
	// existing observability content keeps one switch surface.
	const activeTab = (): Tab => {
		switch (router.route().feature) {
			case "environments":
				return "environments";
			case "workflows":
				return "workflow";
			case "wiki":
				return "wiki";
			default: {
				const view = router.route().view;
				return view === "metrics" || view === "logs" || view === "topology"
					? view
					: "traces";
			}
		}
	};
	// The observability feature's remembered sub-tab (its preserved stack top).
	const observabilityTab = (): "traces" | "metrics" | "logs" | "topology" => {
		const view = router.state().stacks.observability.at(-1)?.view;
		return view === "metrics" || view === "logs" || view === "topology"
			? view
			: "traces";
	};
	const routeForFeature = (feature: FeatureId): FeatureRoute => {
		if (feature === "environments") return { feature, view: "applications" };
		if (feature === "workflows")
			return {
				feature,
				view: props.dashboard?.mode === "dash" ? "detail" : "home",
			};
		if (feature === "wiki") return { feature, view: "browse" };
		return { feature, view: observabilityTab() };
	};
	// Workflow header context pushed up from the dashboard tab content (single source
	// of truth; the dashboard polls, the shell renders). Null in home mode / before data.
	const [workflowHeader, setWorkflowHeader] =
		createSignal<WorkflowHeaderInfo | null>(null);
	// Review comments deliberately live above the conditional tab content so
	// closing a note or switching tabs cannot discard the in-memory session.
	const [wikiComments, setWikiComments] = createSignal<WikiReviewComment[]>([]);
	const [wikiSubmitting, setWikiSubmitting] = createSignal(false);
	// Live command catalog published by the embedded environment feature; when
	// present the shell footer/help project the real registrations (task 3.6).
	const [environmentCatalog, setEnvironmentCatalog] = createSignal<
		KeybindSection[] | undefined
	>();

	// Home mode: the shell owns the workspace list — loaded in the background at
	// startup and kept fresh, so visiting the Workflow tab never reloads or shows
	// the loading indicator again.
	const [homeItems, setHomeItems] = createSignal<WorkflowOverview[]>([]);
	const [homeLoading, setHomeLoading] = createSignal(true);
	const [homeProjects, setHomeProjects] = createSignal<ProjectOption[]>([]);
	let homeLoadRunning = false;
	let homeLoadQueued = false;
	let homeDisposed = false;
	let homeController: AbortController | undefined;
	// Last observation failure surfaced in the error modal; deduped so the 30s
	// safety re-sync and directory events cannot reopen it for the same message.
	let lastHomeError: string | undefined;
	/** Stable repository source for the sidebar presentation owner: the same
	 * closure identity across every home refresh, reading the current list
	 * lazily, so the custom view is installed once per connection. */
	const homeSidebarRepos = (): readonly string[] => [
		...(props.dashboard?.repo ? [props.dashboard.repo] : []),
		...homeItems()
			.map((item) => item.state.repository)
			.filter(Boolean),
		wikiWorkflowDataRoot(),
		researchWorkflowTarget(),
	];
	const loadHome = () => {
		if (homeDisposed) return;
		if (homeLoadRunning) {
			homeLoadQueued = true;
			return;
		}
		homeLoadRunning = true;
		homeController?.abort();
		homeController = new AbortController();
		void Promise.all([
			listWorkflowsAsync(homeController.signal),
			discoverProjectsAsync(homeController.signal),
		])
			.then(([items, projects]) => {
				if (homeDisposed) return;
				lastHomeError = undefined;
				setHomeItems(items);
				setHomeProjects(projects);
				setHomeLoading(false);
				traceTui("tui.overview.refresh", {
					surface: "overview",
					action: "refresh",
				});
			})
			.catch((error) => {
				if (!homeDisposed) {
					const message =
						error instanceof Error ? error.message : String(error);
					if (message !== lastHomeError) {
						lastHomeError = message;
						showErrorModal("Observation failed", message);
					}
					setHomeLoading(false);
					traceTui(
						"tui.overview.refresh",
						{ surface: "overview", action: "refresh" },
						"error",
					);
				}
			})
			.finally(() => {
				homeLoadRunning = false;
				if (homeLoadQueued && !homeDisposed) {
					homeLoadQueued = false;
					loadHome();
				}
			});
	};
	createEffect(() => {
		if (props.dashboard?.mode !== "home") return;
		loadHome();
		// ponytail: 30s safety re-sync also discovers brand-new workflows.
		const safety = setInterval(loadHome, 30000);
		onCleanup(() => {
			homeDisposed = true;
			homeController?.abort();
			// Execution coordinators and the shared application runtime are
			// root-owned; only the shell's teardown disposes them (task 1.2/1.3).
			clearInterval(safety);
		});
	});
	createEffect(() => {
		if (props.dashboard?.mode !== "home") return;
		const dirs = homeItems().map((item) =>
			item.state.definition?.id === "wiki-comments" ||
			item.state.definition?.id === "research"
				? join(wikiWorkflowDataRoot(), item.state.changeId)
				: join(item.state.worktree, ".herdr-workflow", item.state.changeId),
		);
		const dispose = watchDirectories(dirs, loadHome);
		onCleanup(dispose);
	});
	const [selectedListIndex, setSelectedListIndex] = createSignal(0);
	const [_selectedTraceId, setSelectedTraceId] = createSignal<string>();
	const [treeRoots, setTreeRoots] = createSignal<TreeNode[]>([]);
	const [treeIndex, setTreeIndex] = createSignal(0);
	const [selectedSpan, setSelectedSpan] = createSignal<TreeNode>();
	const [activeWorkspace, setActiveWorkspace] = createSignal<string>();
	const [workspaces, setWorkspaces] = createSignal<Workspace[]>([]);
	const [_spanCount, setSpanCount] = createSignal(0);
	const [filteredCount, setFilteredCount] = createSignal(0);
	const [themeIndex, setThemeIndex] = createSignal(
		Math.max(0, themeNames.indexOf(loadThemeName())),
	);
	const [themeQuery, setThemeQuery] = createSignal("");
	const [themeFiltering, setThemeFiltering] = createSignal(false);
	const filteredThemes = () =>
		themeNames.filter((name) => name.includes(themeQuery().toLowerCase()));
	const [lastQuit, setLastQuit] = createSignal(0);
	const [dataVersion, setDataVersion] = createSignal(0);
	const [filterPane, setFilterPane] = createSignal<"criteria" | "values">(
		"criteria",
	);
	const [filterCriterion, setFilterCriterion] = createSignal(0);
	const [filterStatusIndex, setFilterStatusIndex] = createSignal(0);
	const [filterWorkspaceIndex, setFilterWorkspaceIndex] = createSignal(0);
	const [sortIndex, setSortIndex] = createSignal(0);
	const [sortDraft, setSortDraft] = createSignal<SortCriterion[]>(
		props.traceStore.sortCriteria_,
	);
	const [searchMode, setSearchMode] = createSignal(false);
	const [searchQuery, setSearchQuery] = createSignal("");
	let searchPrevious = "";

	// ― Metric/Log detail state ―
	const [selectedMetricIndex, setSelectedMetricIndex] = createSignal(0);
	const [selectedMetric, setSelectedMetric] = createSignal<{
		name: string;
		serviceName: string;
	}>();
	const [selectedLogIndex, setSelectedLogIndex] = createSignal(0);
	const [selectedLog, setSelectedLog] = createSignal<number | undefined>();
	const [selectedTopologyService, setSelectedTopologyService] =
		createSignal<string>();
	const [topologyDetail, setTopologyDetail] = createSignal<string>();
	const [logFilterQuery, setLogFilterQuery] = createSignal("");

	const db = props.db;
	const traceStore = props.traceStore;
	const metricStore = props.metricStore;
	const logStore = props.logStore;
	const topologyStore = props.topologyStore;

	setWorkspaces(db.getWorkspaces());
	setSpanCount(traceStore.spanCount_);
	setFilteredCount(traceStore.filteredCount_);

	const summaries = createMemo(() => {
		dataVersion();
		return traceStore.getTraceSummaries();
	});
	const flatTree = createMemo(() => {
		const walk = (
			nodes: TreeNode[],
			parents: number[],
		): Array<{ node: TreeNode; path: number[] }> =>
			nodes.flatMap((node, index) => {
				const path = [...parents, index];
				return [
					{ node, path },
					...(node.expanded ? walk(node.children, path) : []),
				];
			});
		return walk(treeRoots(), []);
	});
	const refresh = () => {
		setDataVersion((v) => v + 1);
		setSpanCount(traceStore.spanCount_);
		setFilteredCount(traceStore.filteredCount_);
	};

	function selectTrace(index: number) {
		const trace = summaries()[index];
		if (!trace) return;
		setSelectedListIndex(index);
		setSelectedTraceId(trace.traceId);
		const roots = traceStore.getSpanTree(trace.traceId);
		setTreeRoots(roots);
		setTreeIndex(0);
		setSelectedSpan(roots[0]);
		nav.pushView("detail");
	}

	function selectTree(path: number[]) {
		const index = flatTree().findIndex(
			(item) => item.path.join(".") === path.join("."),
		);
		if (index < 0) return;
		setTreeIndex(index);
		setSelectedSpan(flatTree()[index]?.node);
	}

	function setNodeExpanded(path: number[], expanded: boolean) {
		let node: TreeNode | undefined;
		let nodes = treeRoots();
		for (const index of path) {
			node = nodes[index];
			if (!node) return;
			nodes = node.children;
		}
		if (!node) return;
		node.expanded = expanded;
		setTreeRoots([...treeRoots()]);
		const current =
			flatTree()[Math.min(treeIndex(), Math.max(0, flatTree().length - 1))];
		if (current) setSelectedSpan(current.node);
	}

	function switchWorkspace(changeId?: string) {
		setActiveWorkspace(changeId);
		traceStore.loadFile(db.loadSpans(changeId));
		setSelectedListIndex(0);
		setSelectedTraceId(undefined);
		setTreeRoots([]);
		setSelectedSpan(undefined);
		nav.popView();
		refresh();
	}

	async function finishWikiReview(
		comments: readonly WikiReviewComment[],
	): Promise<string> {
		const message = startWikiCommentWorkflowInProcess(comments);
		loadHome();
		return message;
	}

	function featureForTab(tab: Tab): FeatureId {
		if (tab === "environments") return "environments";
		if (tab === "workflow") return "workflows";
		if (tab === "wiki") return "wiki";
		return "observability";
	}

	function switchTab(tab: Tab) {
		const feature = featureForTab(tab);
		if (feature === "observability") {
			// Sub-tabs are siblings: replace the observability route rather than
			// growing per-feature history with every signal tab.
			router.setRoute({ feature, view: tab });
		} else {
			router.switchFeature(feature);
		}
		nav.popView();
		// Topology data already loaded in index.tsx; no reload needed
	}

	onMount(() => {
		const prune = () => {
			const removed = db.cleanupOlderThan();
			if (!removed) return;
			setWorkspaces(db.getWorkspaces());
			traceStore.loadFile(db.loadSpans(activeWorkspace()));
			setSelectedListIndex(0);
			refresh();
			notify(`Pruned ${removed} spans older than 30 days`, "info");
		};
		const dailyPrune = setInterval(prune, 86_400_000);
		const onNew = (changeId: string) => {
			setWorkspaces(db.getWorkspaces());
			if (!activeWorkspace() || activeWorkspace() === changeId) {
				traceStore.loadFile(db.loadSpans(activeWorkspace()));
				refresh();
			}
		};
		// Watch registrations are diffed by canonical root: a configured-project
		// change adds or stops discovery watchers without touching histories or
		// active workflows.
		const watched = new Map<string, () => void>();
		const applyCatalogRoots = (roots: string[]) =>
			syncCatalogWatchers(watched, roots, (root) =>
				db.watchWorkspaces(root, onNew),
			);
		// Explicit `--repo`/wiki/research roots are always watched; catalog
		// canonical roots are added on top, so a catalog poll can never drop the
		// watcher for a repository that is not a configured catalog project.
		const applyRootsWithExplicit = (roots: string[]) =>
			applyCatalogRoots([...props.repos, ...roots]);
		applyRootsWithExplicit([]);
		// The backend emits `catalog.changed`; polling its revision keeps the
		// watcher set correct even when the event stream is not subscribed.
		const catalogUrl = props.environments?.serverUrl;
		let catalogDisposed = false;
		const catalogController = new AbortController();
		const refreshCatalogRoots = () => {
			if (!catalogUrl || catalogDisposed) return;
			void fetchProjectCatalog({
				baseUrl: catalogUrl,
				signal: catalogController.signal,
			})
				.then((catalog) => {
					if (catalogDisposed) return;
					applyRootsWithExplicit(projectCanonicalRoots(catalog));
				})
				.catch(() => {});
		};
		// Seed catalog watchers immediately after first paint; the interval keeps
		// them in sync with configuration changes.
		refreshCatalogRoots();
		const catalogPoll = catalogUrl
			? setInterval(refreshCatalogRoots, 15_000)
			: undefined;
		// The long-lived presentation owner: one stable registration per shell
		// mount so sidebar cards are rebuilt from current views plus live Herdr
		// reads, never re-registered (or its custom view reasserted) on refresh
		// (improve-herdr-workflow-sidebar).
		const stopSidebarPresentation = startSidebarPresentation(homeSidebarRepos);
		// The initial history load and live OTLP receiver pushes mutate the store
		// directly (shell-owned), so refresh the mounted views on every change.
		const unsubscribeTraceStore = traceStore.onChange(refresh);
		// Focus restoration (task 3.1): when an overlay closes, return key
		// ownership to the underlying view by clearing the parked modal state.
		const disposeFocusRestorers = [
			"environments",
			"workflows",
			"observability",
			"wiki",
		].map((id) =>
			registerFocusRestorer(id, () => {
				props.dashboard?.keymap.setData("modal.active", "none");
			}),
		);
		// The TraceDb is owned by the shell (index.tsx) for the process lifetime;
		// remounting this view must not close it. Only stop this view's watchers.
		onCleanup(() => {
			catalogDisposed = true;
			catalogController.abort();
			clearInterval(dailyPrune);
			if (catalogPoll) clearInterval(catalogPoll);
			for (const stop of watched.values()) stop();
			watched.clear();
			stopSidebarPresentation();
			unsubscribeTraceStore();
			for (const dispose of disposeFocusRestorers) dispose();
		});
	});

	const copySelection = (reportEmpty = false) => {
		const text = renderer.getSelection()?.getSelectedText() ?? "";
		if (!text) {
			if (reportEmpty) notify("No selection to copy", "warning");
			return;
		}
		const copied = copyToClipboard(text);
		notify(
			copied ? "Copied selection" : "Copy failed",
			copied ? "success" : "error",
		);
		renderer.clearSelection();
	};

	const handleKey = (event: KeyEvent) => {
		const key = event.name.toLowerCase();
		const ename = event.name;
		// A global error modal owns every tab: keep it up (and scrollable) until
		// the user dismisses it, even on the observability tabs. The modal's own
		// keymap layer only scrolls; dismissal lives here so the key is consumed
		// once, before it can drive the tab underneath.
		if (activeErrorModal()) {
			if (key === "escape" || key === "enter" || key === "return")
				dismissErrorModal();
			return;
		}
		const traceDashModal = props.dashboard
			? props.dashboard.keymap.getData?.("modal.active")
			: "none";
		// Keystrokes can be character entry (the embedded dashboard's
		// passphrase/askpass prompt, or this pane's own search/filter fields);
		// per-character input must never reach a span, so suppress the
		// diagnostic in exactly those contexts.
		if (
			!isKeyTraceSuppressed({
				anyModalOpen:
					props.dashboard !== undefined &&
					traceDashModal !== undefined &&
					traceDashModal !== "none",
				searchEntry: searchMode(),
				filterEntry: nav.modal() === "theme" && themeFiltering(),
				wikiCommentEntry: wikiCommentEntryActive(),
			})
		) {
			traceTui("tui.observability.key", {
				surface: "observability",
				action: "key",
				key: `${event.ctrl ? "ctrl+" : ""}${key}`,
				view: activeTab(),
				phase: nav.modal() ?? "none",
				modal: traceDashModal,
			});
		}
		// Lifecycle overlay (startup/shutdown modal) consumes keys; 'q' still works
		// via the home keymap layer, which routes it to requestShutdown.
		if (phase() === "starting" || phase() === "stopping") return;

		// Modal `?` help: an open dialog advertises its own `?` entry and opens
		// the shared HelpModal with that dialog's catalog. While it is open,
		// j/k/Esc drive the overlay instead of the dialog underneath.
		if (nav.modal() !== "none") {
			if (modalHelpOpen()) {
				handleModalHelpKey(key);
				return;
			}
			if (key === "?" && handleModalHelpKey(key)) {
				return;
			}
		}

		// Global copy
		if (
			(event.meta && key === "c") ||
			(event.ctrl && event.shift && key === "c")
		) {
			copySelection(true);
			return;
		}

		if (nav.modal() === "theme") {
			const items = filteredThemes();
			if (key === "escape") {
				if (themeFiltering()) {
					setThemeFiltering(false);
					setThemeQuery("");
					setThemeIndex(0);
				} else nav.popModal();
			} else if (key === "/") {
				setThemeFiltering(true);
				setThemeQuery("");
				setThemeIndex(0);
			} else if (themeFiltering() && key === "backspace") {
				setThemeQuery((query) => query.slice(0, -1));
				setThemeIndex(0);
			} else if (themeFiltering() && key.length === 1) {
				setThemeQuery((query) => query + key);
				setThemeIndex(0);
			} else if (key === "j" || key === "down") {
				const next = Math.min(items.length - 1, themeIndex() + 1);
				const item = items[next];
				if (item) {
					setThemeIndex(next);
					applyTheme(item);
				}
			} else if (key === "k" || key === "up") {
				const next = Math.max(0, themeIndex() - 1);
				const item = items[next];
				if (item) {
					setThemeIndex(next);
					applyTheme(item);
				}
			} else if (key === "enter" || key === "return") {
				if (themeFiltering()) setThemeFiltering(false);
				const selected = items[themeIndex()];
				if (selected) {
					saveThemeName(selected);
					nav.popModal();
				}
			}
			return;
		}

		if (nav.modal() === "help") {
			if (key === "escape") {
				nav.popModal();
				// Let the wiki view resume handling keys once the shell help closes.
				if (activeTab() === "wiki")
					props.dashboard?.keymap.setData("modal.active", "none");
			} else if (key === "j" || key === "down")
				setHelpOffset((value) => Math.min(helpMaxOffset(), value + 1));
			else if (key === "k" || key === "up")
				setHelpOffset((value) => Math.max(0, value - 1));
			return;
		}

		// Tab switching (global, except when in a modal). In the unified shell the
		// keys address the rendered rows: features for Tab/`t`, and features first
		// then the visible observability sub-row for number keys.
		const featureIds: string[] = props.environments
			? featureTabs().map((feature) => feature.id)
			: tabIds();
		const activeFeatureId = (): string =>
			props.environments ? activeFeature() : activeTab();
		const selectById = (id: string | undefined) => {
			if (!id) return;
			if (!props.environments) {
				switchTab(id as Tab);
				return;
			}
			if (observabilityTabs().some((tab) => tab.id === id))
				switchTab(id as Tab);
			else selectFeature(id as FeatureId);
		};
		const numberIds: string[] =
			props.environments && activeFeature() === "observability"
				? [...featureIds, ...observabilityTabs().map((tab) => tab.id)]
				: featureIds;
		const isTab = ename === "Tab" || key === "tab" || key === "\t";
		const isCtrlTab = event.ctrl && key === "i"; // Ctrl+I = Tab in many terminals
		const tabForward = (isTab || isCtrlTab) && !event.shift;
		const tabBack = (isTab || isCtrlTab) && event.shift;
		const dashModal = props.dashboard
			? props.dashboard.keymap.getData?.("modal.active")
			: "none";
		if (
			nav.modal() === "none" &&
			(!props.dashboard || dashModal === "none" || dashModal === undefined)
		) {
			if (key === "t" && !event.ctrl && !event.meta && !event.shift) {
				const current = featureIds.indexOf(activeFeatureId());
				selectById(featureIds[(current + 1) % featureIds.length]);
				return;
			}
			if (/^[1-9]$/.test(key)) {
				selectById(numberIds[Number(key) - 1]);
				return;
			}
			if (tabBack) {
				const current = featureIds.indexOf(activeFeatureId());
				selectById(
					featureIds[(current - 1 + featureIds.length) % featureIds.length],
				);
				return;
			}
			if (tabForward) {
				const current = featureIds.indexOf(activeFeatureId());
				selectById(featureIds[(current + 1) % featureIds.length]);
				return;
			}
		}

		// Dashboard keys are handled by its own keymap (runs before this handler).
		if (activeTab() === "workflow" || activeTab() === "wiki") return;

		// Quit (global)
		if (key === "q") {
			const now = Date.now();
			if (lastQuit() && now - lastQuit() < 1000) {
				if (props.dashboard?.mode === "home") globalThis.__requestShutdown?.();
				else globalThis.__renderer?.destroy();
			} else {
				setLastQuit(now);
				notify("Press q again to quit", "info");
			}
			return;
		}

		// Escape / back: modal or view history first, then the cross-feature origin.
		if (key === "escape") {
			if (nav.esc()) return;
			if (router.state().origin) {
				router.back();
				return;
			}
		}

		if (event.shift && key === "t" && nav.modal() === "none") {
			setThemeIndex(Math.max(0, themeNames.indexOf(getActiveThemeName())));
			setThemeQuery("");
			setThemeFiltering(false);
			nav.pushModal("theme", activeFeatureId());
			return;
		}

		// Search mode (shared across tabs)
		if (searchMode()) {
			// Tab key should switch tabs even in search mode
			if (tabForward) {
				const current = featureIds.indexOf(activeFeatureId());
				setSearchMode(false);
				selectById(featureIds[(current + 1) % featureIds.length]);
				return;
			}
			if (tabBack) {
				const current = featureIds.indexOf(activeFeatureId());
				setSearchMode(false);
				selectById(
					featureIds[(current - 1 + featureIds.length) % featureIds.length],
				);
				return;
			}
			if (key === "escape") {
				if (activeTab() === "logs") {
					logStore.setFilter("");
					setLogFilterQuery("");
				} else {
					traceStore.applyFilter(searchPrevious);
					setSearchQuery(searchPrevious);
					refresh();
				}
				setSearchMode(false);
			} else if (key === "backspace") {
				if (activeTab() === "logs") {
					const q = logFilterQuery().slice(0, -1);
					setLogFilterQuery(q);
					logStore.setFilter(q);
				} else {
					const q = searchQuery().slice(0, -1);
					setSearchQuery(q);
					traceStore.applyFilter(q);
					setSelectedListIndex(0);
					refresh();
				}
			} else if (key === "enter" || key === "return") {
				setSearchMode(false);
			} else if (key.length === 1 && !event.ctrl && !event.meta) {
				if (activeTab() === "logs") {
					const q = logFilterQuery() + key;
					setLogFilterQuery(q);
					logStore.setFilter(q);
				} else {
					const q = searchQuery() + key;
					setSearchQuery(q);
					traceStore.applyFilter(q);
					setSelectedListIndex(0);
					refresh();
				}
			}
			return;
		}

		// Help (shell tabs): the `?` modal reads the active catalog. Ignore it
		// while one of this tab's own modals (filter/sort/theme) owns the keys.
		if (key === "?" && nav.modal() === "none") {
			setHelpOffset(0);
			nav.pushModal("help", activeFeatureId());
			return;
		}

		// The embedded environment feature owns its keys; do not fall through to
		// the traces handlers below (which would move the hidden trace selection).
		if (activeTab() === "environments") return;

		// Tab-specific key handling
		if (activeTab() === "metrics") return handleMetricsKey(event, key);
		if (activeTab() === "logs") return handleLogsKey(event, key);
		if (activeTab() === "topology") return handleTopologyKey(event, key);

		// ---- Traces tab key handling (existing logic) ----
		if (nav.modal() === "filter") {
			if (key === "x") {
				traceStore.applyFilter("");
				traceStore.setStatusFilter("all");
				setSearchQuery("");
				setFilterPane("criteria");
				setFilterCriterion(0);
				setFilterStatusIndex(0);
				setFilterWorkspaceIndex(0);
				switchWorkspace();
				refresh();
			} else if (key === "h" || key === "left") setFilterPane("criteria");
			else if (key === "l" || key === "right") setFilterPane("values");
			else if (filterPane() === "criteria" && (key === "j" || key === "down"))
				setFilterCriterion((i) => Math.min(1, i + 1));
			else if (filterPane() === "criteria" && (key === "k" || key === "up"))
				setFilterCriterion((i) => Math.max(0, i - 1));
			else if (
				filterPane() === "values" &&
				filterCriterion() === 0 &&
				(key === "j" || key === "down")
			)
				setFilterStatusIndex((i) => Math.min(statusOptions.length - 1, i + 1));
			else if (
				filterPane() === "values" &&
				filterCriterion() === 0 &&
				(key === "k" || key === "up")
			)
				setFilterStatusIndex((i) => Math.max(0, i - 1));
			else if (
				filterPane() === "values" &&
				filterCriterion() === 1 &&
				(key === "j" || key === "down")
			)
				setFilterWorkspaceIndex((i) => Math.min(workspaces().length, i + 1));
			else if (
				filterPane() === "values" &&
				filterCriterion() === 1 &&
				(key === "k" || key === "up")
			)
				setFilterWorkspaceIndex((i) => Math.max(0, i - 1));
			else if (key === "enter" || key === "return") {
				traceStore.setStatusFilter(statusOptions[filterStatusIndex()]?.value);
				switchWorkspace(
					filterWorkspaceIndex() === 0
						? undefined
						: workspaces()[filterWorkspaceIndex() - 1]?.changeId,
				);
				setSelectedListIndex(0);
				refresh();
				nav.popModal();
			}
			return;
		}
		if (nav.modal() === "sort") {
			const shifted =
				event.shift ||
				(event.name.length === 1 && event.name >= "A" && event.name <= "Z");
			if (key === "space")
				setSortDraft((criteria) =>
					criteria.map((c, i) =>
						i === sortIndex()
							? {
									...c,
									mode:
										c.mode === "asc"
											? "desc"
											: c.mode === "desc"
												? "none"
												: "asc",
								}
							: c,
					),
				);
			else if (key === "j" && shifted)
				setSortDraft((criteria) => {
					const i = sortIndex();
					if (i >= criteria.length - 1) return criteria;
					const copy = [...criteria];
					[copy[i], copy[i + 1]] = [copy[i + 1], copy[i]];
					setSortIndex(i + 1);
					return copy;
				});
			else if (key === "k" && shifted)
				setSortDraft((criteria) => {
					const i = sortIndex();
					if (i === 0) return criteria;
					const copy = [...criteria];
					[copy[i], copy[i - 1]] = [copy[i - 1], copy[i]];
					setSortIndex(i - 1);
					return copy;
				});
			else if (key === "j" || key === "down")
				setSortIndex((i) => Math.min(sortDraft().length - 1, i + 1));
			else if (key === "k" || key === "up")
				setSortIndex((i) => Math.max(0, i - 1));
			else if (key === "enter" || key === "return") {
				traceStore.setSortCriteria(sortDraft());
				setSelectedListIndex(0);
				refresh();
				nav.popModal();
			}
			return;
		}

		const shifted =
			event.shift ||
			(event.name.length === 1 && event.name >= "A" && event.name <= "Z");
		if (key === "/") {
			searchPrevious = traceStore.filterQuery_;
			setSearchQuery(searchPrevious);
			setSearchMode(true);
		} else if (key === "f" && shifted) {
			setFilterPane("criteria");
			setFilterCriterion(0);
			setFilterStatusIndex(
				Math.max(
					0,
					statusOptions.findIndex((o) => o.value === traceStore.statusFilter_),
				),
			);
			setFilterWorkspaceIndex(
				Math.max(
					0,
					workspaces().findIndex((w) => w.changeId === activeWorkspace()) + 1,
				),
			);
			nav.pushModal("filter", activeFeatureId());
		} else if (key === "o" && shifted) {
			setSortDraft(traceStore.sortCriteria_);
			setSortIndex(0);
			nav.pushModal("sort", activeFeatureId());
		} else if (key === "w") {
			switchWorkspace();
			notify("All workspaces", "info");
		} else if (nav.view() === "selection") {
			if (key === "j" || key === "down")
				setSelectedListIndex((i) => Math.min(summaries().length - 1, i + 1));
			else if (key === "k" || key === "up")
				setSelectedListIndex((i) => Math.max(0, i - 1));
			else if (key === "enter" || key === "return")
				selectTrace(selectedListIndex());
		} else {
			const items = flatTree();
			if (key === "escape" || key === "b") nav.popView();
			else if (key === "j" || key === "down") {
				const i = Math.min(items.length - 1, treeIndex() + 1);
				setTreeIndex(i);
				setSelectedSpan(items[i]?.node);
			} else if (key === "k" || key === "up") {
				const i = Math.max(0, treeIndex() - 1);
				setTreeIndex(i);
				setSelectedSpan(items[i]?.node);
			} else if (key === "g" && event.shift) {
				const i = Math.max(0, items.length - 1);
				setTreeIndex(i);
				setSelectedSpan(items[i]?.node);
			} else if (key === "g") {
				setTreeIndex(0);
				setSelectedSpan(items[0]?.node);
			} else if (key === "h") {
				const item = items[treeIndex()];
				if (item) setNodeExpanded(item.path, false);
			} else if (key === "l") {
				const item = items[treeIndex()];
				if (item) setNodeExpanded(item.path, true);
			} else if (key === "enter" || key === "return") {
				if (selectedSpan()) nav.pushView("span");
			}
		}
	};

	// ---- Metric tab keys ----
	function handleMetricsKey(_event: KeyEvent, key: string) {
		if (selectedMetric()) {
			if (key === "escape" || key === "b") setSelectedMetric(undefined);
			return;
		}
		const streams = metricStore.getStreams();
		if (key === "j" || key === "down")
			setSelectedMetricIndex((i) => Math.min(streams.length - 1, i + 1));
		else if (key === "k" || key === "up")
			setSelectedMetricIndex((i) => Math.max(0, i - 1));
		else if (key === "enter" || key === "return") {
			const stream = streams[selectedMetricIndex()];
			if (stream)
				setSelectedMetric({
					name: stream.name,
					serviceName: stream.serviceName,
				});
		}
	}

	// ---- Log tab keys ----
	function handleLogsKey(_event: KeyEvent, key: string) {
		if (selectedLog() !== undefined) {
			if (key === "escape" || key === "b") setSelectedLog(undefined);
			return;
		}
		const logs = logStore.getLogs();
		if (key === "j" || key === "down")
			setSelectedLogIndex((i) => Math.min(logs.length - 1, i + 1));
		else if (key === "k" || key === "up")
			setSelectedLogIndex((i) => Math.max(0, i - 1));
		else if (key === "enter" || key === "return") {
			if (logs[selectedLogIndex()]) setSelectedLog(selectedLogIndex());
		} else if (key === "/") {
			setLogFilterQuery("");
			setSearchMode(true);
		}
	}

	// ---- Topology tab keys ----
	function handleTopologyKey(_event: KeyEvent, key: string) {
		if (topologyDetail()) {
			if (key === "escape" || key === "b") setTopologyDetail(undefined);
			return;
		}
		const ids = topologyStore.getLayout().map((node) => node.id);
		const current = Math.max(0, ids.indexOf(selectedTopologyService() ?? ""));
		if (key === "j" || key === "down")
			setSelectedTopologyService(ids[Math.min(ids.length - 1, current + 1)]);
		else if (key === "k" || key === "up")
			setSelectedTopologyService(ids[Math.max(0, current - 1)]);
		else if (key === "enter" || key === "return") {
			const id = selectedTopologyService() ?? ids[0];
			if (id) setTopologyDetail(id);
		}
	}

	// Single dispatcher: when the shell owns a keymap (the production home/dash
	// entrypoints always pass one), shell keys are a lowest-priority keymap
	// layer so higher-priority dashboard/environment layers run first. The raw
	// listener remains only as a fallback for keymap-less test mounts.
	const shellKeymap = props.dashboard?.keymap;
	if (shellKeymap) {
		const disposeShellKeyLayer = registerShellKeyLayer(shellKeymap, handleKey);
		onCleanup(disposeShellKeyLayer);
	} else {
		renderer.keyInput.on("keypress", handleKey);
		onCleanup(() => renderer.keyInput.off("keypress", handleKey));
	}

	/** Single source of truth for displayed and selectable tab order. */
	const tabs = () => {
		const all: Array<{ id: Tab; label: string; count?: number }> = [];
		if (props.environments)
			all.push({ id: "environments", label: "Environments" });
		if (props.dashboard)
			all.push({
				id: "workflow",
				label: props.dashboard.mode === "home" ? "Workflows" : "Workflow",
			});
		if (props.dashboard?.mode === "home")
			all.push({ id: "wiki", label: "Wiki" });
		all.push(
			{ id: "traces", label: "Traces", count: filteredCount() },
			{ id: "metrics", label: "Metrics", count: metricStore.filteredCount_ },
			{ id: "logs", label: "Logs", count: logStore.filteredCount_ },
			{
				id: "topology",
				label: "Topology",
				count: topologyStore.getServices().length,
			},
		);
		return props.tracesOnly
			? all.filter(
					(tab) =>
						tab.id === "workflow" || tab.id === "wiki" || tab.id === "traces",
				)
			: all;
	};

	// Top-level feature tabs of the unified shell. Observability is one feature
	// whose sub-views (traces/metrics/logs/topology) render as a second row and
	// keep their own last-selected sub-tab (spec: one discoverable shell).
	const featureTabs = (): Array<{ id: FeatureId; label: string }> => {
		const all: Array<{ id: FeatureId; label: string }> = [];
		if (props.environments)
			all.push({ id: "environments", label: "Environments" });
		if (props.dashboard)
			all.push({
				id: "workflows",
				label: props.dashboard.mode === "home" ? "Workflows" : "Workflow",
			});
		all.push({ id: "observability", label: "Observability" });
		if (props.dashboard?.mode === "home")
			all.push({ id: "wiki", label: "Wiki" });
		return all;
	};
	const observabilityTabs = (): Array<{
		id: "traces" | "metrics" | "logs" | "topology";
		label: string;
		count?: number;
	}> => {
		const all = [
			{ id: "traces" as const, label: "Traces", count: filteredCount() },
			{
				id: "metrics" as const,
				label: "Metrics",
				count: metricStore.filteredCount_,
			},
			{ id: "logs" as const, label: "Logs", count: logStore.filteredCount_ },
			{
				id: "topology" as const,
				label: "Topology",
				count: topologyStore.getServices().length,
			},
		];
		return props.tracesOnly ? all.filter((tab) => tab.id === "traces") : all;
	};
	const selectFeature = (feature: FeatureId) => {
		// A feature-local overlay cannot remain the input owner after its body is
		// hidden. Clear the shared modal state and shell modal stack atomically
		// before changing the route (USABILITY-001).
		nav.modalStack.set(
			createModalStackState<"filter" | "sort" | "theme" | "help">(),
		);
		closeModalHelp();
		props.dashboard?.keymap.setData("modal.active", "none");
		// Resume the feature's preserved stack and record the current route as
		// origin so `back()` can restore the originating resource (task 2.2).
		const top =
			router.state().stacks[feature].at(-1) ?? routeForFeature(feature);
		router.navigate(top);
		nav.popView();
	};

	const tabIds = () => tabs().map((tab) => tab.id);

	// Number of keys the active rendered row advertises: features only, or
	// features plus the observability sub-row while it is shown.
	const shellTabCount = (): number =>
		props.environments
			? activeFeature() === "observability"
				? featureTabs().length + observabilityTabs().length
				: featureTabs().length
			: tabIds().length;

	const tabKeybindCatalog = (): KeybindSection[] =>
		observabilityKeybindCatalog({
			tab: activeTab(),
			view: nav.view(),
			tabCount: shellTabCount(),
		});

	// The shell footer and `?` help read the active surface catalog from the
	// shared store. The dashboard (workflow tab) publishes its own catalog, so
	// the shell skips it there instead of fighting for the store.
	createEffect(() => {
		if (props.dashboard && activeTab() === "workflow") return;
		setActiveKeybindCatalog(
			activeTab() === "environments" && props.environments
				? (environmentCatalog() ??
						environmentsKeybindCatalog(featureTabs().length))
				: tabKeybindCatalog(),
			// The wiki's note-only actions are footer-visible while a note is open.
			activeTab() === "wiki" && wikiNoteActive() ? "note" : undefined,
		);
	});

	return (
		<box
			backgroundColor={uiColors.bgBase}
			width="100%"
			height="100%"
			onMouseUp={() => copySelection()}
		>
			<box
				backgroundColor={uiColors.bgBase}
				style={{
					width: "100%",
					height: "100%",
					flexDirection: "column",
					padding: props.dashboard ? 0 : 1,
					gap: 0,
				}}
			>
				{/* Header — the workflow header (dashboard data) or a simple logo bar */}
				<box
					backgroundColor={uiColors.bgMantle}
					style={{ width: "100%", flexDirection: "column" }}
				>
					{(() => {
						const header = workflowHeader();
						return header ? (
							<Header
								change={header.change}
								phase={header.phase}
								branch={header.branch}
								updated={header.updated}
							/>
						) : (
							<box
								style={{
									height: 1,
									flexDirection: "row",
									alignItems: "center",
									paddingLeft: 1,
									paddingRight: 1,
								}}
							>
								<text
									fg={uiColors.textPrimary}
									attributes={TextAttributes.BOLD}
								>
									AGENTIC CODING
								</text>
								<box style={{ flexGrow: 1 }} />
								<Badge text={activeTab()} highlight="accent" />
							</box>
						);
					})()}
				</box>
				<box style={{ height: 1 }} />
				{props.environments ? (
					<box style={{ flexDirection: "column", flexShrink: 0 }}>
						<TabBar
							tabs={featureTabs()}
							activeId={activeFeature()}
							onSelect={(id) => selectFeature(id as FeatureId)}
						/>
						{activeFeature() === "observability" && (
							<TabBar
								tabs={observabilityTabs()}
								activeId={activeTab()}
								onSelect={(id) => switchTab(id as Tab)}
							/>
						)}
					</box>
				) : (
					(!props.tracesOnly || props.dashboard?.mode === "home") && (
						<TabBar
							tabs={tabs()}
							activeId={activeTab()}
							onSelect={(id) => switchTab(id as Tab)}
						/>
					)
				)}

				{/* Tab content */}
				<box
					backgroundColor={uiColors.bgBase}
					style={{ flexGrow: 1, minHeight: 0, flexDirection: "column" }}
				>
					{/* Feature bodies stay mounted while hidden: switching shell tabs must
					 * preserve live environment/workflow drafts, selections and subscriptions. */}
					{props.renderEnvironments && (
						<box
							visible={activeTab() === "environments"}
							style={{ flexGrow: 1, minHeight: 0 }}
						>
							{props.renderEnvironments(
								setEnvironmentCatalog,
								() => activeFeature() === "environments",
								(open) => {
									if (open && activeFeature() === "environments") {
										if (nav.modal() !== "environment")
											nav.pushModal("environment", "environments");
									} else if (!open && nav.modal() === "environment") {
										nav.popModal();
									}
								},
							)}
						</box>
					)}
					{props.dashboard && (
						<box
							visible={activeTab() === "workflow"}
							style={{ flexGrow: 1, minHeight: 0 }}
						>
							{props.dashboard.mode === "home" ? (
								<DashHome
									keymap={props.dashboard.keymap}
									shellFeature="workflows"
									active={() => activeFeature() === "workflows"}
									items={homeItems()}
									loading={homeLoading()}
									projects={homeProjects()}
									refresh={loadHome}
								/>
							) : (
								<DashApp
									repo={props.dashboard.repo ?? ""}
									workflowId={props.dashboard.change ?? ""}
									profile={props.dashboard.profile as "test" | undefined}
									keymap={props.dashboard.keymap}
									shellFeature="workflows"
									active={() => activeFeature() === "workflows"}
									onHeader={setWorkflowHeader}
								/>
							)}
						</box>
					)}
					{props.dashboard?.mode === "home" && (
						<box
							visible={activeTab() === "wiki"}
							style={{ flexGrow: 1, minHeight: 0 }}
						>
							<WikiView
								keymap={props.dashboard.keymap}
								shellFeature="wiki"
								comments={wikiComments()}
								onAddComment={(comment) =>
									setWikiComments((comments) => [...comments, comment])
								}
								onFinish={finishWikiReview}
								submitting={wikiSubmitting()}
								onSubmittingChange={setWikiSubmitting}
								onClearComments={() => setWikiComments([])}
								onHelp={() => {
									setHelpOffset(0);
									nav.pushModal("help", "wiki");
									// Park WikiView's keymap layer while the shell help is open so
									// j/k/Esc reach the modal; restored when it closes.
									props.dashboard?.keymap.setData("modal.active", "help");
								}}
							/>
						</box>
					)}
					{activeTab() === "traces" && (
						<>
							{nav.view() === "selection" && (
								<TraceListView
									summaries={summaries}
									selectedIndex={selectedListIndex}
									searchMode={searchMode}
									searchQuery={searchQuery}
									resultCount={filteredCount}
									onSelect={selectTrace}
								/>
							)}
							{nav.view() === "detail" && (
								<box
									style={{ flexGrow: 1, minHeight: 0, flexDirection: "column" }}
								>
									<box
										height={1}
										paddingLeft={1}
										flexShrink={0}
										flexDirection="row"
									>
										<HighlightedText
											text="Span tree"
											attributes={TextAttributes.BOLD}
										/>
										<box style={{ flexGrow: 1 }} />
										<text fg={uiColors.textMuted}>
											{flatTree().length} visible
										</text>
									</box>
									<box style={{ flexGrow: 1, minHeight: 0 }}>
										<TraceTreeView
											roots={treeRoots}
											selectedIndex={treeIndex}
											onToggle={(node, path) =>
												setNodeExpanded(path, !node.expanded)
											}
											onSelect={selectTree}
										/>
									</box>
								</box>
							)}
							{nav.view() === "span" && <SpanDetailView node={selectedSpan} />}
						</>
					)}
					{activeTab() === "metrics" && (
						<>
							{!selectedMetric() && (
								<MetricsView
									store={metricStore}
									selectedIndex={selectedMetricIndex}
									onSelectIndex={setSelectedMetricIndex}
									onOpen={(name, serviceName) =>
										setSelectedMetric({ name, serviceName })
									}
								/>
							)}
							{(() => {
								const selected = selectedMetric();
								return selected ? (
									<MetricDetailView
										store={metricStore}
										name={selected.name}
										serviceName={selected.serviceName}
										onBack={() => setSelectedMetric(undefined)}
									/>
								) : null;
							})()}
						</>
					)}
					{activeTab() === "logs" && (
						<>
							{selectedLog() === undefined && (
								<LogsView
									store={logStore}
									selectedIndex={selectedLogIndex}
									onSelectIndex={setSelectedLogIndex}
									onOpen={setSelectedLog}
								/>
							)}
							{(() => {
								const idx = selectedLog();
								return idx !== undefined ? (
									<LogDetailView
										store={logStore}
										index={idx}
										onBack={() => setSelectedLog(undefined)}
									/>
								) : null;
							})()}
						</>
					)}
					{activeTab() === "topology" && (
						<>
							{!topologyDetail() && (
								<TopologyView
									store={topologyStore}
									selectedService={selectedTopologyService}
									onSelect={setSelectedTopologyService}
								/>
							)}
							{(() => {
								const id = topologyDetail();
								return id ? (
									<ServiceDetailView store={topologyStore} id={id} />
								) : null;
							})()}
						</>
					)}
				</box>

				{/* Status bar — one global footer for all tabs; keybinds are tab-dependent. */}
				<box style={{ height: 1 }} />
				<StatusBar />
			</box>
			<NotificationOverlay />
			<ErrorModalOverlay keymap={props.dashboard?.keymap} />
			{nav.modal() === "filter" && (
				<FilterModal
					pane={filterPane}
					criterion={filterCriterion}
					statusIndex={filterStatusIndex}
					workspaceIndex={filterWorkspaceIndex}
					workspaces={workspaces}
				/>
			)}
			{nav.modal() === "sort" && (
				<SortModal selected={sortIndex} criteria={sortDraft} />
			)}
			{nav.modal() === "theme" && (
				<ThemePickerModal
					selected={themeIndex}
					active={getActiveThemeName}
					themes={filteredThemes}
					query={themeQuery}
					filtering={themeFiltering}
				/>
			)}
			{nav.modal() === "help" && (
				<HelpModal
					title="Keybindings"
					offset={helpOffset()}
					lines={helpLines()}
				/>
			)}
			{/* Shared portaled modals (e.g. the theme picker) publish a modal-help
			    catalog; paint it at the shell root so `?` is not a dead key. */}
			<ModalHelpOverlay zIndex={30} />
		</box>
	);
}
