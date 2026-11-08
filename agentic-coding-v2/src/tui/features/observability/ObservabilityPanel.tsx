/** @jsxImportSource @opentui/solid */
import { createHash } from "node:crypto";
import { createMemo, Show } from "solid-js";
import type { Data } from "../../../protocol/index.ts";
import { ActionHeader } from "../../ui/ActionHeader.tsx";
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
			<text fg={color("primary")}>
				Native diagnostic journals · {props.rows.length} matching supplied
				records
			</text>
			<text fg={color("textMuted")}>
				{props.connected
					? "Last observed inventory, not an atomic system revision"
					: "Cached inventory; current activity unknown"}
				. No external telemetry/backend request runs on navigation.
			</text>
			<text wrapMode="word">
				HTTP: newest {String(props.environments?.httpHistoryLimit ?? "unknown")}{" "}
				of {String(props.environments?.httpOperationsTotal ?? "unknown")}{" "}
				observed operations · query history limit{" "}
				{String(props.environments?.queryHistoryLimit ?? "unknown")} · wait
				history limit{" "}
				{String(props.environments?.waitHistoryLimit ?? "unknown")}
			</text>
			<text wrapMode="word">
				{String(
					props.environments?.referenceGraphScope ??
						"Reference graph scope unavailable",
				)}
			</text>
			<text fg={color("warning")}>
				Issued means pending/uncertain, never completed execution or verified
				rollback. Reference graphs are observations, not live lease/control
				authority. No spans or remote logs are fetched by this view.
			</text>
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
						<box
							flexDirection="column"
							border={true}
							borderColor={
								props.selected(row, index()) ? color("accent") : color("border")
							}
							padding={1}
							gap={1}
						>
							<ActionHeader
								scope={source()}
								interactive={member(row)}
								onActivate={() => {
									if (member(row)) props.select(row, index());
								}}
							>
								<text fg={color("primary")}>
									{props.selected(row, index()) ? "▾" : "▸"}{" "}
									{String(row.journal ?? "not supplied")} ·{" "}
									{String(row.nativeIdentity ?? "not supplied")} ·{" "}
									{String(row.state ?? row.observation ?? "unknown")}
								</text>
							</ActionHeader>
							<Show when={!member(row)}>
								<text fg={color("warning")}>
									Missing or ambiguous identity; navigation disabled.
								</text>
							</Show>
							<Show when={props.selected(row, index())}>
								<text wrapMode="word">
									App {String(row.app ?? "not supplied")} · run{" "}
									{String(row.run ?? "not supplied")} · owner{" "}
									{String(row.owner ?? "not supplied")}
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
											Open supplied catalog-owned task #{String(row.owner)} (no
											lease adoption)
										</text>
									</ActionHeader>
								</Show>
								<ActionHeader
									scope={source()}
									onActivate={() => props.toggle(key())}
								>
									<text fg={color("accent")}>
										{props.expanded.includes(key()) ? "▾" : "▸"} Supplied
										journal record in bounded local source windows
									</text>
								</ActionHeader>
								<Show when={props.expanded.includes(key())}>
									<SuppliedObservation
										value={row}
										label="Supplied native journal record"
										scope={source()}
									/>
								</Show>
							</Show>
						</box>
					);
				}}
			</SuppliedRecordWindow>
			<Show when={!props.rows.length}>
				<text fg={color("textMuted")}>
					No matching recorded observations. Not proof of no activity or
					successful cleanup.
				</text>
			</Show>
		</box>
	);
}
