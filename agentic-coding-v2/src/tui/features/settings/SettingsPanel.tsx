/** @jsxImportSource @opentui/solid */
import { SyntaxStyle, type TextareaRenderable } from "@opentui/core";
import { useRenderer } from "@opentui/solid";
import { createEffect, onCleanup, Show } from "solid-js";
import type {
	SettingsCandidate,
	SettingsDocument,
} from "../../../protocol/index.ts";
import { ActionHeader } from "../../ui/ActionHeader.tsx";
import { color } from "../../ui/theme/index.ts";

/** Ephemeral editable JSON and immutable native preview. Never writes through a rendering callback. */
export function SettingsPanel(props: {
	document: SettingsDocument | null;
	error: string | null;
	draft: string;
	change: (value: string) => void;
	editing: boolean;
	edit: (value: boolean) => void;
	candidate: SettingsCandidate | null;
	connected: boolean;
	prepare: (command: string) => void;
}) {
	let editor: TextareaRenderable | undefined;
	const syntax = SyntaxStyle.fromStyles(
		{ default: { fg: color("text") } },
		useRenderer().nativeScene,
	);
	onCleanup(() => syntax.destroy());
	createEffect(() => {
		const draft = props.draft;
		if (editor && editor.plainText !== draft) editor.setText(draft);
	});
	return (
		<box flexDirection="column" gap={1}>
			<text fg={color("primary")}>
				Writable native settings · CONFIG_DIR/config.json
			</text>
			<text fg={color("warning")}>
				Saves apply on a separately authorized host restart only. Running
				sessions, model selection, repositories, providers and leases are
				unchanged. No restart, probe or credential editing runs here.
			</text>
			<text wrapMode="word">
				Edit profiles, orchestratorProfile, repository allow-list and provider
				definitions. Provider tokenRef accepts an environment-variable name,
				never a token value. Missing fields currently use the running host's
				definitions; saving makes profiles explicit instead of inherited. Other
				existing file fields are preserved but not exposed.
			</text>
			<Show when={props.error}>
				<text fg={color("warning")}>{props.error}</text>
			</Show>
			<Show when={!props.connected}>
				<text fg={color("warning")}>
					Disconnected; cached document is not current disk state. Candidate
					confirmation has been discarded.
				</text>
			</Show>
			<Show when={props.document}>
				<text wrapMode="word">
					Observed file revision: {props.document?.revision} · no file write has
					been made by loading this editor.
				</text>
				<text fg={color("textMuted")}>
					Editor/candidate contents are client-memory only, not saved in
					viewpoints. Enter inserts a newline; Escape returns to the command
					prompt.
				</text>
				<ActionHeader onActivate={() => props.edit(!props.editing)}>
					<text fg={color("accent")}>
						{props.editing ? "Leave JSON editor" : "Edit JSON settings"}
					</text>
				</ActionHeader>
				<textarea
					ref={(value) => {
						editor = value;
					}}
					initialValue={props.draft}
					focused={props.editing && props.connected}
					height={12}
					width="100%"
					keyBindings={[{ name: "return", action: "newline" }]}
					onMouseDown={() => props.edit(true)}
					onContentChange={(value) =>
						props.change(
							typeof value === "string" ? value : (editor?.plainText ?? ""),
						)
					}
				/>
				<Show when={props.connected && !props.error}>
					<ActionHeader
						onActivate={() => {
							props.edit(false);
							props.prepare("/settings-preview");
						}}
					>
						<text fg={color("accent")}>
							Prepare preview of edited JSON (submit explicitly; no file write)
						</text>
					</ActionHeader>
					<ActionHeader
						onActivate={() => {
							props.edit(false);
							props.prepare("/settings-reset");
						}}
					>
						<text fg={color("accent")}>
							Prepare reloading the observed document into this editor (discards
							edits only on submission)
						</text>
					</ActionHeader>
				</Show>
			</Show>
			<Show when={props.candidate}>
				<text fg={color("primary")}>
					Immutable candidate {props.candidate?.id}
				</text>
				<text wrapMode="word">
					Base {props.candidate?.baseRevision} · expires{" "}
					{props.candidate?.expiresAt} (epoch ms)
				</text>
				<code
					content={props.candidate?.snapshot ?? ""}
					filetype="json"
					syntaxStyle={syntax}
					drawUnstyledText={true}
					wrapMode="word"
				/>
				<text wrapMode="word">
					Exact snapshot digest: {props.candidate?.digest}
				</text>
				<text fg={color("warning")}>
					Inspect the immutable snapshot, then manually type approve:DIGEST in
					the prompt. Preparation inserts a placeholder, not approval. Editing,
					navigation or disconnect discards client confirmation;
					stale/expired/unknown candidates refuse natively.
				</text>
				<Show when={props.connected && !props.error}>
					<ActionHeader
						onActivate={() => {
							props.edit(false);
							props.prepare(
								`/settings-apply ${props.candidate?.id} approve:TYPE_THE_SNAPSHOT_DIGEST`,
							);
						}}
					>
						<text fg={color("accent")}>
							Prepare apply command with confirmation placeholder only
						</text>
					</ActionHeader>
				</Show>
			</Show>
		</box>
	);
}
