/** @jsxImportSource @opentui/solid */
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
import { SettingsFields } from "./SettingsFields.tsx";
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
	const [structured, setStructured] = createSignal(false),
		[observed, setObserved] = createSignal(false);
	let disposed = false,
		generation = 0;
	onCleanup(() => {
		disposed = true;
	});
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
		structured(),
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
	return (
		<box flexDirection="column" gap={1}>
			<text fg={color("primary")}>
				Writable native settings · CONFIG_DIR/config.json
			</text>
			<text fg={color("warning")}>
				Saves apply only on a separately authorized host restart. Running
				sessions/models/repositories/providers/leases remain unchanged. No
				restart, probe or credential editing.
			</text>
			<text wrapMode="word">
				Edit profiles, orchestratorProfile, repository allow-list and provider
				definitions. tokenRef is an environment-variable NAME, never a
				credential. Missing fields use running definitions; saving makes
				profiles explicit. Unexposed existing file fields remain preserved.
				Local edits never validate, submit or grant approval.
			</text>
			<Show when={props.error}>
				<text fg={color("warning")}>{props.error}</text>
			</Show>
			<Show when={!props.connected || !props.fresh}>
				<text fg={color("warning")}>
					Cached/disconnected observation, not current disk state. Native
					preparation withheld; no mutation replay.
				</text>
			</Show>
			<Show when={props.document}>
				<text wrapMode="word">
					Observed revision {props.document?.revision}; loading made no file
					write. Draft/candidate text is client-memory only, not saved in
					viewpoints.
				</text>
				<ActionHeader
					scope={controls()}
					onActivate={() => {
						if (!disposed) setObserved(!observed());
					}}
				>
					<text fg={color("accent")}>
						{observed() ? "▾" : "▸"} Inspect supplied observed settings
						separately from edited draft
					</text>
				</ActionHeader>
				<Show when={observed()}>
					<SuppliedObservation
						value={props.document?.settings}
						scope={documentSource()}
						label="Observed editable settings fields; not original file bytes or current authority"
					/>
				</Show>
				<ActionHeader
					scope={controls()}
					interactive={props.connected && !disposed}
					onActivate={() => {
						if (!disposed && props.connected) {
							props.edit(false);
							setStructured(!structured());
						}
					}}
				>
					<text fg={color("accent")}>
						{structured()
							? "Switch to advanced JSON editor"
							: "Switch to field-specific draft editor"}
					</text>
				</ActionHeader>
				<Show when={structured() && documentSource()} keyed>
					{(_owner) => (
						<SettingsFields
							draft={props.draft}
							change={props.change}
							editing={props.editing}
							edit={props.edit}
							connected={props.connected}
						/>
					)}
				</Show>
				<Show when={!structured()}>
					<ActionHeader
						scope={controls()}
						interactive={props.connected && !disposed}
						onActivate={() => edit(!props.editing)}
					>
						<text fg={color("accent")}>
							{props.editing ? "Leave JSON editor" : "Edit JSON settings"}
						</text>
					</ActionHeader>
					<text fg={color("textMuted")}>
						Local JSON limit: 128000 UTF-16 units; oversize input restores the
						prior exact draft. Native validation remains final.
					</text>
					<LocalJsonEditor
						maxLength={128000}
						value={props.draft}
						scope={`settings:${documentSource().generation}:${props.document?.revision ?? "absent"}`}
						editing={props.editing}
						interactive={props.connected && !disposed}
						enter={() => edit(true)}
						change={props.change}
					/>
				</Show>
				<Show when={ready()}>
					<ActionHeader
						scope={controls()}
						interactive={ready()}
						onActivate={() => prepare("/settings-preview")}
					>
						<text fg={color("accent")}>
							Prepare preview of edited JSON (submit explicitly; no write)
						</text>
					</ActionHeader>
					<ActionHeader
						scope={controls()}
						interactive={ready()}
						onActivate={() => prepare("/settings-reset")}
					>
						<text fg={color("accent")}>
							Prepare reloading observed document (discards edits only on
							submission)
						</text>
					</ActionHeader>
				</Show>
			</Show>
			<PreparedCandidate
				candidate={props.candidate}
				scope={controls()}
				ready={
					ready() && props.document?.revision === props.candidate?.baseRevision
				}
				label="Settings candidate (restart-required; not live configuration)"
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
