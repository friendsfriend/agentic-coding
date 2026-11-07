/** @jsxImportSource @opentui/solid */
import { For, Show } from "solid-js";
import type { Data, Session } from "../../../protocol/index.ts";
import { ActionHeader } from "../../ui/ActionHeader.tsx";
import { color } from "../../ui/theme/index.ts";

/** Current host definitions, not saved restart-required settings or provider discovery. */
export function ProfilePanel(props: {
	rows: Data[];
	selected: (row: Data, index: number) => boolean;
	select: (row: Data, index: number) => void;
	sessions: Session[];
	target: number | null;
	selectTarget: (id: number) => void;
	inspection: Data | null;
	connected: boolean;
	prepare: (command: string) => void;
	open: (id: number) => void;
}) {
	const target = () =>
		props.sessions.find((session) => session.id === props.target);
	const inspection = () =>
		props.inspection?.id === props.target ? props.inspection : null;
	return (
		<box flexDirection="column" gap={1}>
			<text fg={color("primary")}>Native profiles & conversation models</text>
			<text wrapMode="word">
				These are running-host definitions, not newly saved settings awaiting
				restart. Availability is a recorded registry/auth hint, not a successful
				generation or upstream connectivity proof. This panel never discovers
				models, fetches credentials or probes a provider.
			</text>
			<Show when={!props.connected}>
				<text fg={color("warning")}>
					Disconnected: inventory and inspection are cached; commands cannot be
					prepared here.
				</text>
			</Show>
			<text fg={color("primary")}>
				Choose an explicit native conversation target
			</text>
			<For each={props.sessions}>
				{(session) => (
					<box
						flexDirection="column"
						backgroundColor={
							props.target === session.id
								? color("backgroundPanel")
								: color("background")
						}
					>
						<ActionHeader onActivate={() => props.selectTarget(session.id)}>
							<text fg={color("accent")}>
								{props.target === session.id ? "▾" : "▸"} #{session.id} ·{" "}
								{session.title} ·{" "}
								{session.writable ? "writable" : "read-only/terminal"}
							</text>
						</ActionHeader>
						<Show when={props.target === session.id}>
							<text>
								Parent: {session.parent ?? "none"} · task:{" "}
								{session.task ?? "none"}
							</text>
							<ActionHeader onActivate={() => props.open(session.id)}>
								<text fg={color("accent")}>
									Open catalog-owned transcript (no configuration change)
								</text>
							</ActionHeader>
							<Show when={props.connected}>
								<ActionHeader
									onActivate={() =>
										props.prepare(`/inspect-model ${session.id}`)
									}
								>
									<text fg={color("accent")}>
										Prepare current model/thinking inspection (explicit read)
									</text>
								</ActionHeader>
							</Show>
						</Show>
					</box>
				)}
			</For>
			<Show when={props.target !== null && !target()}>
				<text fg={color("warning")}>
					Selected conversation #{props.target} is no longer catalog-owned. No
					adoption or configuration is attempted.
				</text>
			</Show>
			<Show when={inspection()}>
				<text wrapMode="word">
					Cached native inspection · received {String(inspection()?.observedAt)}{" "}
					· model {String(inspection()?.model ?? "none")} · thinking{" "}
					{String(inspection()?.thinking)}. Read and live inventory are not
					atomic; refresh inspection to verify a switch.
				</text>
			</Show>
			<Show when={props.rows.length === 0}>
				<text>
					No profiles in the current filtered host inventory. Saved settings do
					not hot-load here.
				</text>
			</Show>
			<For each={props.rows}>
				{(row, index) => {
					const commandSafe = () =>
						typeof row.id === "string" &&
						row.id.length > 0 &&
						row.id.length <= 128 &&
						!/\s/.test(row.id);
					return (
						<box
							flexDirection="column"
							backgroundColor={
								props.selected(row, index())
									? color("backgroundPanel")
									: color("background")
							}
						>
							<ActionHeader onActivate={() => props.select(row, index())}>
								<text fg={color("primary")}>
									{props.selected(row, index()) ? "▾" : "▸"} {String(row.id)} ·{" "}
									{String(row.provider)}/{String(row.modelId)} · thinking{" "}
									{String(row.thinking)}
								</text>
							</ActionHeader>
							<Show when={props.selected(row, index())}>
								<text wrapMode="word">
									{String(row.description ?? "No description")}
								</text>
								<text
									fg={
										row.available === true ? color("success") : color("warning")
									}
								>
									Registry/auth hint:{" "}
									{row.available === true ? "available" : "unavailable/unknown"}
									. No token value or generation proof is shown.
								</text>
								<text wrapMode="word">
									Switch changes this conversation's native model and thinking
									level only. It does not rewrite task admission metadata, saved
									profiles, future defaults, schedules or another conversation.
									It does not imply rollback, replay, cancellation or
									replacement of an in-flight generation.
								</text>
								<Show when={!commandSafe()}>
									<text fg={color("warning")}>
										This profile ID cannot be safely represented as a command
										token; no command is generated.
									</text>
								</Show>
								<Show
									when={
										props.connected &&
										commandSafe() &&
										target()?.writable &&
										row.available === true
									}
								>
									<ActionHeader
										onActivate={() =>
											props.prepare(
												`/model-for ${props.target} ${String(row.id)}`,
											)
										}
									>
										<text fg={color("accent")}>
											Prepare switching conversation #{props.target} to{" "}
											{String(row.id)} (submit explicitly)
										</text>
									</ActionHeader>
								</Show>
							</Show>
						</box>
					);
				}}
			</For>
		</box>
	);
}
