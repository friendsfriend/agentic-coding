/** @jsxImportSource @opentui/solid */
import { For, type JSX, Show } from "solid-js";
import { uiColors } from "../theme/colors";
import { hostOwnsGaps } from "./hostChrome";

export interface ContentFrameProps {
	children: JSX.Element;
	gap?: number;
}

export interface ContentStackProps {
	items: JSX.Element[];
	gap?: number;
}

export interface ContentPanelProps {
	children: JSX.Element;
	gap?: number;
	direction?: "column" | "row";
}

export interface GridColumn {
	width: number | string;
	items: JSX.Element[];
}

export interface GridLayoutProps {
	columns: GridColumn[];
	gap?: number;
}

const spacer = (height: number) => (
	<box style={{ width: "100%", height, flexShrink: 0 }} />
);

/**
 * The blank rows around a view's content. A host that renders the chrome
 * around the body (the unified shell) also renders these two rows, so the
 * view's outer gutters stand down and every page keeps exactly one blank row
 * above and below its content. Gaps *between* items are never affected.
 */
const outerGap = (gap: number | undefined): number =>
	hostOwnsGaps() ? 0 : (gap ?? 1);

export function ContentFrame(props: ContentFrameProps) {
	const gap = () => outerGap(props.gap);

	return (
		<box
			backgroundColor={uiColors.bgBase}
			style={{ width: "100%", height: "100%", flexDirection: "column" }}
		>
			<Show when={gap() > 0}>{spacer(gap())}</Show>
			<box
				style={{
					width: "100%",
					flexGrow: 1,
					minHeight: 0,
					flexDirection: "column",
				}}
			>
				{props.children}
			</box>
			<Show when={gap() > 0}>{spacer(gap())}</Show>
		</box>
	);
}

/**
 * ContentPanel — wrap a view with bgBase outer gutters and a bgMantle inner
 * panel. The standard layout for most full-screen TUI views.
 */
export function ContentPanel(props: ContentPanelProps) {
	const dir = () => props.direction ?? "column";

	return (
		<ContentFrame gap={props.gap}>
			<box
				backgroundColor={uiColors.bgMantle}
				style={{
					width: "100%",
					flexGrow: 1,
					minHeight: 0,
					flexDirection: dir(),
				}}
			>
				{props.children}
			</box>
		</ContentFrame>
	);
}

export function ContentStack(props: ContentStackProps) {
	// Items are separated by `gap`; the rows around the whole stack are the
	// host's when it renders them.
	const gap = () => props.gap ?? 1;
	const edge = () => outerGap(props.gap);
	const lastIndex = () => props.items.length - 1;

	return (
		<box
			backgroundColor={uiColors.bgBase}
			style={{ width: "100%", height: "100%", flexDirection: "column" }}
		>
			<Show when={edge() > 0}>{spacer(edge())}</Show>
			<For each={props.items}>
				{(item, index) => {
					const trailing = () => (index() < lastIndex() ? gap() : edge());
					return (
						<>
							{item}
							<Show when={trailing() > 0}>{spacer(trailing())}</Show>
						</>
					);
				}}
			</For>
		</box>
	);
}

/**
 * GridLayout — horizontal columns of stacked items with automatic bgBase
 * spacers. Each column stacks items vertically with 1-line gaps; columns are
 * also separated by a 1-line gap.
 */
export function GridLayout(props: GridLayoutProps) {
	const gap = () => props.gap ?? 1;
	const lastCol = () => props.columns.length - 1;

	return (
		<box
			backgroundColor={uiColors.bgBase}
			style={{
				width: "100%",
				flexGrow: 1,
				minHeight: 0,
				flexDirection: "row",
			}}
		>
			<For each={props.columns}>
				{(col, colIdx) => (
					<>
						<box
							style={{
								width: col.width as number | "auto" | `${number}%`,
								height: "100%",
								flexDirection: "column",
							}}
						>
							<For each={col.items}>
								{(item, itemIdx) => (
									<>
										{itemIdx() > 0 && spacer(gap())}
										{item}
									</>
								)}
							</For>
						</box>
						{colIdx() < lastCol() && (
							<box style={{ width: gap(), height: "100%", flexShrink: 0 }} />
						)}
					</>
				)}
			</For>
		</box>
	);
}
