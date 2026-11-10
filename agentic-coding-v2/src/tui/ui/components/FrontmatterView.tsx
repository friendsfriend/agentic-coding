/** @jsxImportSource @opentui/solid */
import { TextAttributes } from "@opentui/core";
import { For, type JSX, Show } from "solid-js";
import { uiColors } from "../theme/colors.ts";

export interface FrontmatterViewProps {
	/** Parsed YAML frontmatter mapping. */
	frontmatter: Record<string, unknown>;
	/** Columns reserved for the field label. Defaults to 18. */
	labelWidth?: number;
}

const humanize = (key: string): string =>
	key
		.replace(/[_-]+/g, " ")
		.replace(/\b\w/g, (character) => character.toUpperCase());

const isMapping = (value: unknown): value is Record<string, unknown> =>
	typeof value === "object" && value !== null && !Array.isArray(value);

/** Terminal text for a scalar YAML value; empty/null render as a dash. */
export function formatFrontmatterValue(value: unknown): string {
	if (value === null || value === undefined) return "—";
	if (typeof value === "string") return value;
	return String(value);
}

function FrontmatterRow(props: {
	label: string;
	labelWidth: number;
	children: JSX.Element;
}) {
	return (
		<box style={{ width: "100%", flexDirection: "row", minHeight: 1 }}>
			<box style={{ width: props.labelWidth, flexShrink: 0 }}>
				<text fg={uiColors.textMuted} attributes={TextAttributes.BOLD}>
					{props.label}
				</text>
			</box>
			<box style={{ flexGrow: 1, minWidth: 0, flexDirection: "column" }}>
				{props.children}
			</box>
		</box>
	);
}

function FrontmatterValue(props: {
	value: unknown;
	labelWidth: number;
}): JSX.Element {
	const value = () => props.value;
	const isScalarList = () =>
		Array.isArray(value()) &&
		(value() as unknown[]).every(
			(item) => !Array.isArray(item) && !isMapping(item),
		);
	return (
		<Show
			when={value() !== null && value() !== undefined}
			fallback={<text fg={uiColors.textMuted}>—</text>}
		>
			<Show
				when={Array.isArray(value())}
				fallback={
					<Show
						when={isMapping(value())}
						fallback={
							<text fg={uiColors.textPrimary}>
								{formatFrontmatterValue(value())}
							</text>
						}
					>
						<box style={{ width: "100%", flexDirection: "column" }}>
							<For each={Object.entries(value() as Record<string, unknown>)}>
								{([childKey, childValue]) => (
									<FrontmatterRow
										label={humanize(childKey)}
										labelWidth={props.labelWidth}
									>
										<FrontmatterValue
											value={childValue}
											labelWidth={props.labelWidth}
										/>
									</FrontmatterRow>
								)}
							</For>
						</box>
					</Show>
				}
			>
				<Show
					when={isScalarList()}
					fallback={
						<box style={{ width: "100%", flexDirection: "column" }}>
							<For each={value() as unknown[]}>
								{(item) => (
									<box style={{ flexDirection: "row", width: "100%" }}>
										<text fg={uiColors.textMuted}>{"• "}</text>
										<box
											style={{
												flexGrow: 1,
												minWidth: 0,
												flexDirection: "column",
											}}
										>
											<FrontmatterValue
												value={item}
												labelWidth={props.labelWidth}
											/>
										</box>
									</box>
								)}
							</For>
						</box>
					}
				>
					<text fg={uiColors.textPrimary}>
						{(value() as unknown[])
							.map((item) => formatFrontmatterValue(item))
							.join(", ")}
					</text>
				</Show>
			</Show>
		</Show>
	);
}

/**
 * Structured, human-readable rendering of a document's YAML frontmatter:
 * humanized field labels, inline scalars, bulleted lists and indented nested
 * mappings instead of the raw `---` fenced block.
 */
export function FrontmatterView(props: FrontmatterViewProps) {
	const labelWidth = () => props.labelWidth ?? 18;
	const entries = () =>
		Object.entries(props.frontmatter).filter(
			([, value]) => value !== undefined,
		);
	return (
		<Show
			when={entries().length > 0}
			fallback={<text fg={uiColors.textMuted}>No frontmatter fields.</text>}
		>
			<box style={{ width: "100%", flexDirection: "column" }}>
				<For each={entries()}>
					{([key, value]) => (
						<FrontmatterRow label={humanize(key)} labelWidth={labelWidth()}>
							<FrontmatterValue value={value} labelWidth={labelWidth()} />
						</FrontmatterRow>
					)}
				</For>
			</box>
		</Show>
	);
}
