/** @jsxImportSource @opentui/solid */
import { uiColors } from "@ui";
import { createSignal, For, Show } from "solid-js";
import { statusRow, title } from "./tool-content.ts";
import type { ToolViewRow } from "./tool-views.ts";

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
			<For each={props.table.rows}>
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
		</box>
	);
}
