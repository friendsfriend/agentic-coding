/** @jsxImportSource @opentui/solid */

import type { ScrollBoxRenderable, TextareaRenderable } from "@opentui/core";
import { TextAttributes } from "@opentui/core";
import {
	focusSoon,
	GenericModal,
	MarkdownViewer,
	ScrollableContent,
	SelectableList,
	uiColors,
	useHover,
	useKeyDispatch,
	useTap,
	useTerminalDimensions,
} from "@ui";
import { createEffect, For, Show, untrack } from "solid-js";
import { formatHandoffDeadline } from "../../../contracts/handoff-deadline.ts";
import {
	type DeveloperDialogueRecord,
	resolveDeveloperQuestionOption,
} from "../../../contracts/workflow.ts";

interface OptionRow {
	label: string;
	recommended: boolean;
	hasDetail: boolean;
}

export function DeveloperQuestionModal(props: {
	questions: DeveloperDialogueRecord[];
	activeIndex: number;
	promptOffset: number;
	selected: number;
	/** Pointer: a tap selects an option (the keyboard's up/down). */
	onSelectIndex?: (index: number) => void;
	/** Pointer: a tap on a question tab switches to it (Tab/Shift+Tab). */
	onSelectTab?: (index: number) => void;
	custom: boolean;
	customText: string;
	responseState: string[];
	onCustomTextChange: (value: string) => void;
}) {
	// The shared tap rule for the option rows: select on a tap, activate a tap
	// on the selected row by dispatching this dialog's own `Enter`.
	const dispatch = useKeyDispatch();
	const question = () =>
		props.questions[props.activeIndex] ?? props.questions[0];
	let textarea: TextareaRenderable | undefined;
	let contextScroll: ScrollBoxRenderable | undefined;
	const dimensions = useTerminalDimensions();
	const compact = () => dimensions().height < 18;
	const extremeCompact = () => dimensions().height < 12;
	// Content budget: the modal's own height minus its fixed chrome (padding,
	// header, field label, footer). The context, question, and option list then
	// share what is left, so the question is never pushed out of the dialog by a
	// greedy option list.
	const contentBudget = () =>
		Math.max(
			3,
			Math.min(
				dimensions().height,
				Math.floor(dimensions().height * (compact() ? 1 : 0.72)),
			) - 5,
		);
	const fixedBudget = () => (extremeCompact() ? 3 : 6);
	const contextHeight = () =>
		extremeCompact()
			? 1
			: Math.max(
					1,
					Math.min(8, Math.floor((contentBudget() - fixedBudget()) * 0.5)),
				);
	const optionLines = () =>
		extremeCompact()
			? 1
			: Math.max(
					1,
					Math.min(8, contentBudget() - fixedBudget() - contextHeight()),
				);
	const editorHeight = () =>
		extremeCompact()
			? 1
			: Math.max(1, Math.min(6, contentBudget() - contextHeight() - 4));
	const contextWidth = () =>
		Math.max(20, Math.floor(dimensions().width * 0.78) - 8);
	const tinyHelp = () => dimensions().width < 60;
	const compactHelp = () => compact() || dimensions().width * 0.78 < 95;
	createEffect(() => contextScroll?.scrollTo(props.promptOffset));
	const options = () => question()?.options ?? [];
	// A `stage_login` hand-off is answered with Done or Abort only: no custom text
	// is offered (add-stage-interactive-login).
	const offersCustom = () => question()?.kind !== "login-handoff";
	// The same key, one meaning: a hand-off's Escape is the Abort the record
	// offers (it ends the login the waiting run needs), not a harmless dismissal.
	const escapeAction = () => (offersCustom() ? "Cancel" : "Abort");
	const rows = (): OptionRow[] => [
		...options().map((option) => {
			const resolved = resolveDeveloperQuestionOption(option);
			return {
				label: resolved.label,
				recommended: resolved.recommended === true,
				hasDetail: Boolean(resolved.description?.trim()),
			};
		}),
		...(offersCustom()
			? [{ label: "Custom response…", recommended: false, hasDetail: false }]
			: []),
	];
	const shortLabel = (item: DeveloperDialogueRecord) => {
		const label = (item.ident ?? item.description).replace(/\s+/g, " ").trim();
		return label.length > 16 ? `${label.slice(0, 16)}…` : label;
	};
	/** The windowed tab strip: `start` items from `start`, at most `count`. */
	const tabWindow = () => {
		const count = Math.max(
			1,
			Math.min(3, Math.floor((dimensions().width * 0.78 - 4) / 28)),
		);
		const start = Math.min(
			Math.max(0, props.activeIndex - 1),
			Math.max(0, props.questions.length - count),
		);
		return { start, count };
	};
	/** One tab's text, exactly as the joined header rendered it. */
	const tabLabel = (index: number, text: string) =>
		`${index === props.activeIndex ? ">" : " "}${text}`;
	const tabText = (index: number, item: DeveloperDialogueRecord) =>
		`[${index + 1} ${shortLabel(item)} ${props.responseState[index] === "answered" ? "✓" : "·"}]`;
	const tabEntries = () => {
		const { start, count } = tabWindow();
		return props.questions.slice(start, start + count).map((item, offset) => ({
			index: start + offset,
			text: tabText(start + offset, item),
		}));
	};
	return (
		<GenericModal
			dismissKind="developer-question"
			title={`Developer input · ${question()?.role ?? "agent"}`}
			fieldLabel="Questionnaire"
			widthPercent={0.78}
			heightPercent={compact() ? 1 : 0.72}
			zIndex={20}
			help={
				props.custom
					? tinyHelp()
						? [
								{ key: "A+↵", action: "Submit" },
								{ key: "Esc", action: escapeAction() },
							]
						: compactHelp()
							? [
									{ key: "Alt+Enter", action: "Submit" },
									{ key: "Esc", action: escapeAction() },
								]
							: [
									{ key: "Enter", action: "New line" },
									{ key: "Alt+Enter", action: "Advance / submit" },
									{ key: "Ctrl+PgUp/Dn", action: "Scroll context" },
									{ key: "Esc", action: escapeAction() },
								]
					: tinyHelp()
						? [
								{ key: "↵", action: "Select" },
								{ key: "Esc", action: escapeAction() },
							]
						: compactHelp()
							? [
									{ key: "Tab", action: "Next question" },
									{ key: "Shift+Tab", action: "Previous question" },
									{ key: "↑↓", action: "Choose" },
									{ key: "↵", action: "Select" },
									{ key: "d", action: "Option detail" },
									{ key: "Esc", action: escapeAction() },
								]
							: [
									{ key: "Tab", action: "Next question" },
									{ key: "Shift+Tab", action: "Previous question" },
									{ key: "PgUp/PgDn", action: "Scroll context" },
									{ key: "↑↓", action: "Choose" },
									{ key: "d", action: "Option detail" },
									{ key: "Alt+Enter", action: "Confirm" },
									{ key: "Esc", action: escapeAction() },
								]
			}
		>
			<box width="100%" flexDirection="column" gap={extremeCompact() ? 0 : 1}>
				<Show when={!extremeCompact()} fallback={<box />}>
					<box width="100%" flexDirection="row" overflow="hidden">
						<Show when={tabWindow().start > 0}>
							<text fg={uiColors.textPrimary} attributes={TextAttributes.BOLD}>
								{"… "}
							</text>
						</Show>
						<For each={tabEntries()}>
							{(entry, position) => {
								const tap = useTap(() => props.onSelectTab?.(entry.index));
								const hover = useHover(tap.onMouseOut);
								return (
									<box
										flexDirection="row"
										flexShrink={0}
										{...tap}
										{...hover}
										backgroundColor={
											hover.hovered() ? uiColors.bgHover : undefined
										}
									>
										<text
											fg={uiColors.textPrimary}
											attributes={TextAttributes.BOLD}
										>
											{`${position() > 0 ? " " : ""}${tabLabel(entry.index, entry.text)}`}
										</text>
									</box>
								);
							}}
						</For>
						<Show
							when={
								tabEntries().length + tabWindow().start < props.questions.length
							}
						>
							<text fg={uiColors.textPrimary} attributes={TextAttributes.BOLD}>
								{" …"}
							</text>
						</Show>
					</box>
				</Show>
				<Show when={question()} fallback={<box />}>
					{(item) => (
						<>
							{/* Markdown context box: the background the developer needs to
							    answer confidently, scrollable on its own. */}
							<Show
								when={item().context?.trim()}
								fallback={<box style={{ height: 0 }} />}
							>
								{(context) => (
									<ScrollableContent
										onScrollBoxReady={(scrollbox) => {
											contextScroll = scrollbox;
										}}
										style={{
											height: contextHeight(),
											maxHeight: contextHeight(),
											flexGrow: 0,
										}}
									>
										<MarkdownViewer
											content={context()}
											width={contextWidth()}
										/>
									</ScrollableContent>
								)}
							</Show>
							{/* The question itself, separated from its background. */}
							<box width="100%" flexDirection="column">
								<text
									fg={uiColors.textPrimary}
									attributes={TextAttributes.BOLD}
								>
									{item().description}
								</text>
								<Show when={!compact()} fallback={<box />}>
									<box>
										<text fg={uiColors.textMuted}>
											Requester: {item().role} · {item().stepId}
											{item().targetRole
												? " · also routed to the orchestrator"
												: ""}
											{deadlineLine(item().expiresAt)}
										</text>
									</box>
								</Show>
							</box>
							<box width="100%" flexDirection="column">
								<Show
									when={props.custom}
									fallback={
										<box width="100%" height={optionLines()} overflow="hidden">
											<SelectableList
												items={rows()}
												selectedIndex={props.selected}
												availableLines={optionLines()}
												{...(props.onSelectIndex
													? { onSelect: props.onSelectIndex }
													: {})}
												{...(props.onSelectIndex
													? { onActivate: () => dispatch("Enter") }
													: {})}
												renderItem={(row) => (
													<box paddingLeft={1} height={1}>
														<text
															fg={
																row.recommended
																	? uiColors.highlight
																	: uiColors.textPrimary
															}
														>
															{row.recommended ? "★ " : "  "}
															{row.label}
															{row.hasDetail ? "  (d)" : ""}
														</text>
													</box>
												)}
											/>
										</box>
									}
								>
									<box
										width="100%"
										flexDirection="column"
										gap={extremeCompact() ? 0 : 1}
									>
										<text fg={uiColors.textMuted}>
											{extremeCompact() ? "" : "Custom response (required)"}
										</text>
										<Show
											when={props.custom ? props.activeIndex + 1 : false}
											keyed
											fallback={<box />}
										>
											<textarea
												ref={(input) => {
													textarea = input;
													focusSoon(input);
												}}
												focused
												width="100%"
												height={editorHeight()}
												initialValue={untrack(() => props.customText)}
												wrapMode="word"
												onContentChange={() =>
													props.onCustomTextChange(
														(textarea?.plainText ?? "").slice(0, 8192),
													)
												}
												focusedBackgroundColor={uiColors.bgBase}
												focusedTextColor={uiColors.textPrimary}
											/>
										</Show>
									</box>
								</Show>
							</box>
						</>
					)}
				</Show>
			</box>
		</GenericModal>
	);
}

/** The record's own expiry, in the same words the hand-off banner uses
 * (`formatHandoffDeadline`): a dialog that hides when it stops being answerable
 * is one the developer cannot answer in time (USAB-101). */
function deadlineLine(expiresAt: string | undefined): string {
	if (!expiresAt) return "";
	const formatted = formatHandoffDeadline(expiresAt, Date.now());
	return formatted === "an unknown time" ? "" : ` · Expires ${formatted}`;
}
