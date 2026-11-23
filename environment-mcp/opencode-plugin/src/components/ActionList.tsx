/** @jsxImportSource @opentui/solid */
import type { InputRenderable, ScrollBoxRenderable } from "@opentui/core";
import { createEffect, For, Show } from "solid-js";
import type { UiActionDescriptor } from "../../../src/ui/capability-api.ts";
import type { ActionGrouping } from "../catalog.ts";
import type { Theme } from "../opencode-types.ts";

export function ActionList(props: {
	theme: Theme;
	actions: readonly UiActionDescriptor[];
	groups: readonly ActionGrouping[];
	selected: number;
	query: string;
	searchFocused: boolean;
	compact: boolean;
	onQuery(value: string): void;
	onSelect(index: number): void;
	onOpen(): void;
	onFocusSearch(): void;
	onBlurSearch(): void;
	onSearchRef(input: InputRenderable | undefined): void;
}) {
	let scroll: ScrollBoxRenderable | undefined;

	createEffect(() => {
		const action = props.actions[props.selected];
		if (!scroll || !action) return;
		queueMicrotask(() => scroll?.scrollChildIntoView(`action-${action.name}`));
	});

	return (
		<box
			flexDirection="column"
			flexShrink={0}
			flexGrow={props.compact ? 1 : 0}
			width={props.compact ? undefined : "38%"}
			minWidth={props.compact ? 0 : 34}
			maxWidth={props.compact ? undefined : 54}
			border={props.compact ? undefined : ["right"]}
			borderColor={props.theme.border.base}
			backgroundColor={props.theme.background.base}
		>
			<box
				flexDirection="column"
				paddingLeft={2}
				paddingRight={2}
				paddingTop={1}
				paddingBottom={1}
				gap={1}
				flexShrink={0}
			>
				<box flexDirection="row" gap={1} height={1}>
					<text fg={props.theme.text.muted} flexShrink={0}>
						/
					</text>
					<input
						ref={(value: InputRenderable) => props.onSearchRef(value)}
						value={props.query}
						placeholder="filter capabilities"
						focused={props.searchFocused}
						backgroundColor={props.theme.background.base}
						focusedBackgroundColor={props.theme.background.raised.base}
						textColor={props.theme.text.base}
						focusedTextColor={props.theme.text.base}
						placeholderColor={props.theme.text.muted}
						cursorColor={props.theme.text.base}
						onInput={props.onQuery}
						onSubmit={props.onOpen}
						on:focus={props.onFocusSearch}
						on:blur={props.onBlurSearch}
						flexGrow={1}
					/>
				</box>
				<text fg={props.theme.text.muted}>
					{props.query.trim()
						? `${props.actions.length} match${props.actions.length === 1 ? "" : "es"}`
						: `${props.actions.length} capabilities`}
				</text>
			</box>
			<Show
				when={props.actions.length > 0}
				fallback={
					<box paddingLeft={2} paddingRight={2} paddingTop={1}>
						<text fg={props.theme.text.muted} wrapMode="word">
							{props.query.trim()
								? `No capability matches “${props.query.trim()}”.`
								: "No capabilities are available."}
						</text>
					</box>
				}
			>
				<scrollbox
					ref={(value: ScrollBoxRenderable) => {
						scroll = value;
					}}
					flexGrow={1}
					minHeight={0}
					verticalScrollbarOptions={{ visible: false }}
					horizontalScrollbarOptions={{ visible: false }}
				>
					<For each={props.groups}>
						{(group) => (
							<box flexDirection="column" paddingBottom={1}>
								<text
									fg={props.theme.text.feedback.info.base}
									paddingLeft={2}
									paddingRight={2}
									paddingTop={1}
									paddingBottom={1}
								>
									<b>{group.group}</b>
								</text>
								<For each={group.actions}>
									{(action) => {
										const index = () => props.actions.indexOf(action);
										const selected = () => index() === props.selected;
										return (
											<box
												id={`action-${action.name}`}
												flexDirection="column"
												paddingLeft={2}
												paddingRight={2}
												paddingTop={1}
												paddingBottom={1}
												backgroundColor={
													selected()
														? props.theme.background.raised.high
														: undefined
												}
												onMouseUp={() => {
													props.onSelect(index());
													props.onOpen();
												}}
											>
												<box flexDirection="row" gap={1} minWidth={0}>
													<text
														fg={
															selected()
																? props.theme.text.action.primary.base
																: props.theme.text.muted
														}
														flexShrink={0}
													>
														{selected() ? "›" : " "}
													</text>
													<text
														fg={
															selected()
																? props.theme.text.base
																: props.theme.text.muted
														}
														wrapMode="none"
														truncate
														flexGrow={1}
														minWidth={0}
													>
														<b>{action.label}</b>
													</text>
													<Show when={action.annotations.destructiveHint}>
														<text
															fg={props.theme.text.feedback.error.base}
															wrapMode="none"
															flexShrink={0}
														>
															destructive
														</text>
													</Show>
												</box>
												<text
													fg={props.theme.text.muted}
													wrapMode="none"
													truncate
													paddingLeft={2}
												>
													{action.name}
												</text>
											</box>
										);
									}}
								</For>
							</box>
						)}
					</For>
				</scrollbox>
			</Show>
		</box>
	);
}
