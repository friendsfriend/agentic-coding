/** @jsxImportSource @opentui/solid */
import type { BoxRenderable, ScrollBoxRenderable } from "@opentui/core";
import { useKeymap } from "@opentui/keymap/solid";
import {
	createEffect,
	createMemo,
	createSignal,
	For,
	onCleanup,
	Show,
} from "solid-js";
import type { Question } from "../../../questions.ts";
import { MarkdownViewer } from "../../presentation/components/MarkdownViewer.tsx";
import { useHover } from "../../presentation/components/mouse/useHover.ts";
import {
	type RowGestureState,
	useRowMouse,
} from "../../presentation/components/mouse/useRowMouse.ts";
import { SelectionMarker } from "../../presentation/components/SelectionMarker.tsx";
import { useTerminalDimensions } from "../../presentation/hooks/useTerminalDimensions.ts";
import { uiColors } from "../../presentation/theme/colors.ts";
import { ActionHeader } from "../../ui/ActionHeader.tsx";
import { ModalTabs } from "../../ui/views/ModalTabs.tsx";
import type { HumanDraft } from "./human-draft.ts";
import { questionKeybinds } from "./human-keybinds.ts";

export function Questionnaire(props: {
	questions: Question[];
	customEditing: boolean;
	draft: HumanDraft;
	editable: boolean;
	active: boolean;
	change: (edit: (draft: HumanDraft) => HumanDraft) => void;
	focus: () => void;
	postpone: () => void;
	help: () => void;
	submit: () => void;
	edit: (kind: "custom" | "notes" | "global", index?: number) => void;
}) {
	const dimensions = useTerminalDimensions();
	const [contentWidth, setContentWidth] = createSignal(0);
	let previewBox: ScrollBoxRenderable | undefined;
	const tab = () => Math.min(props.questions.length, props.draft.tab);
	const question = () => props.questions[tab()];
	const answer = () => props.draft.answers[tab()];
	const tabs = () => [
		...props.questions.map((q, i) => ({
			id: String(i),
			label:
				contentWidth() < 90
					? `${i + 1}. ${q.header.slice(0, Math.max(3, Math.floor((contentWidth() - 18) / props.questions.length) - 7))}`
					: q.header,
			badge:
				props.draft.answers[i]?.optionIndexes.length ||
				(props.draft.answers[i]?.customSelected &&
					props.draft.answers[i]?.text.trim())
					? "✓"
					: undefined,
		})),
		{ id: String(props.questions.length), label: "Submit", badge: undefined },
	];
	const setTab = (index: number) => {
		props.focus();
		props.change((d) => ({
			...d,
			tab: (index + tabs().length) % tabs().length,
			highlight: 0,
		}));
	};
	const select = (index: number) => {
		props.focus();
		props.change((d) => ({ ...d, highlight: index }));
	};
	const options = createMemo(() => {
		const q = question();
		return q
			? [
					...q.options.map((o, i) => ({
						index: i,
						label: o.label,
						description: o.description,
					})),
					{
						index: q.options.length,
						label: "Type something…",
						description: answer()?.text || "Your own multiline answer",
					},
				]
			: [];
	});
	const choose = (index: number) => {
		if (!props.editable) return;
		props.focus();
		const q = question();
		if (!q) {
			props.submit();
			return;
		}
		if (index === q.options.length) {
			props.edit("custom", tab());
			return;
		}
		props.change((d) => ({
			...d,
			answers: d.answers.map((a, i) =>
				i !== tab()
					? a
					: {
							...a,
							optionIndexes: q.multiSelect
								? a.optionIndexes.includes(index)
									? a.optionIndexes.filter((n) => n !== index)
									: [...a.optionIndexes, index]
								: [index],
							customSelected: q.multiSelect ? a.customSelected : false,
						},
			),
		}));
	};
	const unregister = useKeymap().registerLayer({
		priority: 65,
		enabled: () => props.active,
		bindings: questionKeybinds.map((b) => ({
			key: b.key,
			cmd: () => {
				if (
					!props.editable &&
					![
						"human.leave",
						"human.help",
						"human.previewUp",
						"human.previewDown",
					].includes(b.cmd)
				)
					return;
				if (b.cmd === "human.up" || b.cmd === "human.down") {
					const n = options().length;
					if (n)
						select(
							(props.draft.highlight + (b.cmd === "human.up" ? -1 : 1) + n) % n,
						);
				} else if (b.cmd === "human.tab") setTab(tab() + 1);
				else if (b.cmd === "human.previousTab") setTab(tab() - 1);
				else if (b.cmd === "human.confirm") {
					if (b.key !== "space") choose(props.draft.highlight);
					else if (question()?.multiSelect) {
						if (props.draft.highlight < (question()?.options.length ?? 0))
							choose(props.draft.highlight);
						else if (answer()?.text.trim())
							props.change((d) => ({
								...d,
								answers: d.answers.map((a, i) =>
									i === tab() ? { ...a, customSelected: !a.customSelected } : a,
								),
							}));
						else props.edit("custom", tab());
					}
				} else if (b.cmd.startsWith("human.number")) {
					const index = Number(b.key) - 1;
					if (index < options().length) {
						select(index);
						choose(index);
					}
				} else if (b.cmd === "human.notes")
					props.edit(question() ? "notes" : "global", tab());
				else if (b.cmd === "human.leave") props.postpone();
				else if (b.cmd === "human.help") props.help();
				else if (b.cmd === "human.previewUp") previewBox?.scrollBy(-5);
				else if (b.cmd === "human.previewDown") previewBox?.scrollBy(5);
			},
		})),
	});
	onCleanup(unregister);
	let list: ScrollBoxRenderable | undefined;
	const rowNodes = new Map<number, BoxRenderable>();
	createEffect(() => {
		const node = rowNodes.get(props.draft.highlight);
		if (node && list)
			list.scrollTo(Math.max(0, node.y - list.y + list.scrollTop));
	});
	const gesture: RowGestureState = {};
	const wide = () => contentWidth() >= 100;
	const preview = () => question()?.options[props.draft.highlight]?.preview;
	return (
		<box
			flexDirection="column"
			gap={1}
			width="100%"
			onSizeChange={function () {
				setContentWidth(this.width);
			}}
		>
			<ModalTabs
				tabs={tabs()}
				activeId={String(tab())}
				onChange={props.editable ? (id) => setTab(Number(id)) : undefined}
			/>
			<Show
				when={question()}
				fallback={
					<box flexDirection="column" gap={1}>
						<text fg={uiColors.textPrimary}>Review your answers</text>
						<For each={props.questions}>
							{(q, i) => (
								<text
									wrapMode="word"
									fg={
										answerText(props.draft, i(), q)
											? uiColors.textPrimary
											: uiColors.warning
									}
								>
									{q.header}: {answerText(props.draft, i(), q) || "Unanswered"}
									{props.draft.answers[i()]?.notes
										? `\nNote: ${props.draft.answers[i()]?.notes}`
										: ""}
								</text>
							)}
						</For>
						<Show when={props.draft.globalNote}>
							<text wrapMode="word">Global note: {props.draft.globalNote}</text>
						</Show>
						<ActionHeader
							interactive={props.editable}
							onActivate={() => props.edit("global")}
						>
							<text fg={uiColors.primary}>Edit global note</text>
						</ActionHeader>
						<ActionHeader
							interactive={props.editable}
							onActivate={props.submit}
						>
							<text fg={uiColors.primary}>Submit answers</text>
						</ActionHeader>
					</box>
				}
			>
				{(q) => (
					<>
						<text fg={uiColors.textPrimary} wrapMode="word">
							{q().question}
						</text>
						<Show when={!props.customEditing}>
							<box flexDirection={wide() ? "row" : "column"} gap={2}>
								<scrollbox
									ref={(node) => {
										list = node;
									}}
									height={Math.min(16, Math.max(6, dimensions().height - 16))}
									width={wide() ? "45%" : "100%"}
								>
									<For each={options()}>
										{(row) => {
											const selected = () =>
												row.index === props.draft.highlight;
											const mouse = useRowMouse({
												gesture,
												index: () => row.index,
												selectedIndex: () => props.draft.highlight,
												activatable: () => props.editable,
												onSelect: select,
												onActivate: choose,
											});
											const hover = useHover(mouse.onMouseOut);
											return (
												<box
													ref={(node) => rowNodes.set(row.index, node)}
													flexDirection="row"
													flexShrink={0}
													{...mouse}
													{...hover}
													backgroundColor={
														hover.hovered() ? uiColors.bgHover : undefined
													}
												>
													<SelectionMarker selected={selected()} />
													<box
														flexDirection="column"
														flexGrow={1}
														minWidth={0}
														paddingBottom={1}
													>
														<text
															fg={
																selected()
																	? uiColors.primary
																	: uiColors.textPrimary
															}
															wrapMode="word"
														>
															{q().multiSelect
																? answer()?.optionIndexes.includes(row.index) ||
																	(row.index === q().options.length &&
																		answer()?.customSelected &&
																		answer()?.text.trim())
																	? "☑ "
																	: "☐ "
																: answer()?.optionIndexes.includes(row.index) ||
																		(row.index === q().options.length &&
																			answer()?.customSelected &&
																			answer()?.text.trim())
																	? "● "
																	: "○ "}
															{row.index + 1}. {row.label}
															{q().options[row.index]?.recommended
																? " (Recommended)"
																: ""}
														</text>
														<text fg={uiColors.textMuted} wrapMode="word">
															{row.description}
														</text>
													</box>
												</box>
											);
										}}
									</For>
								</scrollbox>
								<Show when={preview()}>
									<box
										border={true}
										borderColor={uiColors.border}
										flexDirection="column"
										flexGrow={1}
										minWidth={0}
										width={wide() ? "53%" : "100%"}
									>
										<scrollbox
											ref={(node) => {
												previewBox = node;
											}}
											height={Math.min(
												18,
												Math.max(5, dimensions().height - 16),
											)}
										>
											<MarkdownViewer content={preview() ?? ""} />
										</scrollbox>
									</box>
								</Show>
							</box>
						</Show>
						<Show when={answer()?.notes}>
							<text fg={uiColors.textMuted} wrapMode="word">
								Note for this answer: {answer()?.notes}
							</text>
						</Show>
						<ActionHeader
							interactive={props.editable}
							onActivate={() => props.edit("notes", tab())}
						>
							<text fg={uiColors.primary}>Edit question note</text>
						</ActionHeader>
					</>
				)}
			</Show>
		</box>
	);
}
function answerText(draft: HumanDraft, index: number, question: Question) {
	const a = draft.answers[index];
	return a
		? [
				...a.optionIndexes.map(
					(i) => question.options[i]?.label ?? `Option ${i + 1}`,
				),
				a.customSelected ? a.text.trim() : "",
			]
				.filter(Boolean)
				.join(" · ")
		: "";
}
