/** @jsxImportSource @opentui/solid */
import { useKeymap } from "@opentui/keymap/solid";
import {
	createEffect,
	createMemo,
	createSignal,
	onCleanup,
	Show,
} from "solid-js";
import type {
	LogData,
	MetricData,
	ServiceGraph,
	TraceSummaryPage,
	TreeNode,
} from "../../../telemetry/contracts.ts";
import { metricStreamId } from "../../../telemetry/metric-streams.ts";
import type { ClientConnection } from "../../client/connection.ts";
import type { KeybindSection } from "../../ui/index.ts";
import { HomeView } from "../home/HomeView.tsx";
import {
	FilterModal,
	SortModal,
	statusOptions,
} from "./components/TraceModals.tsx";
import { LogStore } from "./model/logStore.ts";
import { MetricStore } from "./model/metricStore.ts";
import { TopologyStore } from "./model/topologyStore.ts";
import {
	type SortCriterion,
	type StatusFilter,
	TraceStore,
} from "./model/traceStore.ts";
import { TelemetryControls } from "./TelemetryControls.tsx";
import { LogDetailView } from "./views/LogDetailView.tsx";
import { LogsView } from "./views/LogsView.tsx";
import { MetricDetailView } from "./views/MetricDetailView.tsx";
import { MetricsView } from "./views/MetricsView.tsx";
import { ServiceDetailView } from "./views/ServiceDetailView.tsx";
import { SpanDetailView } from "./views/SpanDetailView.tsx";
import { TopologyView } from "./views/TopologyView.tsx";
import { TraceListView } from "./views/TraceListView.tsx";
import { TraceTreeView } from "./views/TraceTreeView.tsx";

// v1 views and stores, with the native authenticated transport replacing its
// BackendClient. Each navigation read has an epoch; stale responses never
// replace the selected trace. No database or workspace files are opened here.
export function TelemetryFeature(props: {
	client: ClientConnection;
	active: () => boolean;
	catalog: (sections: KeybindSection[]) => void;
	notify: (message: string) => void;
}) {
	const [surface, setSurface] = createSignal("home");
	const [index, setIndex] = createSignal(0);
	const [page, setPage] = createSignal(1);
	const [revision, refresh] = createSignal(0);
	const [loading, setLoading] = createSignal(false);
	const [payload, setPayload] = createSignal<{
		signal: string;
		identity?: string;
		value: unknown;
	}>();
	const [queries, setQueries] = createSignal<Record<string, string>>({});
	const queryKey = () =>
		surface().startsWith("log")
			? "logs"
			: surface().startsWith("metric")
				? "metrics"
				: "traces";
	const query = () => queries()[queryKey()] ?? "";
	const setQuery = (value: string | ((previous: string) => string)) =>
		setQueries((previous) => ({
			...previous,
			[queryKey()]:
				typeof value === "function" ? value(previous[queryKey()] ?? "") : value,
		}));
	let searchPrevious = "";
	const [searching, setSearching] = createSignal(false);
	const [modal, setModal] = createSignal<"filter" | "sort">();
	const [filterPane, setFilterPane] = createSignal<"criteria" | "values">(
		"criteria",
	);
	const [criterion, setCriterion] = createSignal(0);
	const [statusIndex, setStatusIndex] = createSignal(0);
	const [workspaceIndex, setWorkspaceIndex] = createSignal(0);
	const [spanTypeIndex, setSpanTypeIndex] = createSignal(0);
	const [filterSpanTypes, setFilterSpanTypes] = createSignal<string[]>([]);
	const [filterCatalogReady, setFilterCatalogReady] = createSignal(false);
	let filterEpoch = 0;
	const [knownWorkspaces, setKnownWorkspaces] = createSignal<
		{ changeId: string; spanCount: number }[]
	>([]);
	const [statusFilter, setStatusFilter] = createSignal<StatusFilter>("all");
	const [spanTypeFilter, setSpanTypeFilter] = createSignal("all");
	const [workspace, setWorkspace] = createSignal<string>();
	const [sortCriteria, setSortCriteria] = createSignal<SortCriterion[]>([
		{ field: "received", mode: "desc" },
		{ field: "latency", mode: "none" },
		{ field: "service", mode: "none" },
		{ field: "name", mode: "none" },
	]);
	const [sortDraft, setSortDraft] = createSignal<SortCriterion[]>([]);
	const [sortIndex, setSortIndex] = createSignal(0);
	const [trace, setTrace] = createSignal("");
	const [span, setSpan] = createSignal<TreeNode>();
	const [metric, setMetric] = createSignal({ name: "", service: "", id: "" });
	const [service, setService] = createSignal<string>();
	const [selectedLog, setSelectedLog] = createSignal<LogData>();
	const detailLogs = createMemo(
		() => new LogStore(selectedLog() ? [selectedLog() as LogData] : []),
	);
	const [expansion, setExpansion] = createSignal<Record<string, boolean>>({});
	let epoch = 0;
	let linkEpoch = 0;
	const [resolvingTrace, setResolvingTrace] = createSignal(false);
	let disposed = false;
	const navigate = (next: string) => {
		filterEpoch++;
		linkEpoch++;
		setResolvingTrace(false);
		setIndex(0);
		setSearching(false);
		setModal(undefined);
		setSurface(next);
	};
	const openLinkedTrace = async (traceId: string, spanId?: string) => {
		if (
			disposed ||
			!props.active() ||
			!props.client.stateFresh ||
			resolvingTrace()
		)
			return;
		const generation = ++linkEpoch;
		const origin = surface();
		setResolvingTrace(true);
		try {
			const reference = await props.client.call("telemetry.trace.resolve", {
				traceId,
				...(spanId ? { spanId } : {}),
			});
			if (
				disposed ||
				generation !== linkEpoch ||
				surface() !== origin ||
				!props.active() ||
				!props.client.stateFresh
			)
				return;
			if (!reference) {
				props.notify("Correlated trace is not retained");
				return;
			}
			setTrace(reference.changeId);
			navigate("tree");
		} catch (error) {
			if (!disposed && generation === linkEpoch)
				props.notify(
					error instanceof Error ? error.message : "Trace resolution refused",
				);
		} finally {
			if (!disposed && generation === linkEpoch) setResolvingTrace(false);
		}
	};
	createEffect(() => {
		if (!props.active()) {
			filterEpoch++;
			setModal(undefined);
			linkEpoch++;
			setResolvingTrace(false);
		}
	});
	createEffect(() => {
		const current = surface();
		const selectedTrace = trace();
		const currentPage = page();
		const selectedWorkspace = workspace();
		revision();
		const generation = ++epoch;
		if (current === "home" || current === "controls") {
			setLoading(false);
			return;
		}
		setLoading(true);
		const signal = ["topology", "service-detail"].includes(current)
			? "topology"
			: ["tree", "span"].includes(current)
				? "tree"
				: current === "metric-detail"
					? "metrics"
					: current === "log-detail"
						? "logs"
						: current;
		if (!["traces", "tree", "metrics", "logs", "topology"].includes(signal))
			return;
		void props.client
			.call("telemetry.read", {
				signal: signal as "traces" | "tree" | "metrics" | "logs" | "topology",
				...(current === "traces"
					? {
							page: currentPage,
							perPage: 50,
							...(selectedWorkspace ? { changeId: selectedWorkspace } : {}),
						}
					: {}),
				...(["tree", "span"].includes(current)
					? { changeId: selectedTrace }
					: {}),
			})
			.then((result) => {
				if (disposed || generation !== epoch) return;
				setPayload({
					signal: current === "tree" || current === "span" ? "tree" : signal,
					value: result.value,
					...(["tree", "span"].includes(current)
						? { identity: selectedTrace }
						: {}),
				});
			})
			.catch((error: unknown) => {
				if (!disposed && generation === epoch)
					props.notify(
						error instanceof Error ? error.message : "Telemetry read refused",
					);
			})
			.finally(() => {
				if (!disposed && generation === epoch) setLoading(false);
			});
	});
	const traces = createMemo(() => {
		const store = new TraceStore();
		const response = payload();
		if (
			response?.signal === "traces" &&
			response.value &&
			!Array.isArray(response.value)
		)
			store.setSummaryPage(response.value as TraceSummaryPage);
		store.applyFilter(query());
		store.setStatusFilter(statusFilter());
		store.setSpanTypeFilter(spanTypeFilter());
		store.setSortCriteria(sortCriteria());
		return store;
	});
	const logs = createMemo(() => {
		const response = payload();
		const store = new LogStore(
			response?.signal === "logs" && Array.isArray(response.value)
				? (response.value as LogData[])
				: [],
		);
		store.setFilter(query());
		return store;
	});
	const metrics = createMemo(() => {
		const response = payload();
		const store = new MetricStore(
			response?.signal === "metrics" && Array.isArray(response.value)
				? (response.value as MetricData[])
				: [],
		);
		store.setFilter(query());
		return store;
	});
	const topology = createMemo(() => {
		const store = new TopologyStore();
		const response = payload();
		if (
			response?.signal === "topology" &&
			response.value &&
			typeof response.value === "object" &&
			!Array.isArray(response.value)
		)
			store.setGraph(response.value as ServiceGraph);
		return store;
	});
	const roots = createMemo(() => {
		const choices = expansion();
		const clone = (nodes: TreeNode[]): TreeNode[] =>
			nodes.map((node) => ({
				...node,
				expanded:
					choices[`${node.span.traceId}:${node.span.spanId}`] ?? node.expanded,
				children: clone(node.children),
			}));
		const response = payload();
		return clone(
			response?.signal === "tree" &&
				response.identity === trace() &&
				Array.isArray(response.value)
				? (response.value as TreeNode[])
				: [],
		);
	});
	const flat = () => {
		const entries: TreeNode[] = [];
		const visit = (nodes: TreeNode[]) => {
			for (const node of nodes) {
				entries.push(node);
				if (node.expanded) visit(node.children);
			}
		};
		visit(roots());
		return entries;
	};
	const toggle = (node: TreeNode) =>
		setExpansion((previous) => ({
			...previous,
			[`${node.span.traceId}:${node.span.spanId}`]: !node.expanded,
		}));
	let observedRevision = props.client.state?.telemetryRevision;
	const unsubscribe = props.client.onChange(() => {
		const next = props.client.state?.telemetryRevision;
		if (props.client.stateFresh && next !== observedRevision) {
			observedRevision = next;
			refresh((n) => n + 1);
		}
	});
	const open = () => {
		switch (surface()) {
			case "traces": {
				const entry = traces().getTraceSummaries()[index()];
				if (entry) {
					setTrace(entry.traceId);
					navigate("tree");
				}
				break;
			}
			case "tree": {
				const entry = flat()[index()];
				if (entry) {
					setSpan(entry);
					navigate("span");
				}
				break;
			}
			case "metrics": {
				const entry = metrics().getStreams()[index()];
				if (entry) {
					setMetric({
						name: entry.name,
						service: entry.serviceName,
						id: metricStreamId(entry),
					});
					navigate("metric-detail");
				}
				break;
			}
			case "logs":
				setSelectedLog(logs().getLogs()[index()]);
				setSurface("log-detail");
				break;
			case "topology": {
				const entry =
					topology()
						.getLayout()
						.find((node) => node.id === service()) ??
					topology().getLayout()[index()];
				if (entry) {
					setService(entry.id);
					navigate("service-detail");
				}
				break;
			}
		}
	};
	const openFilter = () => {
		const generation = ++filterEpoch;
		setFilterCatalogReady(false);
		setFilterSpanTypes([...traces().spanTypes_]);
		setCriterion(0);
		setFilterPane("criteria");
		setStatusIndex(
			Math.max(
				0,
				statusOptions.findIndex((option) => option.value === statusFilter()),
			),
		);
		const loaded = traces()
			.getTraceSummaries()
			.map((summary) => ({
				changeId: summary.traceId,
				spanCount: summary.spanCount,
			}));
		setKnownWorkspaces(loaded);
		setWorkspaceIndex(
			Math.max(
				0,
				loaded.findIndex((item) => item.changeId === workspace()) + 1,
			),
		);
		setSpanTypeIndex(
			Math.max(0, ["all", ...traces().spanTypes_].indexOf(spanTypeFilter())),
		);
		setModal("filter");
		void props.client
			.call("telemetry.filters.read", {})
			.then((catalog) => {
				if (disposed || generation !== filterEpoch || modal() !== "filter")
					return;
				const items = [...catalog.workspaces];
				const selectedWorkspace = workspace();
				if (
					selectedWorkspace &&
					!items.some((item) => item.changeId === selectedWorkspace)
				)
					items.push({ changeId: selectedWorkspace, spanCount: 0 });
				const types = [...catalog.spanTypes];
				const selectedType = spanTypeFilter();
				if (selectedType !== "all" && !types.includes(selectedType))
					types.push(selectedType);
				setKnownWorkspaces(items);
				setFilterSpanTypes(types);
				setWorkspaceIndex(
					Math.max(
						0,
						items.findIndex((item) => item.changeId === selectedWorkspace) + 1,
					),
				);
				setSpanTypeIndex(Math.max(0, ["all", ...types].indexOf(selectedType)));
				setFilterCatalogReady(true);
			})
			.catch((error: unknown) => {
				if (disposed || generation !== filterEpoch || modal() !== "filter")
					return;
				setModal(undefined);
				props.notify(
					error instanceof Error
						? error.message
						: "Trace filter catalog unavailable",
				);
			});
	};
	const handleModal = (key: string, shifted: boolean) => {
		if (key === "escape") {
			setModal(undefined);
			return true;
		}
		if (modal() === "sort") {
			if (key === "space")
				setSortDraft((items) =>
					items.map((item, index) =>
						index === sortIndex()
							? {
									...item,
									mode:
										item.mode === "asc"
											? "desc"
											: item.mode === "desc"
												? "none"
												: "asc",
								}
							: item,
					),
				);
			else if ((key === "j" || key === "k") && shifted) {
				const from = sortIndex(),
					to = from + (key === "j" ? 1 : -1);
				const items = [...sortDraft()],
					first = items[from],
					second = items[to];
				if (first && second) {
					items[from] = second;
					items[to] = first;
					setSortDraft(items);
					setSortIndex(to);
				}
			} else if (key === "j" || key === "down")
				setSortIndex((index) => Math.min(sortDraft().length - 1, index + 1));
			else if (key === "k" || key === "up")
				setSortIndex((index) => Math.max(0, index - 1));
			else if (key === "enter" || key === "return") {
				setSortCriteria(sortDraft());
				setIndex(0);
				setModal(undefined);
			} else return false;
			return true;
		}
		if (!filterCatalogReady()) return true;
		if (key === "h" || key === "left") setFilterPane("criteria");
		else if (key === "l" || key === "right") setFilterPane("values");
		else if (key === "x") {
			setQuery("");
			setStatusFilter("all");
			setSpanTypeFilter("all");
			setWorkspace(undefined);
			setPage(1);
			setStatusIndex(0);
			setWorkspaceIndex(0);
			setSpanTypeIndex(0);
			setCriterion(0);
			setFilterPane("criteria");
		} else if (["j", "k", "down", "up"].includes(key)) {
			const delta = key === "j" || key === "down" ? 1 : -1;
			if (filterPane() === "criteria")
				setCriterion((value) => Math.max(0, Math.min(2, value + delta)));
			else if (criterion() === 0)
				setStatusIndex((value) =>
					Math.max(0, Math.min(statusOptions.length - 1, value + delta)),
				);
			else if (criterion() === 1)
				setWorkspaceIndex((value) =>
					Math.max(0, Math.min(knownWorkspaces().length, value + delta)),
				);
			else
				setSpanTypeIndex((value) =>
					Math.max(0, Math.min(filterSpanTypes().length, value + delta)),
				);
		} else if (key === "enter" || key === "return") {
			setStatusFilter(statusOptions[statusIndex()]?.value ?? "all");
			setSpanTypeFilter(
				["all", ...filterSpanTypes()][spanTypeIndex()] ?? "all",
			);
			setWorkspace(
				workspaceIndex() === 0
					? undefined
					: knownWorkspaces()[workspaceIndex() - 1]?.changeId,
			);
			setPage(1);
			setIndex(0);
			setModal(undefined);
		} else return false;
		return true;
	};
	const count = () =>
		surface() === "traces"
			? traces().getTraceSummaries().length
			: surface() === "tree"
				? flat().length
				: surface() === "metrics"
					? metrics().getStreams().length
					: surface() === "logs"
						? logs().getLogs().length
						: topology().getServices().length;
	const unregister = useKeymap().registerLayer({
		id: "v2.telemetry",
		priority: 80,
		enabled: () =>
			props.active() && surface() !== "home" && surface() !== "controls",
		commands: [
			{
				name: "telemetry.key",
				run: ({ event }) => {
					if (event.ctrl || event.meta || event.option) return false;
					if (modal())
						return handleModal(
							event.name.toLowerCase(),
							Boolean(event.shift) || /^[A-Z]$/.test(event.name),
						);
					if (searching()) {
						const key = event.name.toLowerCase();
						if (key === "escape") {
							setQuery(searchPrevious);
							setSearching(false);
						} else if (key === "enter" || key === "return") setSearching(false);
						else if (key === "backspace")
							setQuery((value) => value.slice(0, -1));
						else if (event.sequence?.length === 1 && event.sequence >= " ")
							setQuery((value) => (value + event.sequence).slice(0, 256));
						else return false;
						setIndex(0);
						return true;
					}
					const shifted = Boolean(event.shift) || /^[A-Z]$/.test(event.name);
					if (
						surface() === "traces" &&
						shifted &&
						["j", "k"].includes(event.name.toLowerCase())
					) {
						setPage((value) =>
							event.name.toLowerCase() === "j"
								? Math.min(traces().totalPages_, value + 1)
								: Math.max(1, value - 1),
						);
						setIndex(0);
						return true;
					}
					switch (event.name.toLowerCase()) {
						case "f":
							if (surface() === "traces" && shifted) {
								openFilter();
								break;
							}
							return false;
						case "o":
							if (surface() === "traces" && shifted) {
								setSortDraft(sortCriteria().map((item) => ({ ...item })));
								setSortIndex(0);
								setModal("sort");
								break;
							}
							return false;
						case "/":
							searchPrevious = query();
							setSearching(true);
							break;
						case "j":
						case "down":
							if (surface() === "topology") {
								const items = topology().getLayout();
								const current = Math.max(
									0,
									items.findIndex((node) => node.id === service()),
								);
								setService(items[Math.min(items.length - 1, current + 1)]?.id);
							} else setIndex(Math.min(Math.max(0, count() - 1), index() + 1));
							break;
						case "k":
						case "up":
							if (surface() === "topology") {
								const items = topology().getLayout();
								const current = Math.max(
									0,
									items.findIndex((node) => node.id === service()),
								);
								setService(items[Math.max(0, current - 1)]?.id);
							} else setIndex(Math.max(0, index() - 1));
							break;
						case "enter":
						case "return":
							open();
							break;
						case "t": {
							const entry = selectedLog();
							if (surface() !== "log-detail" || !entry?.traceId) return false;
							void openLinkedTrace(entry.traceId, entry.spanId || undefined);
							break;
						}
						case "g":
							setIndex(shifted ? Math.max(0, count() - 1) : 0);
							break;
						case "w":
							if (surface() === "traces") {
								setWorkspace(undefined);
								setPage(1);
								break;
							}
							return false;
						case "h":
						case "l": {
							if (surface() !== "tree") return false;
							const node = flat()[index()];
							if (node)
								setExpansion((previous) => ({
									...previous,
									[`${node.span.traceId}:${node.span.spanId}`]:
										event.name.toLowerCase() === "l",
								}));
							break;
						}
						case "space": {
							const node = flat()[index()];
							if (node) toggle(node);
							break;
						}
						case "r":
							refresh((n) => n + 1);
							break;
						case "]":
							if (surface() === "traces")
								setPage((n) => Math.min(traces().totalPages_, n + 1));
							break;
						case "[":
							if (surface() === "traces") setPage((n) => Math.max(1, n - 1));
							break;
						case "escape":
							navigate(
								surface() === "tree"
									? "traces"
									: surface() === "span"
										? "tree"
										: surface() === "metric-detail"
											? "metrics"
											: surface() === "log-detail"
												? "logs"
												: surface() === "service-detail"
													? "topology"
													: "home",
							);
							break;
						default:
							return false;
					}
					return true;
				},
			},
		],
		bindings: [
			..."abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789 /?.,:_-"
				.split("")
				.map((key) => (key === " " ? "space" : key)),
			"backspace",
			"left",
			"right",
			"j",
			"k",
			"down",
			"up",
			"enter",
			"return",
			"space",
			"r",
			"[",
			"]",
			"escape",
		].map((key) => ({ key, cmd: "telemetry.key" })),
	});
	createEffect(() => {
		if (surface() === "home" || surface() === "controls") return;
		props.catalog([
			{
				title: "Observability",
				keybinds: [
					{ key: "j/k", action: "Move selection", standard: true },
					{ key: "Enter", action: "Open details", standard: true },
					{ key: "Space", action: "Expand/collapse span", short: "expand" },
					{ key: "[/]", action: "Previous/next trace page", short: "page" },
					{ key: "r", action: "Reload telemetry", short: "reload" },
					{ key: "/", action: "Search loaded records", short: "search" },
					...(surface() === "traces"
						? [
								{ key: "F", action: "Filter traces", short: "filter" },
								{ key: "O", action: "Sort traces", short: "sort" },
							]
						: []),
					...(surface() === "log-detail" && selectedLog()?.traceId
						? [{ key: "t", action: "Open correlated trace", short: "trace" }]
						: []),
					{ key: "Esc", action: "Back", standard: true },
				],
			},
		]);
	});
	onCleanup(() => {
		disposed = true;
		epoch++;
		unsubscribe();
		unregister();
		props.catalog([]);
	});
	return (
		<box flexDirection="column" flexGrow={1}>
			<Show when={modal() === "filter"}>
				<FilterModal
					pane={filterPane}
					criterion={criterion}
					statusIndex={statusIndex}
					workspaceIndex={workspaceIndex}
					spanTypeIndex={spanTypeIndex}
					workspaces={knownWorkspaces}
					spanTypes={filterSpanTypes}
					loading={() => !filterCatalogReady()}
					onSelectParameter={(index) => {
						if (filterCatalogReady()) setCriterion(index);
					}}
					onSelectValue={(index) => {
						if (!filterCatalogReady()) return;
						if (criterion() === 0) setStatusIndex(index);
						else if (criterion() === 1) setWorkspaceIndex(index);
						else setSpanTypeIndex(index);
					}}
				/>
			</Show>
			<Show when={modal() === "sort"}>
				<SortModal
					selected={sortIndex}
					criteria={sortDraft}
					onSelectRow={setSortIndex}
				/>
			</Show>
			<Show when={resolvingTrace()}>
				<text>Resolving correlated trace…</text>
			</Show>
			<Show when={loading()}>
				<text>Reading telemetry…</text>
			</Show>
			<Show when={surface() === "home"}>
				<HomeView
					title="Observability"
					destinations={[
						"traces",
						"metrics",
						"logs",
						"topology",
						"controls",
					].map((id) => ({
						id,
						label: id[0].toUpperCase() + id.slice(1),
						description: "",
					}))}
					active={props.active}
					open={navigate}
					selected={index()}
					select={setIndex}
					catalog={props.catalog}
				/>
			</Show>
			<Show when={surface() === "controls"}>
				<TelemetryControls
					client={props.client}
					active={props.active}
					back={() => navigate("home")}
					catalog={props.catalog}
					notify={props.notify}
				/>
			</Show>
			<Show when={surface() === "traces"}>
				<TraceListView
					summaries={() => traces().getTraceSummaries()}
					selectedIndex={index}
					onSelect={setIndex}
					searchMode={searching}
					searchQuery={query}
					resultCount={() => count()}
					page={page}
					totalPages={() => traces().totalPages_}
					loading={loading}
				/>
			</Show>
			<Show when={surface() === "tree"}>
				<TraceTreeView
					roots={roots}
					selectedIndex={index}
					onSelectIndex={setIndex}
					onSelect={(path) => {
						let nodes = roots();
						let selected: TreeNode | undefined;
						for (const part of path) {
							selected = nodes[part];
							nodes = selected?.children ?? [];
						}
						if (selected) {
							const position = flat().findIndex(
								(node) =>
									node.span.traceId === selected?.span.traceId &&
									node.span.spanId === selected?.span.spanId,
							);
							if (position >= 0) setIndex(position);
						}
					}}
					onToggle={toggle}
				/>
			</Show>
			<Show when={surface() === "span" && span()}>
				{(node) => <SpanDetailView node={node} />}
			</Show>
			<Show when={surface() === "metrics"}>
				<MetricsView
					searchMode={searching}
					searchQuery={query}
					store={metrics()}
					selectedIndex={index}
					onSelectIndex={setIndex}
					onOpen={(name, serviceName, id) => {
						setMetric({ name, service: serviceName, id });
						navigate("metric-detail");
					}}
				/>
			</Show>
			<Show when={surface() === "metric-detail"}>
				<MetricDetailView
					store={metrics()}
					name={metric().name}
					serviceName={metric().service}
					streamId={metric().id}
				/>
			</Show>
			<Show when={surface() === "logs"}>
				<LogsView
					searchMode={searching}
					searchQuery={query}
					store={logs()}
					selectedIndex={index}
					onSelectIndex={setIndex}
					onOpen={(position) => {
						setIndex(position);
						setSelectedLog(logs().getLogs()[position]);
						setSurface("log-detail");
					}}
				/>
			</Show>
			<Show when={surface() === "log-detail"}>
				<LogDetailView
					store={detailLogs()}
					index={0}
					onTraceLink={(id, spanId) => {
						void openLinkedTrace(id, spanId);
					}}
				/>
			</Show>
			<Show when={surface() === "topology"}>
				<TopologyView
					store={topology()}
					selectedService={service}
					onSelect={setService}
				/>
			</Show>
			<Show when={surface() === "service-detail"}>
				<ServiceDetailView store={topology()} id={service() ?? ""} />
			</Show>
		</box>
	);
}
