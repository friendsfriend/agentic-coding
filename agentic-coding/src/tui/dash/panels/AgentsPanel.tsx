/** Agents panel (establish-opencode-boundaries, task 6.1).
 *
 * One row per agent: role, status badge, runtime/model line, verifier verdict
 * with duration, finding counts and the metrics line. Props-in: the agent list
 * comes from the route's dashboard data, the live activity for a durable run
 * from the route's host watches, and the narrow-terminal rule for the finding
 * summary is a prop rather than a global read. */

import {
	Badge,
	type Highlight,
	Panel,
	SelectableList,
	uiColors,
} from "@agentic-coding/ui";
import { type BoxRenderable, TextAttributes } from "@opentui/core";
import { createSignal, Show } from "solid-js";
import type { DashboardData } from "../../../contracts/workflow.ts";
import { formatDuration } from "../../../workflow/format.ts";
import type { AgentActivity } from "../agent-activity.ts";
import { agentMetricLine, agentRuntimeModelLine } from "../projections.ts";
import { FindingCountSummary } from "../ui/FindingCountSummary.tsx";

export interface AgentsPanelProps {
	readonly data: DashboardData;
	readonly active: boolean;
	readonly selectedIndex: number;
	/** Exact route focus, including a transient superseded run row. */
	readonly focusedRunId?: string | undefined;
	readonly historicalRunId?: string | undefined;
	/** The finding summary takes three rows below this width. */
	readonly narrow: boolean;
	/** What a durable run is doing right now, from its host watch. Absent (or
	 * nothing in flight) keeps the workflow status badge. */
	readonly activity?: (
		role: string,
		runId?: string,
	) => AgentActivity | undefined;
	/** True while the row's status is still provisional: the cheap seed before
	 * the full observation lands, or a durable watch before its first frame.
	 * The badge then gathers instead of naming a status that may be wrong. */
	readonly statusPending?: (role: string, runId?: string) => boolean;
	/** True while per-agent details (the verifier verdict) are still derived
	 * from the seed rather than the full observation. */
	readonly detailsPending?: boolean;
	/** Pointer: a tap selects a row (the keyboard's `j`/`k`). */
	readonly onSelectIndex?: (index: number) => void;
	/** Pointer: a tap on the selected row activates it (the keyboard's `Enter`). */
	readonly onActivateRow?: (index: number) => void;
	/** Pointer: a tap anywhere in the panel focuses it (`J/K/H/L`). */
	readonly onFocusRequest?: () => void;
}

export function AgentsPanel(props: AgentsPanelProps) {
	// The panel's own body height, measured once the layout has run. The list
	// windows on these rows: a list that budgeted by the terminal's height instead
	// painted rows past the panel — clipped, and taking the cursor out of view
	// with them, which is what broke scrolling while the Evidence row was on
	// screen (and whenever the shell left the dashboard fewer rows than the
	// terminal has). `undefined` until the first measurement, so the list keeps its
	// host-chrome fallback for the frame that precedes it.
	const [bodyLines, setBodyLines] = createSignal<number | undefined>(undefined);
	const [bodyColumns, setBodyColumns] = createSignal(30);
	let body: BoxRenderable | undefined;
	const measure = () => {
		if (!body) return;
		const next = Math.max(1, body.height ?? 0);
		if (next !== bodyLines()) setBodyLines(next);
		// Reserve the selection marker and row padding. Identity text wraps by
		// character so even a full historical UUID remains visible when narrow.
		setBodyColumns(Math.max(1, body.width - 4));
	};
	const findingSummaryRows = () => (props.narrow ? 3 : 1);
	/** The row heights, in item order: role + runtime/model, plus the metrics
	 * line and the finding summary when present. `SelectableList` needs them to
	 * fill the panel — a single estimate cannot cover two- to five-line rows. */
	const focusCaption = (agent: DashboardData["agents"][number]) =>
		agent.runId === props.historicalRunId ? "Historical run:" : "Run:";
	const focusLines = (agent: DashboardData["agents"][number]) =>
		agent.runId && agent.runId === props.focusedRunId
			? Math.ceil(focusCaption(agent).length / bodyColumns()) +
				Math.ceil(agent.runId.length / bodyColumns())
			: 0;
	const failureDetailLines = (agent: DashboardData["agents"][number]) => {
		const detail = props.activity?.(agent.role, agent.runId)?.detail;
		return detail ? Math.max(1, Math.ceil(detail.length / bodyColumns())) : 0;
	};
	const rowHeight = (agent: DashboardData["agents"][number]): number =>
		2 +
		failureDetailLines(agent) +
		focusLines(agent) +
		(agentMetricLine(agent.metrics) ? 1 : 0) +
		(agent.findingCounts ? findingSummaryRows() : 0);
	const rowHeights = () => props.data.agents.map(rowHeight);
	return (
		<Panel
			title="Agents"
			accent={uiColors.accent}
			active={props.active}
			{...(props.onFocusRequest
				? { onFocusRequest: props.onFocusRequest }
				: {})}
			style={{
				flexGrow: 1,
				flexBasis: 0,
				minWidth: 0,
				height: "100%",
			}}
		>
			<box
				ref={(element: BoxRenderable) => {
					body = element;
					queueMicrotask(measure);
				}}
				onSizeChange={measure}
				style={{
					width: "100%",
					flexGrow: 1,
					minHeight: 0,
					flexDirection: "column",
				}}
			>
				<SelectableList
					items={props.data.agents}
					availableLines={bodyLines()}
					itemHeights={rowHeights()}
					selectedIndex={props.active ? props.selectedIndex : -1}
					{...(props.onSelectIndex ? { onSelect: props.onSelectIndex } : {})}
					{...(props.onActivateRow ? { onActivate: props.onActivateRow } : {})}
					renderItem={(agent, _selected) => {
						const timeline = () =>
							agent.runId && agent.runId === props.historicalRunId
								? undefined
								: props.data.verifierTimeline.find(
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
							const current = props.activity?.(agent.role, agent.runId);
							return current?.active || current?.detail ? current : undefined;
						};
						// A live step is already the truth; otherwise a provisional
						// status gathers instead of painting the seed's guess.
						const statusLoading = () =>
							!activity() &&
							props.statusPending?.(agent.role, agent.runId) === true;
						const highlight = (): Highlight => {
							if (statusLoading()) return "highlight2";
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
								<Show when={agent.runId && agent.runId === props.focusedRunId}>
									<text
										fg={uiColors.textMuted}
										height={focusLines(agent)}
										wrapMode="char"
									>
										{focusCaption(agent)}
										{"\n"}
										{agent.runId}
									</text>
								</Show>
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
										text={
											statusLoading()
												? "loading"
												: (activity()?.label ??
													agent.admissionState ??
													agent.status)
										}
										appearance="text"
										highlight={highlight()}
										{...(activity()?.tone === "blocked"
											? { animatedTone: "warning" as const }
											: {})}
										animation={
											statusLoading() ||
											activity()?.tone === "working" ||
											(!activity() &&
												!agent.admissionState &&
												agent.status === "working")
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
									<Show when={activity()?.detail}>
										{(detail) => (
											<text
												fg={uiColors.warning}
												height={failureDetailLines(agent)}
												wrapMode="char"
											>
												{detail()}
											</text>
										)}
									</Show>
									<Show when={props.detailsPending ? undefined : timeline()}>
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
			</box>
		</Panel>
	);
}
