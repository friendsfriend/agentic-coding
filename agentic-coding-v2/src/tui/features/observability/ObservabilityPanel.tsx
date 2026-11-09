/** @jsxImportSource @opentui/solid */
import { createHash } from "node:crypto";
import { createMemo, Show } from "solid-js";
import type { Data } from "../../../protocol/index.ts";
import { ActionHeader } from "../../ui/ActionHeader.tsx";
import { DetailsFold } from "../../ui/DetailsFold.tsx";
import { SuppliedObservation } from "../../ui/SuppliedObservation.tsx";
import { SuppliedRecordWindow } from "../../ui/SuppliedRecordWindow.tsx";
import { color } from "../../ui/theme/index.ts";

/** Observed native journals only. No receipt restores execution, rollback or
 * lease authority; record selection/disclosure never fetches a backend. */
export function ObservabilityPanel(props: {
	rows: Data[];
	selected: (row: Data, index: number) => boolean;
	select: (row: Data, index: number) => void;
	environments: Data | undefined;
	connected: boolean;
	expanded: string[];
	toggle: (key: string) => void;
	openTask: (id: number) => void;
}) {
	const source = createMemo(() => ({
		rows: props.rows,
		environments: props.environments,
		connected: props.connected,
	}));
	const member = (row: Data) =>
		row.id !== undefined &&
		props.rows.filter((entry) => entry.id === row.id).length === 1 &&
		props.rows.some((entry) => entry === row);
	return (
		<box flexDirection="column" gap={1}>
			<text fg={color("primary")}>Journals · {props.rows.length}</text>
			<text fg={color("textMuted")}>
				{props.connected ? "Last observed" : "Disconnected, last read"} · HTTP{" "}
				{String(props.environments?.httpHistoryLimit ?? "unknown")} of{" "}
				{String(props.environments?.httpOperationsTotal ?? "unknown")} · query{" "}
				{String(props.environments?.queryHistoryLimit ?? "unknown")} · wait{" "}
				{String(props.environments?.waitHistoryLimit ?? "unknown")}
			</text>
			<DetailsFold
				label="Scope"
				summary="which observations this view holds"
				scope={source()}
			>
				<text wrapMode="word" fg={color("textMuted")}>
					{String(
						props.environments?.referenceGraphScope ??
							"Reference graph scope unavailable",
					)}
				</text>
				<text fg={color("textMuted")}>
					Issued means pending, not completed or rolled back. No spans or remote
					logs are read here.
				</text>
			</DetailsFold>
			<SuppliedRecordWindow
				rows={props.rows}
				scope={source()}
				label="diagnostic journal records"
				title={(row) =>
					`${String(row.journal ?? "not supplied")} · ${String(row.nativeIdentity ?? "not supplied")} · ${String(row.state ?? row.observation ?? "unknown")}`
				}
				search={(row) => JSON.stringify(row)}
				selected={props.selected}
				pick={(row, index) => {
					if (!member(row)) return false;
					props.select(row, index);
					return true;
				}}
			>
				{(row, index) => {
					const key = createMemo(
						() =>
							`diagnostic:${createHash("sha256").update(JSON.stringify(row)).digest("hex")}:${index()}`,
					);
					return (
						<box flexDirection="column" gap={1}>
							<ActionHeader
								scope={source()}
								interactive={member(row)}
								onActivate={() => {
									if (member(row)) props.select(row, index());
								}}
							>
								<box flexDirection="row">
									<text fg={color("primary")}>
										{props.selected(row, index()) ? "▾" : "▸"}{" "}
										{String(row.journal ?? "journal")} ·{" "}
										{String(row.nativeIdentity ?? "no identity")}
									</text>
									<text fg={color("textMuted")}>
										{` — ${String(row.state ?? row.observation ?? "unknown")}`}
									</text>
								</box>
							</ActionHeader>
							<Show when={!member(row)}>
								<text fg={color("warning")}>
									Identity is missing or ambiguous · navigation disabled
								</text>
							</Show>
							<Show when={props.selected(row, index())}>
								<text wrapMode="word" fg={color("textMuted")}>
									{String(row.app ?? "no app")} · run{" "}
									{String(row.run ?? "none")} · owner{" "}
									{String(row.owner ?? "none")} · issued{" "}
									{String(row.issuedAt ?? "unrecorded")} · observed{" "}
									{String(row.observedAt ?? "unrecorded")}
								</text>
								<Show when={row.issuedAt !== undefined}>
									<text>
										Issued {String(row.issuedAt)} · observed{" "}
										{String(row.observedAt ?? "not supplied")} (epoch ms)
									</text>
								</Show>
								<Show when={row.authority}>
									<text fg={color("warning")} wrapMode="word">
										{String(row.authority)}
									</text>
								</Show>
								<Show
									when={
										member(row) &&
										Number.isSafeInteger(row.owner) &&
										Number(row.owner) > 0
									}
								>
									<ActionHeader
										scope={source()}
										interactive={member(row)}
										onActivate={() => {
											if (
												member(row) &&
												Number.isSafeInteger(row.owner) &&
												Number(row.owner) > 0
											)
												props.openTask(Number(row.owner));
										}}
									>
										<text fg={color("accent")}>
											Open owner task #{String(row.owner)}
										</text>
									</ActionHeader>
								</Show>
								<ActionHeader
									scope={source()}
									onActivate={() => props.toggle(key())}
								>
									<text fg={color("accent")}>
										{props.expanded.includes(key()) ? "▾" : "▸"} Record
									</text>
								</ActionHeader>
								<Show when={props.expanded.includes(key())}>
									<SuppliedObservation
										value={row}
										label="Journal record"
										scope={source()}
									/>
								</Show>
							</Show>
						</box>
					);
				}}
			</SuppliedRecordWindow>
			<Show when={!props.rows.length}>
				<text fg={color("textMuted")}>No journal records.</text>
			</Show>
		</box>
	);
}
