/** @jsxImportSource @opentui/solid */
// Local port of the original shared Form: field selector on the left, the
// active field's value on the right. The owner holds the values and the cursor;
// a text field is edited in place with a focused input, a select field steps
// through its options. Nothing here validates or submits.
import { TextAttributes } from "@opentui/core";
import { For, type JSX, Show } from "solid-js";
import { uiColors } from "../theme/colors";

export type FormFieldKind = "text" | "select" | "action";

export interface FormField {
	key: string;
	label: string;
	kind: FormFieldKind;
	options?: readonly string[];
	placeholder?: string;
	hint?: string;
	maxLength?: number;
	/** An action field's colour: warning for a destructive draft edit. */
	tone?: "accent" | "warning";
}

export type FormValues = Record<string, string>;
export type FormPane = "field" | "value";

export function formOptionIndex(field: FormField, value: string): number {
	return Math.max((field.options ?? []).indexOf(value), 0);
}

export function formDisplay(field: FormField, value: string): string {
	return value !== "" ? value : (field.placeholder ?? "—");
}

const selectionBackground = (focused: boolean) =>
	focused ? uiColors.bgSurface2 : uiColors.bgMantle;

export function Form(props: {
	fields: readonly FormField[];
	values: FormValues;
	activeIndex: number;
	focusedPane: FormPane;
	choiceCursorIndex: number;
	editing: boolean;
	header?: string;
	onInput: (key: string, value: string) => void;
	onEditDone: () => void;
	onSelectField: (index: number) => void;
	actionContent?: JSX.Element;
}) {
	const field = () => props.fields[props.activeIndex];
	const value = () => {
		const active = field();
		return active ? (props.values[active.key] ?? "") : "";
	};
	return (
		<box
			backgroundColor={uiColors.bgMantle}
			style={{ width: "100%", flexDirection: "column", flexShrink: 0 }}
		>
			<Show when={props.header}>
				<text fg={uiColors.textMuted}>{props.header}</text>
			</Show>
			<box style={{ width: "100%", flexDirection: "row", gap: 2 }}>
				<box style={{ width: "34%", minWidth: 0, flexDirection: "column" }}>
					<text
						fg={
							props.focusedPane === "field"
								? uiColors.primary
								: uiColors.textPrimary
						}
						attributes={TextAttributes.BOLD}
					>
						Fields
					</text>
					<For each={props.fields}>
						{(item, index) => {
							const selected = () => index() === props.activeIndex;
							return (
								<box
									backgroundColor={
										selected()
											? selectionBackground(props.focusedPane === "field")
											: undefined
									}
									style={{ height: 1, paddingLeft: 1 }}
									onMouseUp={() => props.onSelectField(index())}
								>
									<text
										fg={
											item.kind === "action"
												? item.tone === "warning"
													? uiColors.warning
													: uiColors.accent
												: selected()
													? uiColors.primary
													: uiColors.textSecondary
										}
									>
										{item.label}
									</text>
								</box>
							);
						}}
					</For>
				</box>
				<box style={{ width: "64%", minWidth: 0, flexDirection: "column" }}>
					<Show when={field()}>
						{(active) => (
							<>
								<text
									fg={
										props.focusedPane === "value"
											? uiColors.primary
											: uiColors.textPrimary
									}
									attributes={TextAttributes.BOLD}
								>
									{active().label}
								</text>
								<Show when={active().kind === "text"}>
									<Show
										when={props.focusedPane === "value" && props.editing}
										fallback={
											<text
												fg={value() ? uiColors.textPrimary : uiColors.textMuted}
											>
												{formDisplay(active(), value())}
											</text>
										}
									>
										<input
											value={value()}
											maxLength={active().maxLength ?? 4096}
											focused={props.focusedPane === "value" && props.editing}
											onInput={(input) => {
												if (input !== value())
													props.onInput(active().key, input);
											}}
											onSubmit={props.onEditDone}
										/>
									</Show>
									<text fg={uiColors.textMuted}>
										{props.editing
											? "Editing value · Enter or Escape to finish"
											: ""}
									</text>
								</Show>
								<Show when={active().kind === "action"}>
									{props.actionContent ?? (
										<text fg={uiColors.textMuted}>Enter to run</text>
									)}
								</Show>
								<Show when={active().kind === "select"}>
									<For each={[...(active().options ?? [])]}>
										{(option, index) => (
											<box
												backgroundColor={
													index() === props.choiceCursorIndex
														? selectionBackground(props.focusedPane === "value")
														: undefined
												}
												style={{ height: 1, paddingLeft: 1 }}
											>
												<text
													fg={
														index() === props.choiceCursorIndex
															? uiColors.textPrimary
															: uiColors.textSecondary
													}
												>
													{option === value() ? "● " : "○ "}
													{option === "" ? "—" : option}
												</text>
											</box>
										)}
									</For>
								</Show>
								<Show when={active().hint}>
									<text fg={uiColors.textMuted}>{active().hint}</text>
								</Show>
							</>
						)}
					</Show>
				</box>
			</box>
		</box>
	);
}
