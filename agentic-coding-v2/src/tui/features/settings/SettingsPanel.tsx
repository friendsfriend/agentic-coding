/** @jsxImportSource @opentui/solid */
// Settings page: the list of settings, the two explicit draft actions, and the
// advanced JSON behind a fold. Saving prepares a native candidate the developer
// still has to approve; this page never writes, validates or restarts anything.
import { createMemo, createSignal, onCleanup, Show } from "solid-js";
import type {
	SettingsCandidate,
	SettingsDocument,
} from "../../../protocol/index.ts";
import { ActionHeader } from "../../ui/ActionHeader.tsx";
import { LocalJsonEditor } from "../../ui/LocalJsonEditor.tsx";
import { PreparedCandidate } from "../../ui/PreparedCandidate.tsx";
import { SuppliedObservation } from "../../ui/SuppliedObservation.tsx";
import { color } from "../../ui/theme/index.ts";
import { SettingsDraftJson, SettingsFields } from "./SettingsFields.tsx";

const paragraph = (value: string) => value;

/** Local editable fields only; native sealed preview/approval stays separate. */
export function SettingsPanel(props: {
	document: SettingsDocument | null;
	error: string | null;
	draft: string;
	change: (value: string) => void;
	editing: boolean;
	edit: (value: boolean) => void;
	candidate: SettingsCandidate | null;
	connected: boolean;
	fresh: boolean;
	prepare: (command: string) => void;
}) {
	const [json, setJson] = createSignal(false),
		[observed, setObserved] = createSignal(false);
	let disposed = false,
		generation = 0;
	onCleanup(() => {
		disposed = true;
	});
	// The document identity is part of every scope below: a reload, reconnect or
	// conversation change retires the open editor instead of rebinding it.
	const documentSource = createMemo(() => ({
		document: props.document,
		generation: ++generation,
	}));
	const controls = createMemo(() => [
		documentSource(),
		props.draft,
		props.candidate,
		props.connected,
		props.fresh,
		props.error,
		json(),
		observed(),
	]);
	const ready = () =>
		!disposed && props.connected && props.fresh && !props.error;
	const edit = (value: boolean) => {
		if (!disposed && props.connected) props.edit(value);
	};
	const prepare = (command: string) => {
		if (ready()) {
			props.edit(false);
			props.prepare(command);
		}
	};
	const dirty = createMemo(() => {
		const settings = props.document?.settings;
		if (!settings) return false;
		return props.draft !== JSON.stringify(settings, null, 2);
	});
	return (
		<box flexDirection="column" gap={1}>
			<text fg={color("primary")}>Settings</text>
			<text fg={color("textMuted")}>
				{dirty()
					? "Unsaved changes · they apply after a restart"
					: "Saved · changes apply after a restart"}
			</text>
			<Show when={props.error}>
				<text fg={color("warning")}>
					{paragraph("Reading settings failed")}
				</text>
			</Show>
			<Show when={!props.connected || !props.fresh}>
				<text fg={color("warning")}>Disconnected · showing the last read</text>
			</Show>
			<Show when={props.document}>
				<SettingsFields
					draft={props.draft}
					change={props.change}
					editing={props.editing}
					edit={props.edit}
					connected={props.connected}
				/>
				<Show when={ready()}>
					<box flexDirection="row" gap={2}>
						<ActionHeader
							scope={controls()}
							interactive={ready()}
							onActivate={() => prepare("/settings-preview")}
						>
							<text fg={color("accent")}>Save changes</text>
						</ActionHeader>
						<ActionHeader
							scope={controls()}
							interactive={ready()}
							onActivate={() => prepare("/settings-reset")}
						>
							<text fg={color("textMuted")}>Discard edits</text>
						</ActionHeader>
					</box>
				</Show>
				<ActionHeader
					scope={controls()}
					interactive={props.connected && !disposed}
					onActivate={() => {
						if (!disposed && props.connected) {
							props.edit(false);
							setJson(!json());
						}
					}}
				>
					<text fg={color("accent")}>{json() ? "▾" : "▸"} Advanced</text>
				</ActionHeader>
				<Show when={json()}>
					<ActionHeader
						scope={controls()}
						interactive={props.connected && !disposed}
						onActivate={() => edit(!props.editing)}
					>
						<text fg={color("accent")}>
							{props.editing ? "Leave JSON editor" : "Edit JSON"}
						</text>
					</ActionHeader>
					<LocalJsonEditor
						maxLength={128000}
						value={props.draft}
						scope={`settings:${documentSource().generation}:${props.document?.revision ?? "absent"}`}
						editing={props.editing}
						interactive={props.connected && !disposed}
						enter={() => edit(true)}
						change={props.change}
					/>
					<SettingsDraftJson draft={props.draft} scope={documentSource()} />
					<ActionHeader
						scope={controls()}
						onActivate={() => {
							if (!disposed) setObserved(!observed());
						}}
					>
						<text fg={color("accent")}>
							{observed() ? "▾" : "▸"} Settings on disk
						</text>
					</ActionHeader>
					<Show when={observed()}>
						<SuppliedObservation
							value={props.document?.settings}
							scope={documentSource()}
							label="Settings as read"
						/>
					</Show>
				</Show>
			</Show>
			<PreparedCandidate
				candidate={props.candidate}
				scope={controls()}
				ready={
					ready() && props.document?.revision === props.candidate?.baseRevision
				}
				label="Settings candidate"
				metadata={
					props.candidate
						? {
								baseRevision: props.candidate.baseRevision,
								restartRequired: props.candidate.restartRequired,
							}
						: undefined
				}
				prepare={(id) =>
					prepare(`/settings-apply ${id} approve:TYPE_THE_SNAPSHOT_DIGEST`)
				}
			/>
		</box>
	);
}
