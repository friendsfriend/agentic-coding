/** Change panel (establish-opencode-boundaries, task 6.1): the workflow's
 * status, Git state, flow pin, ticket, plan quality, verification progress and
 * request. Props-in: the panel owns no state and fetches nothing. */
import {
	Badge,
	HighlightedText,
	Panel,
	ScrollableContent,
	uiColors,
} from "@ui";
import { Show } from "solid-js";
import type { DashboardData } from "../../../contracts/workflow.ts";
import { PhaseStatus } from "../ui/PhaseStatus.tsx";

export interface ChangePanelProps {
	readonly data: DashboardData;
	readonly active: boolean;
	readonly onScrollBoxReady?: (box: unknown) => void;
}

export function ChangePanel(props: ChangePanelProps) {
	const git = () => props.data.gitStatus;
	const state = () => props.data.state;
	return (
		<Panel
			title={`Change (${props.data.age} ago)`}
			accent={uiColors.primary}
			active={props.active}
			style={{ width: "100%", flexGrow: 1, minHeight: 0 }}
		>
			<ScrollableContent
				onScrollBoxReady={(box) => props.onScrollBoxReady?.(box)}
			>
				<box flexDirection="row">
					<box width={7}>
						<text fg={uiColors.textMuted}>STATUS</text>
					</box>
					<PhaseStatus state={state()} />
				</box>
				<text fg={uiColors.textMuted}>GIT STATUS</text>
				<Show when={git().available}>
					<Show when={git().branch}>
						<box flexDirection="row" overflow="hidden">
							<text fg={uiColors.success} flexShrink={0} wrapMode="none">
								+{git().addedFiles}
							</text>
							<text fg={uiColors.warning} flexShrink={0} wrapMode="none">
								*{git().changedFiles}
							</text>
							<text fg={uiColors.error} flexShrink={0} wrapMode="none">
								-{git().deletedFiles}{" "}
							</text>
							<Show
								when={!git().noUpstream}
								fallback={
									<text fg={uiColors.textMuted} flexShrink={0} wrapMode="none">
										
									</text>
								}
							>
								<text fg={uiColors.success} flexShrink={0} wrapMode="none">
									↑{git().ahead}{" "}
								</text>
								<text fg={uiColors.success} flexShrink={0} wrapMode="none">
									↓{git().behind}
								</text>
							</Show>
							<text fg={uiColors.textSecondary} flexShrink={0} wrapMode="none">
								{" "}
								{git().branch}
							</text>
						</box>
					</Show>
				</Show>
				<Show when={state().definition}>
					{(definition) => (
						<box flexDirection="row">
							<box width={7}>
								<text fg={uiColors.textMuted}>FLOW</text>
							</box>
							<text fg={uiColors.textSecondary}>
								{definition().label} · v{definition().version}
							</text>
						</box>
					)}
				</Show>
				<Show when={state().ticketNumber}>
					<box flexDirection="row">
						<box width={7}>
							<text fg={uiColors.textMuted}>TICKET</text>
						</box>
						<HighlightedText
							text={state().ticketNumber ?? ""}
							highlight="highlight"
						/>
					</box>
				</Show>
				<Show when={state().planQuality}>
					{(plan) => (
						<box flexDirection="row">
							<box width={7}>
								<text fg={uiColors.textMuted}>PLAN</text>
							</box>
							<Badge
								text={plan().passed ? "PASS" : "FAIL"}
								highlight={plan().passed ? "positive" : "negative"}
							/>
							<text fg={uiColors.textSecondary}>
								{" "}
								{plan().specFiles} specs · {plan().taskCount} tasks
							</text>
						</box>
					)}
				</Show>
				<Show when={state().verificationTier}>
					{(tier) => {
						const roles = () => state().verificationRoles ?? [];
						const completed = () =>
							roles().filter((role) => state().verificationResults?.[role])
								.length;
						return (
							<box flexDirection="row">
								<box width={7}>
									<text fg={uiColors.textMuted}>VERIFY</text>
								</box>
								<Badge text={tier().toUpperCase()} highlight="highlight2" />
								<text fg={uiColors.textSecondary}>
									{" "}
									{completed()}/{roles().length} reviews · round{" "}
									{state().verificationRound}
								</text>
							</box>
						);
					}}
				</Show>
				<text fg={uiColors.textMuted}>REQUEST</text>
				<box paddingLeft={1}>
					<text fg={uiColors.textPrimary}>{props.data.request}</text>
				</box>
			</ScrollableContent>
		</Panel>
	);
}
