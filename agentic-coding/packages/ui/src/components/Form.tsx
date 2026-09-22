/** @jsxImportSource @opentui/solid */
// Shared form primitive (rework-model-profiles-and-presets).
//
// A form is a vertical list of labelled fields. Each field has an input kind,
// an optional default and an optional hint; validation is per field and the
// error renders directly under the field that produced it, in the theme error
// colour, so a failing save never hides which value is wrong. The component is
// presentational: the owner keeps the value/error state and key dispatch, which
// keeps the same form usable inline (settings pages) or inside a dialog.
import { Show } from "solid-js";
import { uiColors } from "../theme/colors";
import { ScrollableList } from "./ScrollableList.tsx";

/** Input kinds a form field can declare. */
export type FormFieldKind = "text" | "select";

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

/** The values of a blank form: every field's default, or empty. */
export function formDefaults(fields: readonly FormField[]): FormValues {
	const values: FormValues = {};
	for (const field of fields) values[field.key] = field.defaultValue ?? "";
	return values;
}

/**
 * Merge stored values over the blank defaults so a prefilled form still applies
 * field defaults for keys the stored value omits (new fields, cleared values).
 */
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
	const options = field.options ?? [];
	const index = options.indexOf(value);
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
	const current = formOptionIndex(field, value);
	const next =
		(current + delta + options.length * Math.abs(delta)) % options.length;
	return options[next] ?? value;
}

/** Display string for a field's value, falling back to its placeholder. */
export function formDisplay(field: FormField, value: string): string {
	if (value !== "") return value;
	return field.placeholder ?? "—";
}

/** Per-item line budget so a long form scrolls with the cursor in view. */
function fieldHeights(
	fields: readonly FormField[],
	errors: FormErrors,
): number[] {
	return fields.map(
		(field) => 1 + (errors[field.key] ? 1 : 0) + (field.hint ? 1 : 0),
	);
}

export interface FormProps {
	fields: readonly FormField[];
	values: FormValues;
	errors?: FormErrors;
	/** Focused field index. */
	activeIndex: number;
	/** Text fields render an entry cursor while the form is in entry mode. */
	editing?: boolean;
	/** Content lines the form may paint; the cursor row is always kept in view. */
	availableLines?: number;
	/** Heading row shown above the fields (e.g. a description). */
	header?: string;
}

/**
 * Render a form. The owner is responsible for moving `activeIndex`, changing
 * `values` and calling its own validation to fill `errors`.
 */
export function Form(props: FormProps) {
	const errors = () => props.errors ?? {};
	const heights = () => fieldHeights(props.fields, errors());
	return (
		<box style={{ width: "100%", height: "100%", flexDirection: "column" }}>
			<Show when={props.header}>
				<text fg={uiColors.textMuted}>{props.header}</text>
			</Show>
			<ScrollableList
				items={[...props.fields]}
				selectedIndex={props.activeIndex}
				availableLines={props.availableLines}
				itemHeights={heights()}
				showScrollIndicator={false}
				showScrollbar={false}
				renderItem={(field, selected) => {
					const value = () => props.values[field.key] ?? "";
					const error = () => errors()[field.key];
					return (
						<box style={{ width: "100%", flexDirection: "column" }}>
							<box style={{ width: "100%", flexDirection: "row" }}>
								<text fg={selected() ? uiColors.primary : uiColors.textMuted}>
									{selected() ? "▌ " : "  "}
								</text>
								<box style={{ flexGrow: 1, minWidth: 0, overflow: "hidden" }}>
									<text
										fg={
											error()
												? uiColors.error
												: selected()
													? uiColors.textPrimary
													: uiColors.textSecondary
										}
									>
										{field.label}
									</text>
								</box>
								<box style={{ flexShrink: 0, flexDirection: "row" }}>
									<Show when={field.kind === "select"}>
										<text
											fg={
												selected() ? uiColors.primary : uiColors.textSecondary
											}
										>
											{`‹ ${formDisplay(field, value())} ›`}
										</text>
									</Show>
									<Show when={field.kind === "text"}>
										<text
											fg={
												selected()
													? uiColors.textPrimary
													: uiColors.textSecondary
											}
										>
											{formDisplay(field, value())}
										</text>
										<Show when={selected() && props.editing}>
											<text fg={uiColors.primary}>▌</text>
										</Show>
									</Show>
								</box>
							</box>
							<Show when={field.hint && !error()}>
								<text fg={uiColors.textMuted}>{`   ${field.hint}`}</text>
							</Show>
							<Show when={error()}>
								<text fg={uiColors.error}>{`   ⚠ ${error()}`}</text>
							</Show>
						</box>
					);
				}}
			/>
		</box>
	);
}

/** First field (by declaration order) that carries an error, or 0. */
export function firstErrorField(
	fields: readonly FormField[],
	errors: FormErrors,
): number {
	const field = fields.findIndex((entry) => Boolean(errors[entry.key]));
	return field === -1 ? 0 : field;
}
