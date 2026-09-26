/** @jsxImportSource @opentui/solid */
// Shared form primitive: field selector on left, active field editor on right.
import { TextAttributes } from "@opentui/core";
import { Show } from "solid-js";
import { uiColors } from "../theme/colors";
import { ScrollableList } from "./ScrollableList.tsx";

/** Input kinds a form field can declare. */
export type FormFieldKind = "text" | "select" | "action";

export interface FormField {
	/** Stable identity used as the values/errors key. */
	key: string;
	label: string;
	kind: FormFieldKind;
	/** Choices for a `select` field, in display order. */
	options?: readonly string[];
	/** Value a blank form starts with. Missing means empty string. */
	defaultValue?: string;
	/** Shown instead of the empty string. */
	placeholder?: string;
	/** Optional one-line explanation rendered under the field. */
	hint?: string;
}

export type FormValues = Record<string, string>;
export type FormErrors = Record<string, string | undefined>;
export type FormPane = "field" | "value";

/** The values of a blank form: every field's default, or empty. */
export function formDefaults(fields: readonly FormField[]): FormValues {
	const values: FormValues = {};
	for (const field of fields) values[field.key] = field.defaultValue ?? "";
	return values;
}

/** Merge stored values over blank defaults, retaining defaults for missing keys. */
export function formValues(
	fields: readonly FormField[],
	stored: FormValues = {},
): FormValues {
	const values = formDefaults(fields);
	for (const field of fields) {
		const value = stored[field.key];
		if (value !== undefined) values[field.key] = value;
	}
	return values;
}

/** Index of `value` among a select field's options (0 when it is not listed). */
export function formOptionIndex(field: FormField, value: string): number {
	const index = (field.options ?? []).indexOf(value);
	return index >= 0 ? index : 0;
}

/** Step a select field's value by `delta`, wrapping at the ends. */
export function formStepOption(
	field: FormField,
	value: string,
	delta: number,
): string {
	const options = field.options ?? [];
	if (!options.length) return value;
	const index = formOptionIndex(field, value);
	return (
		options[
			(index + delta + options.length * Math.abs(delta)) % options.length
		] ?? value
	);
}

/** Display string for a field's value, falling back to its placeholder. */
export function formDisplay(field: FormField, value: string): string {
	return value !== "" ? value : (field.placeholder ?? "—");
}

export interface FormProps {
	fields: readonly FormField[];
	values: FormValues;
	errors?: FormErrors;
	/** Focused field index. */
	activeIndex: number;
	/** Pane receiving navigation/input. Defaults to `field`. */
	focusedPane?: FormPane;
	/** Select choice under the cursor; committed value stays in `values`. */
	choiceCursorIndex?: number;
	/** Text fields accept printable input while entry mode is active. */
	editing?: boolean;
	/** Content lines the form may paint. */
	availableLines?: number;
	/** Heading row shown above the fields. */
	header?: string;
}

const selectionBackground = (focused: boolean) =>
	focused ? uiColors.bgSurface2 : uiColors.bgMantle;

/** Two-pane form renderer. Owner supplies draft state and runs validation on save. */
export function Form(props: FormProps) {
	const errors = () => props.errors ?? {};
	const pane = () => props.focusedPane ?? "field";
	const field = () => props.fields[props.activeIndex];
	const value = () => {
		const active = field();
		return active ? (props.values[active.key] ?? "") : "";
	};
	const options = () => field()?.options ?? [];
	const optionIndex = () => {
		const active = field();
		return active ? formOptionIndex(active, value()) : 0;
	};
	const choiceCursor = () => props.choiceCursorIndex ?? optionIndex();
	const listLines = (reservedLines = 0) =>
		Math.max(1, (props.availableLines ?? 10) - 1 - reservedLines);

	return (
		<box
			backgroundColor={uiColors.bgMantle}
			style={{ width: "100%", height: "100%", flexDirection: "column" }}
		>
			<Show when={props.header}>
				<text fg={uiColors.textMuted}>{props.header}</text>
			</Show>
			<box
				style={{
					width: "100%",
					flexGrow: 1,
					minHeight: 0,
					flexDirection: "row",
					gap: 2,
				}}
			>
				<box style={{ width: "34%", minWidth: 0, flexDirection: "column" }}>
					<text
						fg={pane() === "field" ? uiColors.primary : uiColors.textPrimary}
						attributes={TextAttributes.BOLD}
					>
						Fields
					</text>
					<ScrollableList
						items={[...props.fields]}
						selectedIndex={props.activeIndex}
						availableLines={listLines()}
						estimatedItemHeight={1}
						showScrollIndicator={false}
						showScrollbar={false}
						renderItem={(item, selected) => {
							const error = () => errors()[item.key];
							return (
								<box
									backgroundColor={
										selected()
											? selectionBackground(pane() === "field")
											: undefined
									}
									style={{ height: 1, paddingLeft: 1 }}
								>
									<text
										fg={
											error()
												? uiColors.error
												: selected()
													? uiColors.primary
													: uiColors.textSecondary
										}
									>
										{error() ? "⚠ " : ""}
										{item.label}
									</text>
								</box>
							);
						}}
					/>
				</box>

				<box style={{ width: "64%", minWidth: 0, flexDirection: "column" }}>
					<Show when={field()}>
						{(active) => (
							<>
								<text
									fg={
										pane() === "value" ? uiColors.primary : uiColors.textPrimary
									}
									attributes={TextAttributes.BOLD}
								>
									{active().label}
								</text>
								<Show when={errors()[active().key]}>
									<text fg={uiColors.error}>
										{`⚠ ${errors()[active().key]}`}
									</text>
								</Show>
								<Show when={active().kind === "text"}>
									<Show
										when={pane() === "value" && props.editing}
										fallback={
											<text
												fg={value() ? uiColors.textPrimary : uiColors.textMuted}
											>
												{formDisplay(active(), value())}
											</text>
										}
									>
										<box height={1} flexDirection="row">
											<text
												fg={value() ? uiColors.textPrimary : uiColors.textMuted}
											>
												{formDisplay(active(), value())}
											</text>
											<text fg={uiColors.primary}>▌</text>
										</box>
									</Show>
									<text fg={uiColors.textMuted}>
										{props.editing ? "Esc to finish editing" : "e to edit"}
									</text>
								</Show>
								<Show when={active().kind === "action"}>
									<text fg={uiColors.textPrimary}>
										{formDisplay(active(), value())}
									</text>
								</Show>
								<Show when={active().kind === "select"}>
									<ScrollableList
										items={[...options()]}
										selectedIndex={choiceCursor()}
										availableLines={listLines(
											errors()[active().key] || active().hint ? 1 : 0,
										)}
										estimatedItemHeight={1}
										showScrollIndicator={false}
										showScrollbar={false}
										renderItem={(option, selected) => (
											<box
												backgroundColor={
													selected()
														? selectionBackground(pane() === "value")
														: undefined
												}
												style={{ height: 1, paddingLeft: 1 }}
											>
												<text
													fg={
														selected()
															? uiColors.textPrimary
															: uiColors.textSecondary
													}
												>
													{option === value() ? "● " : "○ "}
													{option === "" ? "—" : option}
												</text>
											</box>
										)}
									/>
								</Show>
								<Show when={!errors()[active().key] && active().hint}>
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

/** First field (by declaration order) that carries an error, or 0. */
export function firstErrorField(
	fields: readonly FormField[],
	errors: FormErrors,
): number {
	const index = fields.findIndex((entry) => Boolean(errors[entry.key]));
	return index < 0 ? 0 : index;
}
