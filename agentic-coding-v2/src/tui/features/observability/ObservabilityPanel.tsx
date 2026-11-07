/** @jsxImportSource @opentui/solid */
import { For, Show } from "solid-js";
import type { Data } from "../../../protocol/index.ts";
import { ActionHeader } from "../../ui/ActionHeader.tsx";
import { color } from "../../ui/theme/index.ts";

/** Observed native journals only. Receipts never restore execution, rollback or lease authority. */
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
	return (
		<box flexDirection="column" gap={1}>
			<text fg={color("primary")}>
				Native diagnostic journals · {props.rows.length} matching records
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
			<For each={props.rows}>
				{(row, index) => (
					<box
						flexDirection="column"
						border={true}
						borderColor={
							props.selected(row, index()) ? color("accent") : color("border")
						}
						padding={1}
						gap={1}
					>
						<ActionHeader onActivate={() => props.select(row, index())}>
							<text fg={color("primary")}>
								{props.selected(row, index()) ? "▾" : "▸"} {String(row.journal)}{" "}
								· {String(row.nativeIdentity)} ·{" "}
								{String(row.state ?? row.observation ?? "unknown")}
							</text>
						</ActionHeader>
						<Show when={props.selected(row, index())}>
							<text wrapMode="word">
								App {String(row.app ?? "not recorded")} · run{" "}
								{String(row.run ?? "not recorded")} · owner{" "}
								{String(row.owner ?? "not recorded")}
							</text>
							<Show when={row.issuedAt !== undefined}>
								<text>
									Issued {String(row.issuedAt)} · observed{" "}
									{String(row.observedAt ?? "not recorded")} (epoch ms)
								</text>
							</Show>
							<Show when={row.authority}>
								<text fg={color("warning")} wrapMode="word">
									{String(row.authority)}
								</text>
							</Show>
							<Show when={typeof row.owner === "number"}>
								<ActionHeader
									onActivate={() => props.openTask(Number(row.owner))}
								>
									<text fg={color("accent")}>
										Inspect catalog-owned task #{String(row.owner)}
									</text>
								</ActionHeader>
							</Show>
							<ActionHeader
								onActivate={() => props.toggle(`diagnostic:${String(row.id)}`)}
							>
								<text fg={color("accent")}>
									{props.expanded.includes(`diagnostic:${String(row.id)}`)
										? "▾"
										: "▸"}{" "}
									Complete observed record
								</text>
							</ActionHeader>
							<Show
								when={props.expanded.includes(`diagnostic:${String(row.id)}`)}
							>
								<text wrapMode="word">{JSON.stringify(row, null, 2)}</text>
							</Show>
						</Show>
					</box>
				)}
			</For>
			<Show when={!props.rows.length}>
				<text fg={color("textMuted")}>
					No matching recorded observations. This is not proof of no activity or
					successful cleanup.
				</text>
			</Show>
		</box>
	);
}
