/** @jsxImportSource @opentui/solid */
import { TextAttributes } from "@opentui/core";
import { For, type JSXElement, Show } from "solid-js";
import { uiColors } from "../colors";
import { Badge } from "./Badge";
import { type Highlight, HighlightedText, highlightColor } from "./Highlight";

export type PropertyHighlight = Highlight;
export type PropertyLayout = "inline" | "block";

export interface PropertyBadge {
	label: string;
	highlight?: PropertyHighlight;
	/** Last-resort color escape hatch. Prefer highlight. */
	color?: string;
	textColor?: string;
}

export interface PropertyBadgeListValue {
	kind: "badges";
	badges: PropertyBadge[];
	emptyText?: string;
}

export type PropertyValue =
	| string
	| number
	| JSXElement
	| PropertyBadgeListValue;

export interface PropertyRow {
	label: string;
	value: PropertyValue;
	/** Highlight for label text. Defaults to primary. */
	labelHighlight?: PropertyHighlight;
	/** Highlight for primitive value text. Defaults to primary. JSX values own their colors. */
	valueHighlight?: PropertyHighlight;
	/**
	 * inline: label and value share one row.
	 * block: label gets its own row, value renders below. Use for Markdown/code/long rich content.
	 */
	layout?: PropertyLayout;
	/** Left padding for block values. Defaults to 3 to match current detail views. */
	blockValuePaddingLeft?: number;
	/**
	 * Last-resort color escape hatch for primitive values that cannot use semantic highlighting.
	 * Prefer valueHighlight whenever possible so colors stay theme-aware and consistent.
	 */
	valueColor?: string;
}

export interface PropertiesListProps {
	rows: PropertyRow[];
	labelWidth?: number;
	emptyText?: string;
}

export function propertyBadges(
	badges: PropertyBadge[],
	emptyText?: string,
): PropertyBadgeListValue {
	return { kind: "badges", badges, emptyText };
}

function isBadgeListValue(
	value: PropertyValue,
): value is PropertyBadgeListValue {
	return (
		typeof value === "object" &&
		value != null &&
		(value as PropertyBadgeListValue).kind === "badges"
	);
}

export function PropertiesList(props: PropertiesListProps) {
	const labelWidth = () => props.labelWidth ?? 12;
	const isPrimitiveValue = (value: PropertyValue): value is string | number =>
		typeof value === "string" || typeof value === "number";
	const renderBadgeList = (value: PropertyBadgeListValue) => (
		<box style={{ flexDirection: "row", flexWrap: "wrap", minHeight: 1 }}>
			<Show
				when={value.badges.length > 0}
				fallback={
					value.emptyText ? (
						<text fg={uiColors.textMuted}>{value.emptyText}</text>
					) : null
				}
			>
				<For each={value.badges}>
					{(badge) => (
						<box style={{ marginRight: 1 }}>
							<Badge
								text={badge.label}
								highlight={badge.highlight}
								color={badge.color}
								textColor={badge.textColor}
							/>
						</box>
					)}
				</For>
			</Show>
		</box>
	);
	const renderValue = (row: PropertyRow) => {
		if (isPrimitiveValue(row.value)) {
			if (row.valueColor)
				return <text fg={row.valueColor}>{String(row.value)}</text>;
			return (
				<HighlightedText text={row.value} highlight={row.valueHighlight} />
			);
		}
		if (isBadgeListValue(row.value)) return renderBadgeList(row.value);
		return row.value;
	};

	return (
		<box style={{ width: "100%", flexDirection: "column" }}>
			<Show
				when={props.rows.length > 0}
				fallback={
					props.emptyText ? (
						<box style={{ paddingLeft: 1, paddingRight: 1 }}>
							<text fg={uiColors.textMuted}>{props.emptyText}</text>
						</box>
					) : null
				}
			>
				<For each={props.rows}>
					{(row) => (
						<Show
							when={row.layout === "block"}
							fallback={
								<box
									style={{
										flexDirection: "row",
										paddingLeft: 1,
										paddingRight: 1,
									}}
								>
									<box style={{ width: labelWidth(), flexShrink: 0 }}>
										<text
											fg={highlightColor(row.labelHighlight)}
											attributes={TextAttributes.BOLD}
										>
											{row.label}
										</text>
									</box>
									{renderValue(row)}
								</box>
							}
						>
							<box style={{ flexDirection: "column", width: "100%" }}>
								<box style={{ paddingLeft: 1, paddingRight: 1 }}>
									<text
										fg={highlightColor(row.labelHighlight)}
										attributes={TextAttributes.BOLD}
									>
										{row.label}
									</text>
								</box>
								<box
									style={{
										paddingLeft: row.blockValuePaddingLeft ?? 3,
										paddingRight: 1,
									}}
								>
									{renderValue(row)}
								</box>
							</box>
						</Show>
					)}
				</For>
			</Show>
		</box>
	);
}
