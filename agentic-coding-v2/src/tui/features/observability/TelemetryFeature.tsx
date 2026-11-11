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
	const [payload, setPayload] = createSignal<unknown>();
	const [trace, setTrace] = createSignal("");
	const [span, setSpan] = createSignal<TreeNode>();
	const [metric, setMetric] = createSignal({ name: "", service: "" });
	const [service, setService] = createSignal<string>();
	const [expanded, setExpanded] = createSignal(0);
	let epoch = 0;
	let disposed = false;
	const navigate = (next: string) => {
		setIndex(0);
		setSurface(next);
	};
	createEffect(() => {
		const current = surface();
		const selectedTrace = trace();
		const currentPage = page();
		revision();
		const generation = ++epoch;
		if (current === "home" || current.endsWith("-detail") || current === "span")
			return;
		setLoading(true);
		const signal =
			current === "tree" ? "spans" : current === "topology" ? "spans" : current;
		if (!["traces", "spans", "metrics", "logs"].includes(signal)) return;
		void props.client
			.call("telemetry.read", {
				signal: signal as "traces" | "spans" | "metrics" | "logs",
				...(current === "traces" ? { page: currentPage, perPage: 50 } : {}),
				...(current === "tree" ? { changeId: selectedTrace } : {}),
			})
			.then((result) => {
				if (disposed || generation !== epoch) return;
				setPayload(result.value);
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
		const value = payload();
		if (surface() === "traces" && value && !Array.isArray(value))
			store.setSummaryPage(value as TraceSummaryPage);
		if (["tree", "span"].includes(surface()) && Array.isArray(value))
			store.setTraceSpans(value as SpanData[]);
		return store;
	});
	const logs = createMemo(
		() =>
			new LogStore(Array.isArray(payload()) ? (payload() as LogData[]) : []),
	);
	const metrics = createMemo(
		() =>
			new MetricStore(
				Array.isArray(payload()) ? (payload() as MetricData[]) : [],
			),
	);
	const topology = createMemo(() => {
		const store = new TopologyStore();
		store.load(Array.isArray(payload()) ? (payload() as SpanData[]) : []);
		return store;
	});
	const roots = createMemo(() => traces().getSpanTree(trace()));
	const flat = () => {
		expanded();
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
					switch (event.name.toLowerCase()) {
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
							if (node) {
								node.expanded = !node.expanded;
								setExpanded((n) => n + 1);
							}
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
					{ key: "Esc", action: "Back", standard: true },
				],
			},
		]);
	});
	onCleanup(() => {
		disposed = true;
		epoch++;
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
					searchMode={() => false}
					searchQuery={() => ""}
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
					onSelect={() => {}}
					onToggle={(node) => {
						node.expanded = !node.expanded;
						setExpanded((n) => n + 1);
					}}
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
						setSurface("log-detail");
					}}
				/>
			</Show>
			<Show when={surface() === "log-detail"}>
				<LogDetailView
					store={logs()}
					index={index()}
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
