/** Agents panel (establish-opencode-boundaries, task 6.1).
 *
 * One row per agent: role, status badge, runtime/model line, verifier verdict
 * with duration, finding counts and the metrics line. Props-in: the agent list
 * comes from the route's dashboard data, the live activity for a durable run
 * from the route's host watches, and the narrow-terminal rule for the finding
 * summary is a prop rather than a global read. */

import { TextAttributes } from "@opentui/core";
import { Badge, type Highlight, Panel, SelectableList, uiColors } from "@ui";
import { Show } from "solid-js";
import type { DashboardData } from "../../../contracts/workflow.ts";
import { formatDuration } from "../../../workflow/format.ts";
import type { AgentActivity } from "../agent-activity.ts";
import { agentMetricLine, agentRuntimeModelLine } from "../projections.ts";
import { FindingCountSummary } from "../ui/FindingCountSummary.tsx";

export interface AgentsPanelProps {
	readonly data: DashboardData;
	readonly active: boolean;
	readonly selectedIndex: number;
	/** The finding summary takes three rows below this width. */
	readonly narrow: boolean;
	/** What a durable run is doing right now, from its host watch. Absent (or
	 * nothing in flight) keeps the workflow status badge. */
	readonly activity?: (role: string) => AgentActivity | undefined;
}

export function AgentsPanel(props: AgentsPanelProps) {
	const findingSummaryRows = () => (props.narrow ? 3 : 1);
	/** The row heights, in item order: role + runtime/model, plus the metrics
	 * line and the finding summary when present. `SelectableList` needs them to
	 * fill the panel — a single estimate cannot cover two- to five-line rows. */
	const rowHeight = (agent: DashboardData["agents"][number]): number =>
		2 +
		(agentMetricLine(agent.metrics) ? 1 : 0) +
		(agent.findingCounts ? findingSummaryRows() : 0);
	const rowHeights = () => props.data.agents.map(rowHeight);
	return (
		<Panel
			title="Agents"
			accent={uiColors.accent}
			active={props.active}
			style={{
				flexGrow: 1,
				flexBasis: 0,
				minWidth: 0,
				height: "100%",
			}}
		>
			<SelectableList
				items={props.data.agents}
				itemHeights={rowHeights()}
				selectedIndex={props.active ? props.selectedIndex : -1}
				renderItem={(agent, _selected) => {
					const timeline = () =>
						props.data.verifierTimeline.find(
							(item) => item.role === agent.role,
						);
					const metricsLine = () => agentMetricLine(agent.metrics);
					const runtimeModelLine = () =>
						agentRuntimeModelLine(
							agent.runtime,
							timeline()?.model ?? agent.model,
						);
					// A live watch frame outranks the coarse workflow status while work is in
					// flight: the badge then names what the run is doing (bash/read/thinking)
					// instead of the status word it will only settle into later.
					const activity = () => {
						const current = props.activity?.(agent.role);
						return current?.active ? current : undefined;
					};
					const highlight = (): Highlight => {
						const running = activity();
						if (running)
							return running.tone === "blocked" ? "warning" : "highlight2";
						return agent.status === "working"
							? "highlight2"
							: agent.status === "completed"
								? "positive"
								: agent.status === "blocked"
									? "warning"
									: agent.status === "failed"
										? "negative"
										: "secondary";
					};
					return (
						<box
							width="100%"
							height={rowHeight(agent)}
							flexDirection="column"
							paddingRight={1}
						>
							<box width="100%" height={1} flexDirection="row">
								<box flexGrow={1} minWidth={0} overflow="hidden">
									<text
										fg={uiColors.textPrimary}
										attributes={TextAttributes.BOLD}
									>
										{agent.role}
									</text>
								</box>
								<Badge
									text={activity()?.label ?? agent.status}
									appearance="text"
									highlight={highlight()}
									{...(activity()?.tone === "blocked"
										? { animatedTone: "warning" as const }
										: {})}
									animation={
										activity()?.tone === "working" ||
										(!activity() && agent.status === "working")
											? "aurora"
											: "static"
									}
									attributes={TextAttributes.BOLD}
									// No `transitionKey`: the badge is the agent's live status, so a
									// bash→read→thinking change swaps instantly instead of wiping
									// through the previous word (the aurora/tone animation still
									// runs while a step is active).
								/>
							</box>
							<box width="100%" height={1} flexDirection="row">
								<box flexGrow={1} minWidth={0} overflow="hidden">
									<text fg={uiColors.textMuted}>
										{runtimeModelLine() ??
											(timeline()
												? "default"
												: agent.role.endsWith("verifier")
													? "Awaiting verification run"
													: "Interactive workflow agent")}
									</text>
								</box>
								<Show when={timeline()}>
									{(entry) => {
										const duration = entry().durationSeconds;
										return (
											<text
												fg={
													entry().status === "PASS"
														? uiColors.success
														: entry().status === "FAIL"
															? uiColors.error
															: uiColors.warning
												}
											>
												{entry().status}
												{duration !== undefined
													? ` · ${formatDuration(duration)}`
													: ""}
												{entry().fallback ? " · fallback" : ""}
											</text>
										);
									}}
								</Show>
							</box>
							<Show when={agent.findingCounts}>
								{(counts) => (
									<FindingCountSummary
										counts={counts()}
										compact={findingSummaryRows() === 3}
									/>
								)}
							</Show>
							<Show when={metricsLine()}>
								<box width="100%" height={1} overflow="hidden">
									<text fg={uiColors.textMuted}>{metricsLine()}</text>
								</box>
							</Show>
						</box>
					);
				}}
			/>
		</Panel>
	);
}
