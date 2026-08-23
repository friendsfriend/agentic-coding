/** @jsxImportSource @opentui/solid */

import { join } from "node:path";
import type { Renderable } from "@opentui/core";
import { type KeyEvent, TextAttributes } from "@opentui/core";
import type { Keymap } from "@opentui/keymap";
import { useRenderer } from "@opentui/solid";
import {
	createEffect,
	createMemo,
	createSignal,
	onCleanup,
	onMount,
} from "solid-js";
import { App as DashApp } from "../../dash/App";
import {
	discoverProjects,
	listWorkflows,
	type WorkflowOverview,
} from "../../dash/data";
import { Home as DashHome } from "../../dash/Home";
import { Header } from "../../dash/ui/Header";
import { watchDirectories } from "../../dash/watchRefresh";
import { phase } from "../../lifecycle";
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
import type { SpanData, TreeNode } from "../model/types";
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
import { copyText } from "./clipboard";
import { createNavigation } from "./navigation";
import { notify } from "./notifications";
import {
	applyTheme,
	getActiveThemeName,
	loadThemeName,
	saveThemeName,
	themeNames,
} from "./theme";

type Tab = "workflow" | "traces" | "metrics" | "logs" | "topology";
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
	/** When set, a Workflow tab is prepended that renders the dashboard. */
	dashboard?: DashboardTab;
}) {
	const renderer = useRenderer();
	const nav = createNavigation();
	const [activeTab, setActiveTab] = createSignal<Tab>(
		props.dashboard ? "workflow" : "traces",
	);
	// Workflow header context pushed up from the dashboard tab content (single source
	// of truth; the dashboard polls, the shell renders). Null in home mode / before data.
	const [workflowHeader, setWorkflowHeader] =
		createSignal<WorkflowHeaderInfo | null>(null);

	// Home mode: the shell owns the workspace list — loaded in the background at
	// startup and kept fresh, so visiting the Workflow tab never reloads or shows
	// the loading indicator again.
	const [homeItems, setHomeItems] = createSignal<WorkflowOverview[]>([]);
	const [homeLoading, setHomeLoading] = createSignal(true);
	const [homeProjects, setHomeProjects] = createSignal<
		Array<{ name: string; path: string; openspec: boolean }>
	>([]);
	createEffect(() => {
		if (props.dashboard?.mode !== "home") return;
		const load = () => {
			setHomeItems(listWorkflows());
			setHomeProjects(discoverProjects());
			setHomeLoading(false);
		};
		load();
		// ponytail: 30s safety re-sync also discovers brand-new workflows.
		const safety = setInterval(load, 30000);
		onCleanup(() => clearInterval(safety));
	});
	createEffect(() => {
		if (props.dashboard?.mode !== "home") return;
		const dirs = homeItems().map((item) =>
			join(item.state.worktree, ".herdr-workflow", item.state.changeId),
		);
		const dispose = watchDirectories(dirs, () => setHomeItems(listWorkflows()));
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

	function switchTab(tab: Tab) {
		setActiveTab(tab);
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
		const onNew = (changeId: string, spans: SpanData[]) => {
			setWorkspaces(db.getWorkspaces());
			if (!activeWorkspace() || activeWorkspace() === changeId) {
				traceStore.loadFile(db.loadSpans(activeWorkspace()));
				refresh();
			}
			notify(`${changeId}: ${spans.length} new spans`, "info");
		};
		const stops = props.repos.map((r) => db.watchWorkspaces(r, onNew));
		// The TraceDb is owned by the shell (index.tsx) for the process lifetime;
		// remounting this view must not close it. Only stop this view's watchers.
		onCleanup(() => {
			clearInterval(dailyPrune);
			stops.forEach((stop) => {
				stop();
			});
		});
	});

	const copySelection = (reportEmpty = false) => {
		const text = renderer.getSelection()?.getSelectedText() ?? "";
		if (!text) {
			if (reportEmpty) notify("No selection to copy", "warning");
			return;
		}
		const copied = copyText(text);
		notify(
			copied ? "Copied selection" : "Copy failed",
			copied ? "success" : "error",
		);
		renderer.clearSelection();
	};

	const handleKey = (event: KeyEvent) => {
		const key = event.name.toLowerCase();
		const ename = event.name;
		const trace = (msg: string) => {
			const target = process.env.AGENTIC_CODING_TRACE;
			if (target) {
				try {
					require("node:fs").appendFileSync(
						target,
						`${Date.now()} otel ${msg}\n`,
					);
				} catch {
					/* noop */
				}
			}
		};
		const traceDashModal = props.dashboard
			? props.dashboard.keymap.getData?.("modal.active")
			: "none";
		trace(
			`key=${key} ctrl=${!!event.ctrl} tab=${activeTab()} nav=${nav.modal()} dashModal=${traceDashModal}`,
		);
		// Lifecycle overlay (startup/shutdown modal) consumes keys; 'q' still works
		// via the home keymap layer, which routes it to requestShutdown.
		if (phase() === "starting" || phase() === "stopping") return;

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

		// Tab switching (global, except when in a modal)
		const ids = tabIds();
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
				const current = ids.indexOf(activeTab());
				switchTab(ids[(current + 1) % ids.length] ?? activeTab());
				return;
			}
			if (key === "1") {
				switchTab("traces");
				return;
			}
			if (key === "2" && !props.tracesOnly) {
				switchTab("metrics");
				return;
			}
			if (key === "3" && !props.tracesOnly) {
				switchTab("logs");
				return;
			}
			if (key === "4" && !props.tracesOnly) {
				switchTab("topology");
				return;
			}
			if (tabBack) {
				const current = ids.indexOf(activeTab());
				const prev = (current - 1 + ids.length) % ids.length;
				switchTab(ids[prev] ?? activeTab());
				return;
			}
			if (tabForward) {
				const current = ids.indexOf(activeTab());
				const next = (current + 1) % ids.length;
				switchTab(ids[next] ?? activeTab());
				return;
			}
		}

		// Dashboard keys are handled by its own keymap (runs before this handler).
		if (activeTab() === "workflow") return;

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

		// Escape / back
		if (key === "escape" && nav.esc()) return;

		if (event.shift && key === "t" && nav.modal() === "none") {
			setThemeIndex(Math.max(0, themeNames.indexOf(getActiveThemeName())));
			setThemeQuery("");
			setThemeFiltering(false);
			nav.pushModal("theme");
			return;
		}

		// Search mode (shared across tabs)
		if (searchMode()) {
			// Tab key should switch tabs even in search mode
			if (tabForward) {
				const current = ids.indexOf(activeTab());
				const next = (current + 1) % ids.length;
				setSearchMode(false);
				switchTab(ids[next] ?? activeTab());
				return;
			}
			if (tabBack) {
				const current = ids.indexOf(activeTab());
				const prev = (current - 1 + ids.length) % ids.length;
				setSearchMode(false);
				switchTab(ids[prev] ?? activeTab());
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
			nav.pushModal("filter");
		} else if (key === "o" && shifted) {
			setSortDraft(traceStore.sortCriteria_);
			setSortIndex(0);
			nav.pushModal("sort");
		} else if (key === "?")
			notify(
				"j/k select · Enter trace · w workspaces · 1-4 tabs · q quit",
				"info",
			);
		else if (key === "w") {
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

	renderer.keyInput.on("keypress", handleKey);
	onCleanup(() => renderer.keyInput.off("keypress", handleKey));

	const tabs = () => {
		const all: Array<{ id: Tab; label: string; count?: number }> = [];
		if (props.dashboard)
			all.push({
				id: "workflow",
				label: props.dashboard.mode === "home" ? "Workflows" : "Workflow",
			});
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
			? all.filter((tab) => tab.id === "workflow" || tab.id === "traces")
			: all;
	};

	/** All selectable tabs in display order (workflow first when a dashboard is injected). */
	const tabIds = () => {
		const ids: Tab[] = props.dashboard
			? ["workflow", "traces", "metrics", "logs", "topology"]
			: ["traces", "metrics", "logs", "topology"];
		return props.tracesOnly
			? ids.filter((id) => id === "workflow" || id === "traces")
			: ids;
	};

	const tabStatusBarKeybinds = () => {
		switch (activeTab()) {
			case "workflow":
				return props.dashboard?.mode === "home"
					? [
							{ key: "Enter", action: "switch workspace" },
							{ key: "n", action: "new workflow" },
							{ key: "f", action: "filter" },
							{ key: "o", action: "sort" },
							{ key: "r", action: "refresh" },
							{ key: "?", action: "help" },
							{ key: "q", action: "quit" },
						]
					: [
							{ key: "J/K", action: "switch panel" },
							{ key: "j/k", action: "scroll focused panel" },
							{ key: "r", action: "refresh" },
							{ key: "q", action: "quit" },
						];
			case "metrics":
				return [
					{ key: "j/k", action: "nav" },
					{ key: "Enter", action: "detail" },
					{ key: "Esc", action: "back" },
					{ key: "1-4", action: "tabs" },
					{ key: "q", action: "quit" },
				];
			case "logs":
				return [
					{ key: "j/k", action: "nav" },
					{ key: "Enter", action: "detail" },
					{ key: "/", action: "search" },
					{ key: "Esc", action: "back" },
					{ key: "1-4", action: "tabs" },
					{ key: "q", action: "quit" },
				];
			case "topology":
				return [
					{ key: "j/k", action: "select" },
					{ key: "Enter", action: "detail" },
					{ key: "Esc", action: "back" },
					{ key: "1-4", action: "tabs" },
					{ key: "q", action: "quit" },
				];
			default:
				return [
					{ key: "j/k", action: "select" },
					{ key: "Enter", action: "open trace" },
					{ key: "/", action: "search" },
					{ key: "Shift+F", action: "filter" },
					{ key: "1-4", action: "tabs" },
					{ key: "q", action: "quit" },
				];
		}
	};

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
					padding: 1,
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
				{!props.tracesOnly && (
					<TabBar
						tabs={tabs()}
						activeId={activeTab()}
						onSelect={(id) => switchTab(id as Tab)}
					/>
				)}

				{/* Tab content */}
				<box
					backgroundColor={uiColors.bgBase}
					style={{ flexGrow: 1, minHeight: 0, flexDirection: "column" }}
				>
					{activeTab() === "workflow" &&
						props.dashboard &&
						(props.dashboard.mode === "home" ? (
							<DashHome
								keymap={props.dashboard.keymap}
								items={homeItems()}
								loading={homeLoading()}
								projects={homeProjects()}
								refresh={() => setHomeItems(listWorkflows())}
							/>
						) : (
							<DashApp
								repo={props.dashboard.repo ?? ""}
								change={props.dashboard.change ?? ""}
								profile={props.dashboard.profile as "test" | undefined}
								keymap={props.dashboard.keymap}
								onHeader={setWorkflowHeader}
							/>
						))}
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
				<StatusBar
					keybinds={
						activeTab() === "traces" && nav.view() === "selection"
							? [
									{ key: "j/k", action: "select" },
									{ key: "Enter", action: "open trace" },
									{ key: "/", action: "search" },
									{ key: "Shift+F", action: "filter" },
									{ key: "Shift+O", action: "sort" },
									{ key: "1-4", action: "tabs" },
									{ key: "q", action: "quit" },
								]
							: activeTab() === "traces" && nav.view() === "detail"
								? [
										{ key: "j/k", action: "span" },
										{ key: "h/l", action: "collapse" },
										{ key: "Enter", action: "details" },
										{ key: "Esc", action: "back" },
									]
								: activeTab() === "traces" && nav.view() === "span"
									? [{ key: "Esc", action: "back" }]
									: tabStatusBarKeybinds()
					}
				/>
			</box>
			<NotificationOverlay />
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
		</box>
	);
}
