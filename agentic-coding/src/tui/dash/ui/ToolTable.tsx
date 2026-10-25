/** @jsxImportSource @opentui/solid */
import { uiColors } from "@ui";
import { createMemo, createSignal, For, Show } from "solid-js";
import { statusRow, title } from "./tool-content.ts";
import type { ToolViewRow } from "./tool-views.ts";
import { estimateTextRows, VirtualToolBody } from "./transcript-viewport.tsx";

const TABLE_CHUNK = 20;
export function estimateTableRow(
	row: readonly string[],
	columns: readonly string[],
	width: number,
): number {
	if (width >= columns.length * 18) {
		const cell = Math.max(
			1,
			Math.floor(
				(width - Math.max(0, columns.length - 1) * 2) /
					Math.max(1, columns.length),
			),
		);
		return Math.max(
			1,
			...columns.map((_, index) => estimateTextRows(row[index] ?? "—", cell)),
		);
	}
	return (
		1 +
		columns.reduce(
			(height, column, index) =>
				height +
				estimateTextRows(`${title(column)}: ${row[index] ?? "—"}`, width),
			0,
		)
	);
}

function cellColor(column: string, value: string | undefined): string {
	if (!/^(status|outcome|severity|level)$/i.test(column))
		return uiColors.textPrimary;
	const tone = statusRow("", value).tone;
	return tone === "error"
		? uiColors.error
		: tone === "warning"
			? uiColors.warning
			: tone === "success"
				? uiColors.success
				: uiColors.textPrimary;
}

/** One transcript-owned surface: narrow panes stack cells instead of adding a
 * horizontal scroll box or clipping a long value. */
export function ToolTable(props: { table: NonNullable<ToolViewRow["table"]> }) {
	const [width, setWidth] = createSignal(80);
	const wide = () => width() >= props.table.columns.length * 18;
	const chunks = createMemo(() =>
		Array.from(
			{ length: Math.ceil(props.table.rows.length / TABLE_CHUNK) },
			(_, index) => index * TABLE_CHUNK,
		),
	);
	return (
		<box
			flexDirection="column"
			width="100%"
			onSizeChange={function () {
				setWidth(this.width);
			}}
		>
			<Show when={wide()}>
				<box flexDirection="row" gap={2}>
					<For each={props.table.columns}>
						{(column) => (
							<text
								fg={uiColors.textMuted}
								flexGrow={1}
								flexBasis={0}
								minWidth={0}
								wrapMode="word"
							>
								{title(column)}
							</text>
						)}
					</For>
				</box>
			</Show>
			<Show when={props.table.rows.length === 0}>
				<text
					fg={uiColors.textMuted}
				>{`No results · ${props.table.columns.map(title).join(", ")}`}</text>
			</Show>
			<For each={chunks()}>
				{(start) => (
					<VirtualToolBody
						force
						cacheKey={props.table}
						estimateHeight={(columns) =>
							props.table.rows
								.slice(start, start + TABLE_CHUNK)
								.reduce(
									(height, row) =>
										height +
										estimateTableRow(row, props.table.columns, columns),
									0,
								)
						}
					>
						<For each={props.table.rows.slice(start, start + TABLE_CHUNK)}>
							{(row) => (
								<box
									flexDirection={wide() ? "row" : "column"}
									gap={wide() ? 2 : 0}
									marginBottom={wide() ? 0 : 1}
								>
									<For each={props.table.columns}>
										{(column, index) => (
											<text
												fg={cellColor(column, row[index()])}
												flexGrow={wide() ? 1 : 0}
												flexBasis={wide() ? 0 : undefined}
												minWidth={0}
												wrapMode="word"
											>
												{wide()
													? row[index()]
													: `${title(column)}: ${row[index()] ?? "—"}`}
											</text>
										)}
									</For>
								</box>
							)}
						</For>
					</VirtualToolBody>
				)}
			</For>
		</box>
	);
}
