/** @jsxImportSource @opentui/solid */
import { createMemo, onCleanup, Show } from "solid-js";
import type { EvidenceDocument } from "../../../protocol/evidence.ts";
import type { Data, TaskDetails } from "../../../protocol/index.ts";
import { ActionHeader } from "../../ui/ActionHeader.tsx";
import { SuppliedRecordWindow } from "../../ui/SuppliedRecordWindow.tsx";
import { color } from "../../ui/theme/index.ts";
import { TaskObservation, taskIdentity } from "./TaskObservation.tsx";

/** Supplied catalog navigation and explicit detail only. Window search is local,
 * not an implicit task/review read; native worker IDs never alias app tasks. */
export function TaskPanel(props: {
	evidence: EvidenceDocument | null;
	rows: Data[];
	catalog: Data[];
	selectedId: number | null;
	select: (id: number) => void;
	details: TaskDetails | null;
	error: string | null;
	connected: boolean;
	fresh: boolean;
	reviews: Data[];
	expanded: string[];
	toggle: (id: string) => void;
	prepare: (command: string) => void;
	openSession: (() => void) | null;
}) {
	let disposed = false;
	onCleanup(() => {
		disposed = true;
	});
	const source = createMemo(() => ({
		rows: props.rows,
		catalog: props.catalog,
		details: props.details,
		selected: props.selectedId,
		reviews: props.reviews,
		connected: props.connected,
		fresh: props.fresh,
		error: props.error,
	}));
	const member = (id: unknown): id is number =>
		!disposed &&
		taskIdentity(id) &&
		props.catalog.filter((row) => row.id === id).length === 1;
	const rowMember = (row: Data) =>
		member(row.id) &&
		props.rows.filter((entry) => entry.id === row.id).length === 1 &&
		props.rows.some((entry) => entry === row);
	const select = (id: unknown) => {
		if (member(id)) props.select(id);
	};
	const pending = createMemo(() =>
		props.reviews.filter(
			(review) =>
				review.state === "pending" && review.taskId !== props.selectedId,
		),
	);
	const details = createMemo(() =>
		props.details &&
		props.details.id === props.selectedId &&
		member(props.details.id)
			? props.details
			: null,
	);
	return (
		<box flexDirection="column" gap={1}>
			<text fg={color("primary")}>Tasks · {props.rows.length}</text>
			<SuppliedRecordWindow
				rows={props.rows}
				scope={source()}
				label="tasks"
				title={(row) =>
					`#${String(row.id ?? "not supplied")} · ${String(row.skill ?? "not supplied")} · ${String(row.detail ?? "not supplied")}`
				}
				search={(row) => JSON.stringify(row)}
				selected={(row) => row.id === props.selectedId}
			>
				{(row) => (
					<box flexDirection="column">
						<ActionHeader
							scope={source()}
							interactive={rowMember(row)}
							onActivate={() => {
								if (rowMember(row)) select(row.id);
							}}
						>
							<text
								fg={
									row.id === props.selectedId
										? color("accent")
										: color("textMuted")
								}
							>
								{row.id === props.selectedId ? "›" : "·"} #
								{String(row.id ?? "not supplied")} ·{" "}
								{String(row.skill ?? "not supplied")} ·{" "}
								{String(row.detail ?? "not supplied")}
							</text>
						</ActionHeader>
						<Show when={!rowMember(row)}>
							<text fg={color("warning")}>
								Missing or ambiguous app-task identity; no navigation or
								arbitrary worker adoption.
							</text>
						</Show>
					</box>
				)}
			</SuppliedRecordWindow>
			<Show when={pending().length}>
				<text fg={color("warning")}>
					Other pending native reviews (explicitly select supplied owner to
					inspect)
				</text>
				<SuppliedRecordWindow
					rows={pending()}
					scope={source()}
					label="pending review observations"
					title={(review) =>
						`#${String(review.taskId)} · ${String(review.title)} · ${String(review.id)}@${String(review.revision)}`
					}
					search={(review) => JSON.stringify(review)}
				>
					{(review) => (
						<ActionHeader
							scope={source()}
							interactive={
								member(review.taskId) &&
								props.reviews.filter((entry) => entry.id === review.id)
									.length === 1
							}
							onActivate={() => {
								if (
									props.reviews.filter((entry) => entry.id === review.id)
										.length === 1
								)
									select(review.taskId);
							}}
						>
							<text fg={color("warning")}>
								#{String(review.taskId)} · {String(review.title)} ·{" "}
								{String(review.id)}@{String(review.revision)}
							</text>
						</ActionHeader>
					)}
				</SuppliedRecordWindow>
			</Show>
			<Show when={props.error}>
				<text fg={color("warning")}>{props.error}</text>
			</Show>
			<Show when={props.details && !details()}>
				<text fg={color("warning")}>
					Detail owner does not match a unique selected catalog task; cached
					controls withheld.
				</text>
			</Show>
			<Show when={details()} keyed>
				{(saved) => (
					<TaskObservation
						details={saved}
						current={() => !disposed && details() === saved}
						scope={source()}
						catalog={props.catalog}
						reviews={props.reviews}
						fresh={props.fresh}
						connected={props.connected}
						error={props.error}
						expanded={props.expanded}
						toggle={props.toggle}
						prepare={props.prepare}
						select={select}
						openSession={props.openSession}
						evidence={props.evidence}
					/>
				)}
			</Show>
		</box>
	);
}
