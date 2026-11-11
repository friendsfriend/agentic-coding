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
	SpanData,
	TraceSummaryPage,
	TreeNode,
} from "../../../telemetry/contracts.ts";
import type { ClientConnection } from "../../client/connection.ts";
import type { KeybindSection } from "../../ui/index.ts";
import { HomeView } from "../home/HomeView.tsx";
import { LogStore } from "./model/logStore.ts";
import { MetricStore } from "./model/metricStore.ts";
import { TopologyStore } from "./model/topologyStore.ts";
import { TraceStore } from "./model/traceStore.ts";
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
		value: unknown;
	}>();
	const [query, setQuery] = createSignal("");
	const [searching, setSearching] = createSignal(false);
	const [trace, setTrace] = createSignal("");
	const [span, setSpan] = createSignal<TreeNode>();
	const [metric, setMetric] = createSignal({ name: "", service: "" });
	const [service, setService] = createSignal<string>();
	const [selectedLog, setSelectedLog] = createSignal<LogData>();
	const detailLogs = createMemo(
		() => new LogStore(selectedLog() ? [selectedLog() as LogData] : []),
	);
	const [expansion, setExpansion] = createSignal<Record<string, boolean>>({});
	let epoch = 0;
	let disposed = false;
	const navigate = (next: string) => {
		setIndex(0);
		setSearching(false);
		setSurface(next);
	};
	createEffect(() => {
		const current = surface();
		const selectedTrace = trace();
		const currentPage = page();
		revision();
		const generation = ++epoch;
		if (current === "home") {
			setLoading(false);
			return;
		}
		setLoading(true);
		const signal = ["tree", "span", "topology", "service-detail"].includes(
			current,
		)
			? "spans"
			: current === "metric-detail"
				? "metrics"
				: current === "log-detail"
					? "logs"
					: current;
		if (!["traces", "spans", "metrics", "logs"].includes(signal)) return;
		void props.client
			.call("telemetry.read", {
				signal: signal as "traces" | "spans" | "metrics" | "logs",
				...(current === "traces" ? { page: currentPage, perPage: 50 } : {}),
				...(["tree", "span"].includes(current)
					? { changeId: selectedTrace }
					: {}),
			})
			.then((result) => {
				if (disposed || generation !== epoch) return;
				setPayload({
					signal: current === "tree" || current === "span" ? "tree" : signal,
					value: result.value,
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
		if (response?.signal === "tree" && Array.isArray(response.value))
			store.setTraceSpans(response.value as SpanData[]);
		store.applyFilter(query());
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
		store.load(
			response?.signal === "spans" && Array.isArray(response.value)
				? (response.value as SpanData[])
				: [],
		);
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
		return clone(traces().getSpanTree(trace()));
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
					setMetric({ name: entry.name, service: entry.serviceName });
					navigate("metric-detail");
				}
				break;
			}
			case "logs":
				setSelectedLog(logs().getLogs()[index()]);
				setSurface("log-detail");
				break;
			case "topology": {
				const entry = topology().getServices()[index()];
				if (entry) {
					setService(entry.id);
					navigate("service-detail");
				}
				break;
			}
		}
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
		enabled: () => props.active() && surface() !== "home",
		commands: [
			{
				name: "telemetry.key",
				run: ({ event }) => {
					if (event.ctrl || event.meta || event.option) return false;
					if (searching()) {
						const key = event.name.toLowerCase();
						if (key === "escape" || key === "enter" || key === "return")
							setSearching(false);
						else if (key === "backspace")
							setQuery((value) => value.slice(0, -1));
						else if (event.sequence?.length === 1 && event.sequence >= " ")
							setQuery((value) => (value + event.sequence).slice(0, 256));
						else return false;
						setIndex(0);
						return true;
					}
					switch (event.name.toLowerCase()) {
						case "/":
							setSearching(true);
							break;
						case "j":
						case "down":
							setIndex(Math.min(Math.max(0, count() - 1), index() + 1));
							break;
						case "k":
						case "up":
							setIndex(Math.max(0, index() - 1));
							break;
						case "enter":
						case "return":
							open();
							break;
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
		if (surface() === "home") return;
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
			<Show when={loading()}>
				<text>Reading telemetry…</text>
			</Show>
			<Show when={surface() === "home"}>
				<HomeView
					destinations={["traces", "metrics", "logs", "topology"].map((id) => ({
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
								(node) => node.span.spanId === selected?.span.spanId,
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
					store={metrics()}
					selectedIndex={index}
					onSelectIndex={setIndex}
					onOpen={(name, serviceName) => {
						setMetric({ name, service: serviceName });
						navigate("metric-detail");
					}}
				/>
			</Show>
			<Show when={surface() === "metric-detail"}>
				<MetricDetailView
					store={metrics()}
					name={metric().name}
					serviceName={metric().service}
				/>
			</Show>
			<Show when={surface() === "logs"}>
				<LogsView
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
					onTraceLink={(id) => {
						setTrace(id);
						navigate("tree");
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
