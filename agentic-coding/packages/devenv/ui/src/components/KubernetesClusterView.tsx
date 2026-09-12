/** @jsxImportSource @opentui/solid */

import type { KubernetesClusterStatus } from "@devenv/types";
import { For, type JSX, Show } from "solid-js";
import { uiColors } from "../colors";
import { AnimatedStatusText } from "./AnimatedStatusText";
import { HighlightedText, highlightColor } from "./Highlight";
import {
	PropertiesList,
	type PropertyRow,
	propertyBadges,
} from "./PropertiesList";
import { ResourceTimelineCharts } from "./ResourceTimelineCharts";
import { ScrollableContent } from "./ScrollableContent";
import { SearchHeader } from "./SearchHeader";

export interface KubernetesClusterViewProps {
	status?: KubernetesClusterStatus | null;
	loading?: boolean;
	error?: string | null;
	cpuHistory?: number[];
	memoryHistory?: number[];
	height?: number;
	activePanelIndex?: number;
	onClusterInfoScrollBoxReady?: (
		ref: import("@opentui/core").ScrollBoxRenderable,
	) => void;
	onPodsScrollBoxReady?: (
		ref: import("@opentui/core").ScrollBoxRenderable,
	) => void;
	onWorkloadsScrollBoxReady?: (
		ref: import("@opentui/core").ScrollBoxRenderable,
	) => void;
}

function stateHighlight(state?: string) {
	if (state === "running") return "positive" as const;
	if (state === "degraded" || state === "unreachable")
		return "warning" as const;
	return "secondary" as const;
}

export function kubernetesClusterSummaryLines(
	status?: KubernetesClusterStatus | null,
): string[] {
	if (!status)
		return ["State: missing", "Live usage unavailable", "No node data"];
	const lines = [
		`State: ${status.state}`,
		`Name: ${status.clusterName}  Context: ${status.contextName}  Provider: ${status.provider || "unknown"}`,
		`Exists: ${status.exists ? "yes" : "no"}  Reachable: ${status.reachable ? "yes" : "no"}  Version: ${status.kubernetesVersion || "n/a"}`,
	];
	lines.push(
		status.stats
			? `CPU ${status.stats.cpuPercent.toFixed(1)}%`
			: "Live usage unavailable",
	);
	lines.push(
		`Pods: ${status.pods.total} total, ${status.pods.running} running, ${status.pods.failed} failed`,
	);
	return lines;
}

function formatMB(bytes: number): string {
	const mb = Math.round(bytes / (1024 * 1024));
	return `${mb}MB`;
}

function PanelHeader(props: { title: string; children?: JSX.Element }) {
	return (
		<SearchHeader>
			<box style={{ width: "100%", flexDirection: "row" }}>
				<HighlightedText text={props.title} highlight="primary" />
				{props.children}
			</box>
		</SearchHeader>
	);
}

export function PanelBox(props: {
	title: string;
	active: boolean;
	headerChildren?: JSX.Element;
	children: JSX.Element;
	style?: Record<string, unknown>;
}) {
	return (
		<box
			backgroundColor={uiColors.bgMantle}
			style={{
				width: "100%",
				flexGrow: 1,
				flexBasis: 0,
				flexDirection: "column",
				overflow: "hidden",
				...props.style,
			}}
		>
			<PanelHeader title={props.title}>{props.headerChildren}</PanelHeader>
			<box
				style={{
					width: "100%",
					flexDirection: "row",
					flexGrow: 1,
					minHeight: 0,
				}}
			>
				<box
					backgroundColor={props.active ? uiColors.primary : uiColors.bgMantle}
					style={{ width: 1, height: "100%", flexShrink: 0 }}
				/>
				<box
					style={{
						flexGrow: 1,
						flexDirection: "column",
						overflow: "hidden",
						minWidth: 0,
					}}
				>
					{props.children}
				</box>
			</box>
		</box>
	);
}

export function KubernetesClusterView(props: KubernetesClusterViewProps) {
	const s = () => props.status;
	const state = () => s()?.state ?? "missing";
	const stats = () => s()?.stats;
	const clusterRows = (): PropertyRow[] => [
		{
			label: "State",
			value: propertyBadges([
				{ label: state(), highlight: stateHighlight(state()) },
			]),
		},
		{ label: "Name", value: s()?.clusterName ?? "devenv" },
		{ label: "Context", value: s()?.contextName ?? "kind-devenv" },
		{
			label: "Provider",
			value: s()?.provider || "unknown",
			valueHighlight: "secondary",
		},
		{
			label: "Exists",
			value: s()?.exists ? "yes" : "no",
			valueHighlight: s()?.exists ? "positive" : "negative",
		},
		{
			label: "Reachable",
			value: s()?.reachable ? "yes" : "no",
			valueHighlight: s()?.reachable ? "positive" : "negative",
		},
		{ label: "Version", value: s()?.kubernetesVersion || "n/a" },
	];
	const podsText = () =>
		`${s()?.pods.total ?? 0} total, ${s()?.pods.running ?? 0} running, ${s()?.pods.failed ?? 0} failed`;
	const podStatusHighlight = (status: string) => {
		if (status === "Running" || status === "Succeeded")
			return "positive" as const;
		if (status === "Failed") return "negative" as const;
		if (status === "Pending") return "warning" as const;
		return "secondary" as const;
	};
	const workloadRows = (): PropertyRow[] => [
		{
			label: "Pods",
			value:
				(s()?.pods.failed ?? 0) > 0
					? propertyBadges([{ label: podsText(), highlight: "negative" }])
					: podsText(),
		},
		{
			label: "Namespaces",
			value:
				(s()?.namespaces ?? [])
					.map((ns) => `${ns.name}(${ns.pods})`)
					.join(", ") || "none",
			valueHighlight:
				(s()?.namespaces ?? []).length > 0 ? "secondary" : "secondary",
		},
	];

	return (
		<box
			backgroundColor={uiColors.bgBase}
			style={{
				width: "100%",
				flexGrow: 1,
				minHeight: 0,
				flexDirection: "row",
			}}
		>
			{/* Left Column — Cluster Info + Resources */}
			<box
				backgroundColor={uiColors.bgBase}
				style={{
					width: "50%",
					height: "100%",
					flexDirection: "column",
				}}
			>
				{/* Cluster Info Panel */}
				<PanelBox
					title="Cluster"
					active={props.activePanelIndex === 0}
					headerChildren={
						<Show when={props.loading}>
							<AnimatedStatusText
								text="refreshing…"
								intent="load"
								backgroundColor={uiColors.bgSurface1}
							/>
						</Show>
					}
				>
					<ScrollableContent
						axes={["x", "y"]}
						style={{ width: "100%", flexGrow: 1, minHeight: 0 }}
						onScrollBoxReady={props.onClusterInfoScrollBoxReady}
					>
						<Show
							when={props.error}
							fallback={<PropertiesList rows={clusterRows()} labelWidth={10} />}
						>
							<box style={{ paddingLeft: 1, paddingRight: 1 }}>
								<text fg={highlightColor("negative")}>
									Error: {props.error}
								</text>
							</box>
						</Show>
					</ScrollableContent>
				</PanelBox>

				{/* Resources Panel */}
				<PanelBox title="Resources" active={props.activePanelIndex === 1}>
					<Show
						when={stats() !== undefined}
						fallback={
							<box style={{ paddingLeft: 1, paddingRight: 1, flexGrow: 1 }}>
								<text fg={highlightColor("secondary")}>
									No container resources — cluster may be missing or using
									podman
								</text>
							</box>
						}
					>
						{(() => {
							const st = stats();
							if (!st) return null;
							return (
								<ResourceTimelineCharts
									cpu={{
										title: "CPU",
										value: `${st.cpuPercent.toFixed(1)}%`,
										values: props.cpuHistory ?? [],
										color: uiColors.primary,
									}}
									memory={{
										title: "MEM",
										value: `${formatMB(st.memoryUsageBytes)}/${formatMB(st.memoryLimitBytes)}`,
										values: props.memoryHistory ?? [],
										color: uiColors.success,
									}}
								/>
							);
						})()}
					</Show>
				</PanelBox>
			</box>

			{/* Right Column — Nodes + Workloads + Warnings */}
			<box
				backgroundColor={uiColors.bgBase}
				style={{
					width: "50%",
					height: "100%",
					flexDirection: "column",
				}}
			>
				{/* Pods Panel */}
				<PanelBox title="Pods" active={props.activePanelIndex === 2}>
					<ScrollableContent
						axes={["x", "y"]}
						style={{ width: "100%", flexGrow: 1, minHeight: 0 }}
						onScrollBoxReady={props.onPodsScrollBoxReady}
					>
						<Show
							when={(s()?.podList?.length ?? 0) > 0}
							fallback={
								<box style={{ paddingLeft: 1, paddingRight: 1 }}>
									<text fg={highlightColor("secondary")}>No pod data</text>
								</box>
							}
						>
							<For each={s()?.podList ?? []}>
								{(pod) => (
									<box
										style={{
											height: 1,
											flexDirection: "row",
											paddingLeft: 1,
											paddingRight: 1,
										}}
									>
										<box style={{ width: "45%", flexShrink: 0 }}>
											<text fg={highlightColor("primary")}>{pod.name}</text>
										</box>
										<box style={{ width: "20%", flexShrink: 0 }}>
											<text
												fg={
													podStatusHighlight(pod.status) === "positive"
														? highlightColor("positive")
														: podStatusHighlight(pod.status) === "negative"
															? highlightColor("negative")
															: podStatusHighlight(pod.status) === "warning"
																? highlightColor("warning")
																: highlightColor("secondary")
												}
											>
												{pod.status}
											</text>
										</box>
										<text fg={highlightColor("secondary")}>
											{pod.namespace}
										</text>
									</box>
								)}
							</For>
						</Show>
					</ScrollableContent>
				</PanelBox>

				{/* Workloads Panel */}
				<PanelBox title="Workloads" active={props.activePanelIndex === 3}>
					<ScrollableContent
						axes={["x", "y"]}
						style={{ width: "100%", flexGrow: 1, minHeight: 0 }}
						onScrollBoxReady={props.onWorkloadsScrollBoxReady}
					>
						<PropertiesList rows={workloadRows()} labelWidth={12} />
						<Show
							when={(s()?.releases.length ?? 0) > 0}
							fallback={
								<box style={{ paddingLeft: 1, paddingRight: 1 }}>
									<text fg={highlightColor("secondary")}>
										No DevEnv Helm releases
									</text>
								</box>
							}
						>
							<For each={s()?.releases ?? []}>
								{(release) => (
									<box style={{ paddingLeft: 1, paddingRight: 1 }}>
										<text fg={highlightColor("secondary")}>
											{release.namespace}/{release.name}
										</text>
										<text fg={highlightColor("secondary")}>
											{" "}
											{release.status} {release.chart || ""}
										</text>
									</box>
								)}
							</For>
						</Show>
					</ScrollableContent>
				</PanelBox>
			</box>
		</box>
	);
}
