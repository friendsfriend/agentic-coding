/** @jsxImportSource @opentui/solid */

import type { ScrollBoxRenderable } from "@opentui/core";
import { TextAttributes } from "@opentui/core";
import {
	Badge,
	GenericModal,
	MarkdownViewer,
	ScrollableContent,
	SelectableList,
	uiColors,
	useTerminalDimensions,
} from "@ui";
import { createEffect, Show } from "solid-js";

export type FindingEvent = {
	type: string;
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
export function FindingsModal(props: {
	title: string;
	events: FindingEvent[];
	selected: number;
	onDetailScrollBoxReady: (scrollBox: ScrollBoxRenderable) => void;
}) {
	// Verdict is engine-derived: any critical finding fails the round.
	const verdict = () =>
		props.events.some((event) => event.severity === "critical")
			? "FAIL"
			: "PASS";
	const findings = () =>
		props.events.filter((event) => event.type === "finding");
	const selectedFinding = () => findings()[props.selected];
	const dimensions = useTerminalDimensions();
	const contentWidth = () =>
		Math.max(20, Math.floor(dimensions().width * 0.78) - 8);
	let detailScroll: ScrollBoxRenderable | undefined;
	createEffect(() => {
		selectedFinding();
		detailScroll?.scrollTo(0);
	});
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
				items={findings()}
				estimatedItemHeight={2}
				availableLines={Math.min(8, Math.max(2, findings().length * 2))}
				selectedIndex={props.selected}
				renderItem={(event) => (
					<box width="100%" height={2} flexDirection="column" paddingRight={1}>
						<box flexDirection="row">
							<Badge
								text={(event.severity ?? "info").toUpperCase()}
								highlight={
									event.severity === "critical"
										? "negative"
										: event.severity === "warning"
											? "warning"
											: "highlight2"
								}
							/>
							<text fg={uiColors.textMuted}>
								{" "}
								{event.verifier ? `${event.verifier} · ` : ""}
								{event.path ?? "repository"}
								{event.line ? `:${event.line}` : ""}
							</text>
						</box>
						<text fg={uiColors.textSecondary}>
							{(event.detail ?? "").split(/\r?\n/, 1)[0].slice(0, 100)}
						</text>
					</box>
				)}
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
