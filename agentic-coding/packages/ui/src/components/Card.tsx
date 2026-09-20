/** @jsxImportSource @opentui/solid */
// Generic card row — the shared card chrome for list entries (reference:
// opentui-starter `src/ui/components/Card.tsx`, styling from devenv's work-item
// rows in the issues/change-request views).
//
// A card is one selectable row: the block selector strip, one space, then a
// bold title and an equal-width cell grid. Callers own the cells' content, so
// the same card serves a settings entry, a destination, a repository and a
// change request.
import { TextAttributes } from "@opentui/core";
import { For, type JSX, Show } from "solid-js";
import { uiColors } from "../theme/colors";
import { Selectable } from "./Selectable.tsx";

export interface CardProps {
	/** User-defined cell content. `columns` decides the grid shape (2×2, 2×3, …). */
	cells?: JSX.Element[];
	/** Cells per row. Default 1: one full-width cell per line. */
	columns?: number;
	title?: string;
	selected?: boolean | (() => boolean);
	/** Block selector colour while selected. Defaults to `highlight`. */
	accent?: string;
	onMouseUp?: () => void;
	/** Fixed height in rows; when omitted the card is as tall as its content. */
	height?: number;
	style?: Record<string, unknown>;
}

/**
 * Selectable card with an arbitrary equal-width cell grid.
 *
 * Row chrome (block selector, selected surface, the space between them) lives in
 * `Selectable`; this adds the title line and the cell grid on top of it.
 */
export function Card(props: CardProps) {
	const selected = () =>
		typeof props.selected === "function"
			? props.selected()
			: Boolean(props.selected);
	const columns = () => Math.max(1, props.columns ?? 1);
	const cells = () => props.cells ?? [];
	const rows = () =>
		Array.from({ length: Math.ceil(cells().length / columns()) }, (_, row) =>
			cells().slice(row * columns(), (row + 1) * columns()),
		);
	const cellWidth = () => `${100 / columns()}%` as `${number}%`;

	return (
		<Selectable
			selected={selected()}
			indicatorColor={props.accent}
			onMouseUp={props.onMouseUp}
			height={props.height}
		>
			<box
				style={{
					width: "100%",
					flexDirection: "column",
					overflow: "hidden",
					...props.style,
				}}
			>
				<Show when={props.title}>
					<text fg={uiColors.textPrimary} attributes={TextAttributes.BOLD}>
						{props.title}
					</text>
				</Show>
				<For each={rows()}>
					{(row) => (
						<box style={{ width: "100%", flexDirection: "row" }}>
							<For each={row}>
								{(cell, index) => (
									<box
										width={cellWidth()}
										minWidth={0}
										overflow="hidden"
										flexDirection="row"
										// In a multi-cell row the last cell is the value column and
										// right-aligns; a row with a single cell is a subtitle
										// line (metadata, detail) and reads left to right.
										justifyContent={
											row.length > 1 && index() === row.length - 1
												? "flex-end"
												: "flex-start"
										}
									>
										{cell}
									</box>
								)}
							</For>
						</box>
					)}
				</For>
			</box>
		</Selectable>
	);
}
