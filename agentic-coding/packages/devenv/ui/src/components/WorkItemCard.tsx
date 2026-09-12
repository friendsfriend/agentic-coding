/** @jsxImportSource @opentui/solid */

import { TextAttributes } from "@opentui/core";
import { useTerminalDimensions } from "@opentui/solid";
import { createMemo, For, type JSXElement, Show } from "solid-js";
import { uiColors } from "../colors";
import {
	type StatusAnimationIntent,
	statusAnimationModel,
} from "./AnimatedStatusText";
import { Badge } from "./Badge";
import type { Highlight } from "./Highlight";
import { MatchedText } from "./MatchedText";
import { RunningText } from "./RunningText";

export interface WorkItemCardProps {
	marker: string;
	title: string;
	titleQuery?: string;
	statusText: string;
	statusColor?: string;
	statusBadgeHighlight?: string;
	statusAnimationIntent?: StatusAnimationIntent;
	statusTransitionKey?: string;
	/** Replaces statusText/statusBadgeHighlight rendering when multiple status badges are needed. */
	statusBadges?: Array<{ text: string | number; highlight?: Highlight }>;
	metadata: string | JSXElement;
	/** Badge content shown on the right side of the metadata line. Prefer this over JSX for stable sizing. */
	metadataBadges?: Array<{ text: string | number; highlight?: Highlight }>;
	/** Content shown on the right side of the metadata line, after the spacer. */
	metadataRight?: string | JSXElement;
	/** Rendered character width of metadataRight when it is JSX. Required for stable row alignment. */
	metadataRightWidth?: number;
	selected: boolean;
	index: number;
	prefix?: string;
	prefixColor?: string;
	prefixBadge?: { text: string | number; highlight?: Highlight };
	statusSuffixText?: string;
	statusSuffixColor?: string;
	rightMetadata?: string;
	rightMetadataColor?: string;
	onMouseUp?: () => void;
	runningTextEnabled?: boolean;
	runningTextOffset?: number;
}

const MIN_TITLE_WIDTH = 12;

export function WorkItemCard(props: WorkItemCardProps) {
	const dimensions = useTerminalDimensions();
	const contentWidth = () => Math.max(1, dimensions().width - 4);
	const fixedPrefix = () =>
		props.marker.length +
		1 +
		(props.prefixBadge
			? String(props.prefixBadge.text).length + 5
			: (props.prefix?.length ?? 0));

	/** Row-internal content width — subtracts 1 for ScrollableList scrollbar. */
	const rowWidth = () => Math.max(1, contentWidth() - 1);

	/** Compute truncated status + its char width. */
	const statusDisplay = createMemo(() => {
		const full = (props.statusText ?? "") + (props.statusSuffixText ?? "");
		const avail = rowWidth() - fixedPrefix() - MIN_TITLE_WIDTH - 1;
		if (full.length <= avail) {
			const text = props.statusText ?? "";
			const suffix = props.statusSuffixText ?? "";
			return { text, suffix, consumed: text.length + suffix.length };
		}
		const maxSuffix = Math.max(0, avail - (props.statusText ?? "").length - 1);
		if (maxSuffix <= 0) {
			const maxT = Math.max(1, avail - 1);
			return {
				text: `${(props.statusText ?? "").slice(0, maxT)}…`,
				suffix: "",
				consumed: avail,
			};
		}
		return {
			text: props.statusText ?? "",
			suffix: `${(props.statusSuffixText ?? "").slice(0, maxSuffix)}…`,
			consumed: avail,
		};
	});

	const statusBadgesWidth = () => {
		const badges = props.statusBadges ?? [];
		if (badges.length === 0) return 0;
		return (
			badges.reduce((sum, badge) => sum + String(badge.text).length + 4, 0) +
			Math.max(0, badges.length - 1)
		);
	};

	const statusRightWidth = () => {
		const badgesWidth = statusBadgesWidth();
		if (badgesWidth > 0) return badgesWidth;
		const status = statusDisplay();
		const textWidth =
			(props.statusAnimationIntent || props.statusBadgeHighlight) && status.text
				? status.text.length + 4
				: status.text.length;
		const suffixWidth = status.suffix.length;
		const gap = textWidth > 0 && suffixWidth > 0 ? 1 : 0;
		return textWidth + suffixWidth + gap;
	};

	/** Title width available after reserving space for prefix + status. */
	const titleWidth = () =>
		Math.max(
			MIN_TITLE_WIDTH,
			rowWidth() - fixedPrefix() - statusRightWidth() - 1,
		);

	const rightMetadataDisplay = createMemo(() => {
		const text = props.rightMetadata ?? "";
		const max = Math.max(0, Math.floor(rowWidth() * 0.45));
		if (!text || max === 0) return "";
		if (text.length <= max) return text;
		return `${text.slice(0, Math.max(1, max - 1))}…`;
	});

	const metadataBadgesWidth = () => {
		const badges = props.metadataBadges ?? [];
		if (badges.length === 0) return 0;
		return (
			badges.reduce((sum, badge) => sum + String(badge.text).length + 4, 0) +
			Math.max(0, badges.length - 1)
		);
	};

	const metadataRightWidth = () => {
		const parts = [
			metadataBadgesWidth(),
			props.metadataRightWidth ?? 0,
			rightMetadataDisplay().length,
		].filter((width) => width > 0);
		return (
			parts.reduce((sum, width) => sum + width, 0) +
			Math.max(0, parts.length - 1)
		);
	};

	const metadataWidth = () =>
		Math.max(1, rowWidth() - metadataRightWidth() - 1);

	const bgColor = () =>
		props.selected ? uiColors.bgSurface0 : uiColors.bgMantle;
	const statusAnimation = () =>
		props.statusAnimationIntent
			? statusAnimationModel(props.statusAnimationIntent)
			: undefined;
	const statusHighlight = () =>
		statusAnimation()?.tone ??
		statusAnimation()?.highlights?.[0] ??
		(props.statusBadgeHighlight as Highlight | undefined) ??
		"primary";

	return (
		<box
			backgroundColor={bgColor()}
			onMouseUp={props.onMouseUp}
			style={{
				width: "100%",
				flexDirection: "row",
			}}
		>
			{/* ── Accent marker strip — always present, colored only when selected ── */}
			<box
				backgroundColor={props.selected ? uiColors.highlight : undefined}
				style={{ width: 2, flexShrink: 0 }}
			/>

			{/* ── Card body ─────────────────────────────────────────────── */}
			<box
				style={{
					flexGrow: 1,
					flexDirection: "column",
					paddingLeft: 1,
					paddingRight: 1,
				}}
			>
				{/* Line 1: [marker][prefix][title] [status badge] */}
				<box
					style={{
						width: "100%",
						height: 1,
						flexShrink: 0,
						flexDirection: "row",
					}}
				>
					<box
						style={{
							flexDirection: "row",
							overflow: "hidden",
							flexShrink: 1,
							minWidth: 0,
						}}
					>
						<text fg={uiColors.textPrimary} attributes={TextAttributes.BOLD}>
							{props.marker}{" "}
						</text>
						<Show
							when={props.prefixBadge}
							fallback={
								<text
									fg={props.prefixColor ?? uiColors.textPrimary}
									attributes={TextAttributes.BOLD}
								>
									{props.prefix ?? ""}
								</text>
							}
						>
							{(badge) => (
								<>
									<Badge text={badge().text} highlight={badge().highlight} />
									<text> </text>
								</>
							)}
						</Show>
						<Show
							when={props.titleQuery && props.titleQuery.length > 0}
							fallback={
								<RunningText
									text={props.title}
									width={titleWidth()}
									fg={uiColors.textPrimary}
									attributes={TextAttributes.BOLD}
									enabled={props.runningTextEnabled}
									active={props.selected}
									offset={props.runningTextOffset}
								/>
							}
						>
							<box style={{ width: titleWidth(), overflow: "hidden" }}>
								<MatchedText
									text={props.title}
									query={props.titleQuery}
									fg={uiColors.textPrimary}
									attributes={TextAttributes.BOLD}
								/>
							</box>
						</Show>
					</box>
					<Show
						when={
							(props.statusBadges && props.statusBadges.length > 0) ||
							props.statusBadgeHighlight ||
							statusDisplay().text ||
							statusDisplay().suffix
						}
					>
						<box
							style={{
								flexDirection: "row",
								gap: 1,
								flexShrink: 0,
								marginLeft: "auto",
							}}
						>
							<Show
								when={props.statusBadges && props.statusBadges.length > 0}
								fallback={
									<>
										<Badge
											text={statusDisplay().text}
											appearance={
												props.statusAnimationIntent ||
												!props.statusBadgeHighlight
													? "text"
													: "badge"
											}
											highlight={statusHighlight()}
											color={
												!props.statusAnimationIntent &&
												!props.statusBadgeHighlight
													? props.statusColor
													: undefined
											}
											animatedTone={statusAnimation()?.tone}
											animatedHighlights={statusAnimation()?.highlights}
											transitionKey={props.statusTransitionKey}
										/>
										<Show when={statusDisplay().suffix}>
											<text
												fg={props.statusSuffixColor ?? props.statusColor}
												attributes={TextAttributes.BOLD}
											>
												{statusDisplay().suffix}
											</text>
										</Show>
									</>
								}
							>
								<For each={props.statusBadges ?? []}>
									{(badge) => (
										<Badge text={badge.text} highlight={badge.highlight} />
									)}
								</For>
							</Show>
						</box>
					</Show>
				</box>

				{/* Line 2: metadata [label badges] */}
				<box
					style={{
						width: "100%",
						height: 1,
						flexShrink: 0,
						flexDirection: "row",
					}}
				>
					<box style={{ overflow: "hidden", flexShrink: 1, minWidth: 0 }}>
						<Show
							when={typeof props.metadata === "string"}
							fallback={
								<box style={{ overflow: "hidden" }}>{props.metadata}</box>
							}
						>
							<RunningText
								text={props.metadata as string}
								width={metadataWidth()}
								fg={uiColors.textMuted}
								enabled={props.runningTextEnabled}
								active={props.selected}
								offset={props.runningTextOffset}
							/>
						</Show>
					</box>
					<box
						style={{
							flexDirection: "row",
							gap: 1,
							flexShrink: 0,
							marginLeft: "auto",
						}}
					>
						<For each={props.metadataBadges ?? []}>
							{(badge) => (
								<Badge text={badge.text} highlight={badge.highlight} />
							)}
						</For>
						<Show when={props.metadataRight}>{props.metadataRight}</Show>
						<Show
							when={
								typeof props.rightMetadata === "string" && props.rightMetadata
							}
						>
							<text fg={props.rightMetadataColor ?? uiColors.textMuted}>
								{rightMetadataDisplay()}
							</text>
						</Show>
					</box>
				</box>
			</box>
		</box>
	);
}
