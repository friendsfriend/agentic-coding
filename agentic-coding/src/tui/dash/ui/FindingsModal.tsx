/** @jsxImportSource @opentui/solid */

import {
	Badge,
	createKeyedItems,
	GenericModal,
	MarkdownViewer,
	ScrollableContent,
	SelectableList,
	uiColors,
	useKeyDispatch,
	useModalBackdrop,
	useTerminalDimensions,
} from "@agentic-coding/ui";
import type { ScrollBoxRenderable } from "@opentui/core";
import { TextAttributes } from "@opentui/core";
import { createEffect, createMemo, on, Show } from "solid-js";

export type FindingEvent = {
	type: string;
	/** Present on committed verifier findings; older callers may omit it. */
	id?: string;
	severity?: string;
	path?: string;
	line?: number;
	detail?: string;
	evidence?: string;
	changedCode?: string;
	fix?: string;
	recommendation?: string;
	verifier?: string;
};

function FindingSummary(props: { event: FindingEvent }) {
	return (
		<box width="100%" height={2} flexDirection="column" paddingRight={1}>
			<box flexDirection="row">
				<Badge
					text={(props.event.severity ?? "info").toUpperCase()}
					highlight={
						props.event.severity === "critical"
							? "negative"
							: props.event.severity === "warning"
								? "warning"
								: "highlight2"
					}
				/>
				<text fg={uiColors.textMuted}>
					{" "}
					{props.event.verifier ? `${props.event.verifier} · ` : ""}
					{props.event.path ?? "repository"}
					{props.event.line ? `:${props.event.line}` : ""}
				</text>
			</box>
			<text fg={uiColors.textSecondary}>
				{(props.event.detail ?? "").split(/\r?\n/, 1)[0].slice(0, 100)}
			</text>
		</box>
	);
}
export function FindingsModal(props: {
	title: string;
	events: FindingEvent[];
	selected: number;
	onDetailScrollBoxReady: (scrollBox: ScrollBoxRenderable) => void;
	/** Pointer: a tap selects a finding (the keyboard's `j`/`k`). */
	onSelectIndex?: (index: number) => void;
}) {
	const dispatch = useKeyDispatch();
	const backdrop = useModalBackdrop({ kind: "findings" });
	// Verdict is engine-derived: any critical finding fails the round.
	const verdict = () =>
		props.events.some((event) => event.severity === "critical")
			? "FAIL"
			: "PASS";
	const findings = createMemo(() =>
		props.events.filter((event) => event.type === "finding"),
	);
	const findingSlots = createKeyedItems(findings, (finding) =>
		JSON.stringify([
			props.title,
			finding.verifier,
			finding.id ?? ["legacy", finding.path, finding.line, finding.detail],
		]),
	);
	const selectedSlot = createMemo(() => findingSlots()[props.selected]);
	const selectedFinding = () => selectedSlot()?.value();
	const dimensions = useTerminalDimensions();
	const contentWidth = () =>
		Math.max(20, Math.floor(dimensions().width * 0.78) - 8);
	let detailScroll: ScrollBoxRenderable | undefined;
	// Content refresh is not navigation. Only changing logical findings resets
	// the reading position, including legacy duplicate occurrences.
	createEffect(
		on(
			() => selectedSlot()?.key,
			() => detailScroll?.scrollTo(0),
		),
	);
	const markdown = (finding: FindingEvent) => {
		return [
			finding.detail ?? "",
			finding.recommendation
				? `### Recommended fix\n\n${finding.recommendation}`
				: finding.fix
					? `### Resolution\n\n${finding.fix}`
					: "",
			finding.evidence ? `### Evidence\n\n${finding.evidence}` : "",
		]
			.filter(Boolean)
			.join("\n\n");
	};
	return (
		<GenericModal
			{...backdrop}
			title={props.title}
			widthPercent={0.78}
			heightPercent={0.8}
			help={[
				{ key: "j/k", action: "Select" },
				{ key: "PgUp/PgDn", action: "Scroll finding" },
				{ key: "Enter", action: "Open editor" },
				{ key: "Esc", action: "Close" },
			]}
		>
			<box height={1} width="100%" flexDirection="row">
				<text fg={verdict() === "PASS" ? uiColors.success : uiColors.error}>
					VERDICT (derived): {verdict()}
				</text>
				<box flexGrow={1} />
				<text fg={uiColors.textMuted}>{findings().length} findings</text>
			</box>
			<SelectableList
				items={findingSlots().slice()}
				itemKey={(slot) => slot.key}
				estimatedItemHeight={2}
				availableLines={Math.min(8, Math.max(2, findings().length * 2))}
				selectedIndex={props.selected}
				{...(props.onSelectIndex ? { onSelect: props.onSelectIndex } : {})}
				{...(props.onSelectIndex
					? { onActivate: () => dispatch("Enter") }
					: {})}
				renderItem={(slot) => <FindingSummary event={slot.value()} />}
				renderReactiveItem={(slot) => <FindingSummary event={slot().value()} />}
			/>
			<Show when={selectedFinding()}>
				{(finding) => (
					<ScrollableContent
						onScrollBoxReady={(scrollBox) => {
							detailScroll = scrollBox;
							props.onDetailScrollBoxReady(scrollBox);
						}}
					>
						<box flexDirection="column">
							<MarkdownViewer
								content={markdown(finding())}
								width={contentWidth()}
							/>
						</box>
						<Show when={finding().changedCode}>
							{(code) => (
								<box
									backgroundColor={uiColors.bgCrust}
									paddingLeft={1}
									paddingRight={1}
								>
									<text fg={uiColors.textSecondary}>{code()}</text>
								</box>
							)}
						</Show>
						<Show when={finding().fix && finding().recommendation}>
							<text fg={uiColors.textMuted} attributes={TextAttributes.ITALIC}>
								Existing resolution: {finding().fix}
							</text>
						</Show>
					</ScrollableContent>
				)}
			</Show>
		</GenericModal>
	);
}
