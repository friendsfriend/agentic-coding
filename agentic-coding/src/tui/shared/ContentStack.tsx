/** @jsxImportSource @opentui/solid */
import { For, type JSX } from "solid-js";
import { uiColors } from "./colors";

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

export function ContentFrame(props: ContentFrameProps) {
	const gap = () => props.gap ?? 1;

	return (
		<box
			backgroundColor={uiColors.bgBase}
			style={{ width: "100%", height: "100%", flexDirection: "column" }}
		>
			{spacer(gap())}
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
			{spacer(gap())}
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
	const gap = () => props.gap ?? 1;

	return (
		<box
			backgroundColor={uiColors.bgBase}
			style={{ width: "100%", height: "100%", flexDirection: "column" }}
		>
			{spacer(gap())}
			<For each={props.items}>
				{(item) => (
					<>
						{item}
						{spacer(gap())}
					</>
				)}
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
