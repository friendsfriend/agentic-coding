/** @jsxImportSource @opentui/solid */
import { SyntaxStyle, type TextareaRenderable } from "@opentui/core";
import { useRenderer } from "@opentui/solid";
import { createEffect, For, onCleanup, Show } from "solid-js";
import type {
	ProviderActionCandidate,
	ProviderActionReceipt,
} from "../../../protocol/provider-actions.ts";
import { ActionHeader } from "../../ui/ActionHeader.tsx";
import { editorKeybinds, textareaBindings } from "../../ui/keybinds.ts";
import { color } from "../../ui/theme/index.ts";
/** Mutable local intention editor; immutable approval candidate; read-only native attempt journal. */
export function ProviderWritePanel(props: {
	draft: string;
	change: (draft: string) => void;
	editing: boolean;
	edit: (value: boolean) => void;
	connected: boolean;
	error: string | null;
	candidate: ProviderActionCandidate | null;
	attempts: ProviderActionReceipt[];
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
				Native provider write intentions · no outbound request on edit/preview
			</text>
			<text wrapMode="word" fg={color("warning")}>
				Exactly one explicit approval of an immutable
				provider/destination/operation/payload snapshot permits one dispatch
				attempt. A retained uncertain attempt is never automatically retried on
				apply, startup, reconnect or journal read. Acknowledgement is not proof
				the remote operation finished; inspect remotely. GitHub CI numbers here
				are RUN IDs, not job IDs.
			</text>
			<text wrapMode="word" fg={color("textMuted")}>
				Supported operations: comment-change, approve-exact-change (full
				reviewed 40-hex SHA; server preflight plus host commit binding),
				unapprove-change, comment-issue, close-issue, retry-job, cancel-job,
				rebase-change (GitLab), reply-discussion, resolve-discussion (GitLab),
				set-issue-labels, set-issue-assignees. No arbitrary route, merge or
				unsigned approval. Rebase/issue/job mutations are exact target
				intentions, not remote revision CAS.
			</text>
			<Show when={props.error}>
				<text fg={color("warning")}>{props.error}</text>
			</Show>
			<ActionHeader onActivate={() => props.edit(!props.editing)}>
				<text fg={color("accent")}>
					{props.editing
						? "Leave intention editor"
						: "Edit local provider intention"}
				</text>
			</ActionHeader>
			<textarea
				ref={(value) => {
					editor = value;
				}}
				initialValue={props.draft}
				focused={props.editing}
				height={10}
				width="100%"
				keyBindings={textareaBindings(editorKeybinds)}
				onMouseDown={() => props.edit(true)}
				onContentChange={(value) =>
					props.change(
						typeof value === "string" ? value : (editor?.plainText ?? ""),
					)
				}
			/>
			<Show when={props.connected}>
				<ActionHeader
					onActivate={() => {
						props.edit(false);
						props.prepare("/provider-preview");
					}}
				>
					<text fg={color("accent")}>
						Prepare sealed preview (submit explicitly; no outbound request)
					</text>
				</ActionHeader>
				<ActionHeader
					onActivate={() => {
						props.edit(false);
						props.prepare("/provider-new OPERATION");
					}}
				>
					<text fg={color("accent")}>
						Prepare new blank intention/request identity (explicit submission
						discards editor draft)
					</text>
				</ActionHeader>
				<ActionHeader
					onActivate={() => {
						props.edit(false);
						props.prepare("/provider-attempts");
					}}
				>
					<text fg={color("accent")}>
						Prepare refreshing native attempt journal (no remote calls)
					</text>
				</ActionHeader>
			</Show>
			<Show when={props.candidate}>
				<text fg={color("primary")}>
					Immutable candidate {props.candidate?.id} · expires{" "}
					{props.candidate?.expiresAt} (epoch ms)
				</text>
				<code
					content={props.candidate?.snapshot ?? ""}
					filetype="json"
					syntaxStyle={syntax}
					drawUnstyledText={true}
					wrapMode="word"
				/>
				<text wrapMode="word">Snapshot digest: {props.candidate?.digest}</text>
				<text fg={color("warning")}>
					Candidate/editor bytes are ephemeral and never saved in viewpoints.
					Review the snapshot, then manually type approve:DIGEST. Any
					edit/navigation/refresh/disconnect invalidates client confirmation.
				</text>
				<ActionHeader
					onActivate={() => {
						props.edit(false);
						props.prepare(
							`/provider-apply ${props.candidate?.id} approve:TYPE_THE_SNAPSHOT_DIGEST`,
						);
					}}
				>
					<text fg={color("accent")}>
						Prepare confirmation placeholder only
					</text>
				</ActionHeader>
			</Show>
			<For each={props.attempts}>
				{(attempt) => (
					<box flexDirection="column" gap={1}>
						<text
							fg={
								attempt.status === "uncertain"
									? color("warning")
									: color("textMuted")
							}
							wrapMode="word"
						>
							{attempt.id} · {attempt.operation} · {attempt.target} ·{" "}
							{attempt.status} · {attempt.updatedAt} (epoch ms)
						</text>
						<ActionHeader
							onActivate={() => {
								props.edit(false);
								props.prepare(`/provider-receipt ${attempt.id}`);
							}}
						>
							<text fg={color("accent")}>
								Prepare reading full native receipt (no remote call)
							</text>
						</ActionHeader>
						<text wrapMode="word">
							Exact intention digest {attempt.digest}.{" "}
							{attempt.status === "uncertain"
								? "Outcome unknown, including preflight/rejection/crash; inspect the remote state before considering a new separately approved request ID."
								: "Native provider receipt retained; no automatic follow-up/retry."}
						</text>
						<text wrapMode="word">
							Recorded destination/credential-reference metadata (not proof of
							current account or configuration): {attempt.destination}
						</text>
						<Show when={attempt.result}>
							<code
								content={JSON.stringify(attempt.result, null, 2)}
								filetype="json"
								syntaxStyle={syntax}
								drawUnstyledText={true}
								wrapMode="word"
							/>
						</Show>
					</box>
				)}
			</For>
		</box>
	);
}
