/** @jsxImportSource @opentui/solid */

import type { ScrollBoxRenderable, TextareaRenderable } from "@opentui/core";
import { TextAttributes } from "@opentui/core";
import { useTerminalDimensions } from "@opentui/solid";
import { createEffect, Show, untrack } from "solid-js";
import type { DeveloperDialogueRecord } from "../../../workflow/contracts";
import { focusSoon } from "../devenv-ui/utils/focusSoon";
import { uiColors } from "./colors";
import { GenericModal } from "./GenericModal";
import { ScrollableContent } from "./ScrollableContent";
import { SelectableList } from "./Selectable";

export function DeveloperQuestionModal(props: {
	questions: DeveloperDialogueRecord[];
	activeIndex: number;
	promptOffset: number;
	selected: number;
	custom: boolean;
	customText: string;
	responseState: string[];
	onCustomTextChange: (value: string) => void;
}) {
	const question = () =>
		props.questions[props.activeIndex] ?? props.questions[0];
	let textarea: TextareaRenderable | undefined;
	let promptScroll: ScrollBoxRenderable | undefined;
	const dimensions = useTerminalDimensions();
	const compact = () => dimensions().height < 18;
	const extremeCompact = () => dimensions().height < 12;
	const availableHeight = () =>
		Math.max(2, Math.floor(dimensions().height * 0.72) - 10);
	const promptHeight = () =>
		extremeCompact()
			? 1
			: Math.max(1, Math.min(6, Math.floor(availableHeight() * 0.35)));
	const editorHeight = () =>
		extremeCompact()
			? 1
			: Math.max(1, Math.min(6, availableHeight() - promptHeight() - 3));
	const tinyHelp = () => dimensions().width < 60;
	const compactHelp = () => compact() || dimensions().width * 0.78 < 95;
	createEffect(() => promptScroll?.scrollTo(props.promptOffset));
	const items = () => [
		...(question()?.options ?? []).map((option) => option.label),
		"Custom response…",
	];
	const shortLabel = (description: string) => {
		const label = description.replace(/\s+/g, " ").trim();
		return label.length > 16 ? `${label.slice(0, 16)}…` : label;
	};
	const tabHeader = () => {
		const count = Math.max(
			1,
			Math.min(3, Math.floor((dimensions().width * 0.78 - 4) / 28)),
		);
		const start = Math.min(
			Math.max(0, props.activeIndex - 1),
			Math.max(0, props.questions.length - count),
		);
		const tabs = props.questions
			.slice(start, start + count)
			.map((item, offset) => {
				const index = start + offset;
				return `${index === props.activeIndex ? ">" : " "}[${index + 1} ${shortLabel(item.description)} ${props.responseState[index] === "answered" ? "✓" : "·"}]`;
			});
		return `${start > 0 ? "… " : ""}${tabs.join(" ")}${start + count < props.questions.length ? " …" : ""}`;
	};
	return (
		<GenericModal
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
								{ key: "Esc", action: "Cancel" },
							]
						: compactHelp()
							? [
									{ key: "Alt+Enter", action: "Submit" },
									{ key: "Esc", action: "Cancel" },
								]
							: [
									{ key: "Enter", action: "New line" },
									{ key: "Alt+Enter", action: "Advance / submit" },
									{ key: "Ctrl+PgUp/Dn", action: "Scroll prompt" },
									{ key: "Esc", action: "Cancel" },
								]
					: tinyHelp()
						? [
								{ key: "↵", action: "Select" },
								{ key: "Esc", action: "Cancel" },
							]
						: compactHelp()
							? [
									{ key: "↑↓", action: "Choose" },
									{ key: "Enter", action: "Select" },
									{ key: "Esc", action: "Cancel" },
								]
							: [
									{ key: "Tab", action: "Next question" },
									{ key: "PgUp/PgDn", action: "Scroll prompt" },
									{ key: "↑↓", action: "Choose" },
									{ key: "Enter", action: "Select" },
									{ key: "Esc", action: "Cancel" },
								]
			}
		>
			<box width="100%" flexDirection="column" gap={extremeCompact() ? 0 : 1}>
				<Show when={!extremeCompact()} fallback={<box />}>
					<box width="100%" overflow="hidden">
						<text fg={uiColors.textPrimary} attributes={TextAttributes.BOLD}>
							{tabHeader()}
						</text>
					</box>
				</Show>
				<Show when={question()} fallback={<box />}>
					{(item) => (
						<>
							<ScrollableContent
								onScrollBoxReady={(scrollbox) => {
									promptScroll = scrollbox;
								}}
								style={{
									height: promptHeight(),
									maxHeight: promptHeight(),
									flexGrow: 0,
								}}
							>
								<box flexDirection="column">
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
											</text>
										</box>
									</Show>
									<Show when={item().context} fallback={<box />}>
										{(context) => (
											<box>
												<text fg={uiColors.textSecondary}>
													Context: {context()}
												</text>
											</box>
										)}
									</Show>
								</box>
							</ScrollableContent>
							<box width="100%" flexDirection="column">
								<Show
									when={props.custom}
									fallback={
										<box width="100%">
											<SelectableList
												items={items()}
												selectedIndex={props.selected}
												renderItem={(value) => (
													<box paddingLeft={1} height={1}>
														<text fg={uiColors.textPrimary}>{value}</text>
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
