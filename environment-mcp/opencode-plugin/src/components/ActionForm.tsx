/** @jsxImportSource @opentui/solid */
import type {
	InputRenderable,
	ScrollBoxRenderable,
	SelectRenderable,
} from "@opentui/core";
import { createEffect, For, Show } from "solid-js";
import type { UiActionDescriptor } from "../../../src/ui/capability-api.ts";
import type { UiField } from "../../../src/ui/controller.ts";
import { fieldChoices } from "../catalog.ts";
import type { Theme } from "../opencode-types.ts";

export function ActionForm(props: {
	theme: Theme;
	action: UiActionDescriptor;
	fields: readonly UiField[];
	values: Readonly<Record<string, string>>;
	fieldIndex: number;
	message?: string;
	onValue(name: string, value: string): void;
	onFocusField(index: number): void;
	onAdvance(index: number): void;
	onInputRef(index: number, input: InputRenderable | undefined): void;
	onSelectRef(index: number, select: SelectRenderable | undefined): void;
}) {
	let scroll: ScrollBoxRenderable | undefined;

	createEffect(() => {
		const field = props.fields[props.fieldIndex];
		if (!scroll || !field) return;
		queueMicrotask(() => scroll?.scrollChildIntoView(`field-${field.name}`));
	});

	return (
		<box flexDirection="column" flexGrow={1} minHeight={0} gap={1}>
			<box flexDirection="row" gap={1} alignItems="center" minWidth={0}>
				<text fg={props.theme.text.base} wrapMode="none" truncate flexGrow={1}>
					<b>{props.action.label}</b>
				</text>
				<text fg={props.theme.text.muted} wrapMode="none" flexShrink={0}>
					{props.action.name}
				</text>
			</box>
			<text fg={props.theme.text.muted} wrapMode="word">
				{props.action.description}
			</text>
			<scrollbox
				ref={(value: ScrollBoxRenderable) => {
					scroll = value;
				}}
				flexGrow={1}
				minHeight={0}
				verticalScrollbarOptions={{ visible: false }}
				horizontalScrollbarOptions={{ visible: false }}
			>
				<box flexDirection="column" gap={1} paddingRight={1}>
					<Show
						when={props.fields.length > 0}
						fallback={
							<text fg={props.theme.text.muted}>
								No inputs. Enter or Ctrl+Enter runs this capability.
							</text>
						}
					>
						<For each={props.fields}>
							{(field, index) => {
								const choices = () => fieldChoices(field);
								const selectedIndex = () => {
									const values = choices() ?? [];
									const selected = values.indexOf(
										props.values[field.name] ?? "",
									);
									return Math.max(selected, 0);
								};
								return (
									<box
										id={`field-${field.name}`}
										flexDirection="column"
										gap={0}
										paddingBottom={1}
									>
										<box flexDirection="row" gap={1} flexWrap="wrap">
											<text fg={props.theme.text.base} wrapMode="none">
												<b>{field.name}</b>
											</text>
											<text fg={props.theme.text.muted} wrapMode="none">
												{field.kind}
												{field.required ? " *" : ""}
											</text>
											<Show when={field.defaultValue !== undefined}>
												<text fg={props.theme.text.muted} wrapMode="none">
													default {field.defaultValue}
												</text>
											</Show>
										</box>
										<Show when={field.description}>
											<text fg={props.theme.text.muted} wrapMode="word">
												{field.description}
											</text>
										</Show>
										<Show when={field.pattern}>
											<text fg={props.theme.text.muted} wrapMode="word">
												format: {field.pattern}
											</text>
										</Show>
										<Show
											when={choices()}
											fallback={
												<input
													ref={(value: InputRenderable) =>
														props.onInputRef(index(), value)
													}
													value={props.values[field.name] ?? ""}
													placeholder={field.required ? "required" : "optional"}
													focused={index() === props.fieldIndex}
													backgroundColor={props.theme.background.base}
													focusedBackgroundColor={
														props.theme.background.raised.base
													}
													textColor={props.theme.text.base}
													focusedTextColor={props.theme.text.base}
													placeholderColor={props.theme.text.muted}
													cursorColor={props.theme.text.base}
													onInput={(value) => props.onValue(field.name, value)}
													onSubmit={() => props.onAdvance(index())}
													on:focus={() => props.onFocusField(index())}
												/>
											}
										>
											{(values) => (
												<select
													ref={(value: SelectRenderable) =>
														props.onSelectRef(index(), value)
													}
													options={values().map((value) => ({
														name: value,
														description: `Set ${field.name} to ${value}`,
														value,
													}))}
													selectedIndex={selectedIndex()}
													height={Math.min(4, values().length + 1)}
													focused={index() === props.fieldIndex}
													showDescription={false}
													showSelectionIndicator={false}
													wrapSelection
													backgroundColor={props.theme.background.base}
													focusedBackgroundColor={
														props.theme.background.raised.base
													}
													textColor={props.theme.text.base}
													focusedTextColor={props.theme.text.base}
													selectedBackgroundColor={
														props.theme.background.action.primary.focused
													}
													selectedTextColor={
														props.theme.text.action.primary.focused
													}
													descriptionColor={props.theme.text.muted}
													selectedDescriptionColor={props.theme.text.muted}
													onChange={(selected) => {
														const value = values()[selected];
														if (value !== undefined)
															props.onValue(field.name, value);
													}}
													onSelect={() => props.onAdvance(index())}
													on:focus={() => props.onFocusField(index())}
												/>
											)}
										</Show>
										<Show when={choices()}>
											{(values) => (
												<text fg={props.theme.text.muted} wrapMode="word">
													one of: {values().join(", ")}
												</text>
											)}
										</Show>
									</box>
								);
							}}
						</For>
					</Show>
				</box>
			</scrollbox>
			<Show when={props.message}>
				{(message) => (
					<text fg={props.theme.text.feedback.error.base} wrapMode="word">
						{message()}
					</text>
				)}
			</Show>
			<text fg={props.theme.text.muted}>
				Ctrl+Enter runs · Esc returns to the capability list
			</text>
		</box>
	);
}
