/** @jsxImportSource @opentui/solid */
import type { SyntaxStyle } from "@opentui/core";
import { For, Show } from "solid-js";
import { DetailsFold } from "../../ui/DetailsFold.tsx";
import { color } from "../../ui/theme/index.ts";
import type {
	CustomBody,
	CustomRow,
	CustomSection,
} from "./custom-tool-view.ts";
import { SuppliedCode } from "./SuppliedCode.tsx";

/** One projected row. A row is drawn from the data the call supplied: source
 * keeps its language, a table keeps its columns, a status row keeps its tone,
 * and a nested record stays behind its own disclosure so a deep result never
 * turns into a wall of text. */
function Row(props: {
	row: CustomRow;
	syntax: SyntaxStyle;
	interactive?: boolean;
	depth?: number;
}) {
	const tone = () =>
		props.row.tone === "error"
			? color("error")
			: props.row.tone === "warning"
				? color("warning")
				: props.row.tone === "success"
					? color("success")
					: color("text");
	const depth = () => Math.min(props.depth ?? 0, 6);
	return (
		<box flexDirection="column">
			<Show when={props.row.table}>
				{(table) => <Table columns={table().columns} rows={table().rows} />}
			</Show>
			<Show when={!props.row.table && props.row.syntax !== undefined}>
				<SuppliedCode
					content={props.row.text}
					filetype={props.row.syntax}
					syntax={props.syntax}
					interactive={props.interactive}
				/>
			</Show>
			<Show when={!props.row.table && props.row.syntax === undefined}>
				<Show
					when={props.row.markdown === true}
					fallback={
						<Show when={props.row.text.length > 0}>
							<text
								fg={tone()}
								wrapMode={props.row.shell ? "none" : "word"}
								style={{ paddingLeft: depth() }}
							>
								{props.row.lineNumber === undefined
									? props.row.text
									: `${props.row.lineNumber}: ${props.row.text}`}
							</text>
						</Show>
					}
				>
					<SuppliedCode
						content={props.row.text}
						presentation="markdown"
						syntax={props.syntax}
						interactive={props.interactive}
					/>
				</Show>
			</Show>
			<Show when={props.row.detail}>
				{(detail) => (
					<box flexDirection="column">
						<For each={detail()}>
							{(row) => (
								<Row
									row={row}
									syntax={props.syntax}
									interactive={props.interactive}
									depth={depth() + 1}
								/>
							)}
						</For>
					</box>
				)}
			</Show>
		</box>
	);
}

/** A table of supplied cells: columns keep their supplied order, widths are
 * measured once from the values themselves, and a cell that would overflow is
 * clipped rather than wrapped so the columns stay aligned. */
function Table(props: {
	columns: readonly string[];
	rows: readonly (readonly string[])[];
}) {
	const widths = () =>
		props.columns.map((column, index) =>
			Math.min(
				32,
				Math.max(
					Array.from(column).length,
					...props.rows.map((row) => Array.from(row[index] ?? "").length),
				),
			),
		);
	const line = (cells: readonly string[]) =>
		cells
			.map((cell, index) => {
				const points = Array.from(cell);
				const width = widths()[index] ?? 0;
				return points.length > width
					? `${points.slice(0, Math.max(0, width - 1)).join("")}…`.padEnd(width)
					: points.join("").padEnd(width);
			})
			.join(" │ ");
	return (
		<box flexDirection="column">
			<text fg={color("textMuted")} wrapMode="none">
				{line(props.columns)}
			</text>
			<text fg={color("textMuted")} wrapMode="none">
				{widths()
					.map((width) => "─".repeat(Math.max(1, width)))
					.join("─┼─")}
			</text>
			<For each={props.rows}>
				{(row) => (
					<text fg={color("text")} wrapMode="none">
						{line(row)}
					</text>
				)}
			</For>
		</box>
	);
}

function Section(props: {
	section: CustomSection;
	syntax: SyntaxStyle;
	interactive?: boolean;
}) {
	return (
		<DetailsFold
			interactive={props.interactive}
			label={props.section.label}
			summary={`${props.section.rows.length} rows`}
		>
			<box flexDirection="column">
				<For each={props.section.rows}>
					{(row) => (
						<Row
							row={row}
							syntax={props.syntax}
							interactive={props.interactive}
						/>
					)}
				</For>
			</box>
		</DetailsFold>
	);
}

/** The family's own reading of its result: the rows it can say directly, then
 * its independently foldable sections. Nothing here is fetched or inferred. */
export function CustomToolBody(props: {
	body: CustomBody;
	syntax: SyntaxStyle;
	interactive?: boolean;
}) {
	return (
		<box flexDirection="column">
			<For each={props.body.rows}>
				{(row) => (
					<Row
						row={row}
						syntax={props.syntax}
						interactive={props.interactive}
					/>
				)}
			</For>
			<For each={props.body.sections}>
				{(section) => (
					<Section
						section={section}
						syntax={props.syntax}
						interactive={props.interactive}
					/>
				)}
			</For>
		</box>
	);
}
