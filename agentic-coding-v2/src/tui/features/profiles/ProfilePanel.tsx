/** @jsxImportSource @opentui/solid */
import { createMemo, onCleanup, Show } from "solid-js";
import type { Data, Session } from "../../../protocol/index.ts";
import { ActionHeader } from "../../ui/ActionHeader.tsx";
import { DetailsFold } from "../../ui/DetailsFold.tsx";
import { SuppliedObservation } from "../../ui/SuppliedObservation.tsx";
import { SuppliedRecordWindow } from "../../ui/SuppliedRecordWindow.tsx";
import { color } from "../../ui/theme/index.ts";
/** Running host definitions only. Choosing a local range/target never performs
 * model inspection, discovery, configuration or upstream connectivity probes. */
export function ProfilePanel(props: {
	rows: Data[];
	selected: (row: Data, index: number) => boolean;
	select: (row: Data, index: number) => void;
	sessions: Session[];
	target: number | null;
	selectTarget: (id: number) => void;
	inspection: Data | null;
	connected: boolean;
	fresh: boolean;
	prepare: (command: string) => void;
	open: (id: number) => void;
}) {
	let disposed = false;
	onCleanup(() => {
		disposed = true;
	});
	const source = createMemo(() => ({
		rows: props.rows,
		sessions: props.sessions,
		target: props.target,
		inspection: props.inspection,
		connected: props.connected,
		fresh: props.fresh,
	}));
	const sessionMember = (session: Session) =>
		!disposed &&
		Number.isSafeInteger(session.id) &&
		session.id > 0 &&
		props.sessions.filter((entry) => entry.id === session.id).length === 1 &&
		props.sessions.some((entry) => entry === session);
	const target = createMemo(() => {
		const matches = props.sessions.filter(
			(session) => session.id === props.target,
		);
		const row = matches[0];
		return matches.length === 1 && row && sessionMember(row) ? row : null;
	});
	const inspection = createMemo(() =>
		target() && props.inspection?.id === target()?.id ? props.inspection : null,
	);
	const rowMember = (row: Data) =>
		!disposed &&
		props.rows.some((entry) => entry === row) &&
		props.rows.filter((entry) => entry.id === row.id).length === 1;
	const commandSafe = (row: Data) =>
		rowMember(row) &&
		typeof row.id === "string" &&
		row.id.length > 0 &&
		row.id.length <= 128 &&
		!/\s/.test(row.id) &&
		Array.from(row.id).every(
			(char) => char.charCodeAt(0) >= 32 && char.charCodeAt(0) !== 127,
		);
	const ready = () => !disposed && props.connected && props.fresh;
	const switchable = (row: Data) =>
		ready() &&
		commandSafe(row) &&
		target()?.writable === true &&
		row.available === true;
	return (
		<box flexDirection="column" gap={1}>
			<text fg={color("primary")}>Profiles and models</text>
			<text fg={color("textMuted")}>
				Profiles the running host loaded · changing one affects that
				conversation only
			</text>
			<Show when={!ready()}>
				<text fg={color("warning")}>Disconnected · switching withheld</text>
			</Show>
			<text fg={color("textMuted")}>Conversation</text>
			<SuppliedRecordWindow
				rows={props.sessions}
				scope={source()}
				label="native conversation targets"
				title={(session) =>
					`#${session.id} · ${session.title} · ${session.writable ? "writable" : "read-only/terminal"}`
				}
				search={(session) => JSON.stringify(session)}
				selected={(session) => session.id === props.target}
				pick={(session) => {
					if (!sessionMember(session)) return false;
					props.selectTarget(session.id);
					return true;
				}}
			>
				{(session) => (
					<box
						flexDirection="column"
						backgroundColor={
							props.target === session.id
								? color("backgroundPanel")
								: color("background")
						}
					>
						<ActionHeader
							scope={source()}
							interactive={sessionMember(session)}
							onActivate={() => {
								if (sessionMember(session)) props.selectTarget(session.id);
							}}
						>
							<text fg={color("accent")}>
								{props.target === session.id ? "▾" : "▸"} #{session.id} ·{" "}
								{session.title} ·{" "}
								{session.writable ? "writable" : "read-only/terminal"}
							</text>
						</ActionHeader>
						<Show when={props.target === session.id && sessionMember(session)}>
							<text>
								Parent: {session.parent ?? "none"} · task:{" "}
								{session.task ?? "none"}
							</text>
							<ActionHeader
								scope={source()}
								interactive={sessionMember(session)}
								onActivate={() => {
									if (sessionMember(session)) props.open(session.id);
								}}
							>
								<text fg={color("accent")}>
									Open catalog-owned transcript (no configuration change)
								</text>
							</ActionHeader>
							<Show when={ready()}>
								<ActionHeader
									scope={source()}
									interactive={ready() && sessionMember(session)}
									onActivate={() => {
										if (ready() && sessionMember(session))
											props.prepare(`/inspect-model ${session.id}`);
									}}
								>
									<text fg={color("accent")}>Read current model</text>
								</ActionHeader>
							</Show>
						</Show>
						<Show when={!sessionMember(session)}>
							<text fg={color("warning")}>
								Identity is missing or ambiguous · cannot be targeted
							</text>
						</Show>
					</box>
				)}
			</SuppliedRecordWindow>
			<Show when={props.target !== null && !target()}>
				<text fg={color("warning")}>
					Conversation #{props.target} is no longer in the catalog
				</text>
			</Show>
			<Show when={inspection()} keyed>
				{(saved) => (
					<box flexDirection="column" gap={1}>
						<text wrapMode="word" fg={color("textMuted")}>
							Current model {String(saved.model ?? "none")} · thinking{" "}
							{String(saved.thinking)} · read {String(saved.observedAt)}
						</text>
						<SuppliedObservation
							value={saved}
							scope={source()}
							label="Complete supplied model/thinking inspection"
						/>
					</box>
				)}
			</Show>
			<Show when={!props.rows.length}>
				<text fg={color("textMuted")}>No profiles match the filter.</text>
			</Show>
			<SuppliedRecordWindow
				rows={props.rows}
				scope={source()}
				label="running-host profiles"
				title={(row) =>
					`${String(row.id)} · ${String(row.provider)}/${String(row.modelId)} · thinking ${String(row.thinking)}`
				}
				search={(row) => JSON.stringify(row)}
				selected={props.selected}
				pick={(row, index) => {
					if (!rowMember(row)) return false;
					props.select(row, index);
					return true;
				}}
			>
				{(row, index) => (
					<box
						flexDirection="column"
						backgroundColor={
							props.selected(row, index())
								? color("backgroundPanel")
								: color("background")
						}
					>
						<ActionHeader
							scope={source()}
							interactive={rowMember(row)}
							onActivate={() => {
								if (rowMember(row)) props.select(row, index());
							}}
						>
							<box flexDirection="row">
								<text fg={color("primary")}>
									{props.selected(row, index()) ? "▾" : "▸"} {String(row.id)}
								</text>
								<text fg={color("textMuted")}>
									{` — ${String(row.provider)}/${String(row.modelId)} · ${String(row.thinking)}`}
								</text>
							</box>
						</ActionHeader>
						<Show when={props.selected(row, index())}>
							<text wrapMode="word" fg={color("textMuted")}>
								{String(row.description ?? "No description")}
							</text>
							<text
								fg={
									row.available === true ? color("success") : color("warning")
								}
							>
								{row.available === true
									? "Credential present"
									: "Credential missing or unknown"}
							</text>
							<Show when={!commandSafe(row)}>
								<text fg={color("warning")}>
									Profile identity is missing or ambiguous · switching withheld
								</text>
							</Show>
							<Show when={switchable(row)}>
								<ActionHeader
									scope={source()}
									interactive={switchable(row)}
									onActivate={() => {
										const savedTarget = target();
										if (savedTarget && switchable(row))
											props.prepare(
												`/model-for ${savedTarget.id} ${String(row.id)}`,
											);
									}}
								>
									<text fg={color("accent")}>
										Switch conversation #{props.target} to {String(row.id)}
									</text>
								</ActionHeader>
							</Show>
							<DetailsFold
								label="Profile"
								summary="supplied fields"
								scope={source()}
							>
								<SuppliedObservation
									value={row}
									scope={source()}
									label="Profile"
								/>
							</DetailsFold>
						</Show>
					</box>
				)}
			</SuppliedRecordWindow>
		</box>
	);
}
