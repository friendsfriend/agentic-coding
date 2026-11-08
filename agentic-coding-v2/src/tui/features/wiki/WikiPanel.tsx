/** @jsxImportSource @opentui/solid */
import { SyntaxStyle } from "@opentui/core";
import { useRenderer } from "@opentui/solid";
import { For, onCleanup, Show } from "solid-js";
import type { Data } from "../../../protocol/index.ts";
import { ActionHeader } from "../../ui/ActionHeader.tsx";
import { LocalJsonEditor } from "../../ui/LocalJsonEditor.tsx";
import { color } from "../../ui/theme/index.ts";
import { SuppliedCode } from "../sessions/SuppliedCode.tsx";
export function WikiPanel(props: {
	rows: Data[];
	document: { page: Data; comments: Data[] } | null;
	candidate: {
		id: string;
		snapshot: string;
		digest: string;
		expiresAt: number;
	} | null;
	error: string | null;
	connected: boolean;
	pageDraft: string;
	commentDraft: string;
	changePage: (value: string) => void;
	changeComment: (value: string) => void;
	editing: boolean;
	mode: "page" | "comment";
	edit: (mode: "page" | "comment") => void;
	leave: () => void;
	select: (id: string) => void;
	prepare: (command: string) => void;
	openTask: (id: number) => void;
}) {
	const syntax = SyntaxStyle.fromStyles(
		{ default: { fg: color("text") } },
		useRenderer().nativeScene,
	);
	onCleanup(() => syntax.destroy());
	const draft = () =>
		props.mode === "page" ? props.pageDraft : props.commentDraft;
	return (
		<box flexDirection="column" gap={1}>
			<text fg={color("primary")}>
				Native wiki · private pi-durable document storage
			</text>
			<text wrapMode="word">
				Pages and comments are untrusted documentation, never approval or
				execution authority. No legacy wiki or arbitrary filesystem path is
				imported. Up to 64 pages and 128 comments are retained; no deletion or
				automatic pruning. Save requires an exact fresh snapshot confirmation.
				Comment submission admits a read-only native wiki-comment task using
				explicit profile/repository/Git base; it proposes changes only, never
				applies them.
			</text>
			<Show when={props.error}>
				<text fg={color("warning")}>{props.error}</text>
			</Show>
			<Show when={!props.connected}>
				<text fg={color("warning")}>
					Disconnected; documents are cached, candidates discarded, no mutation
					replay.
				</text>
			</Show>
			<For each={props.rows}>
				{(row) => (
					<ActionHeader onActivate={() => props.select(String(row.id))}>
						<text fg={color("accent")}>
							{props.document?.page.id === row.id ? "▾" : "▸"}{" "}
							{String(row.title)} · {String(row.id)}@{String(row.revision)}
						</text>
					</ActionHeader>
				)}
			</For>
			<Show when={props.document}>
				<text wrapMode="word">
					Loaded page {String(props.document?.page.id)} revision{" "}
					{String(props.document?.page.revision)} · content digest{" "}
					{String(props.document?.page.digest)}
				</text>
				<Show
					when={typeof props.document?.page.content === "string"}
					fallback={
						<text fg={color("warning")}>Page content was not supplied.</text>
					}
				>
					<SuppliedCode
						content={String(props.document?.page.content ?? "")}
						identity={JSON.stringify([
							props.document?.page.id,
							props.document?.page.revision,
							props.document?.page.digest,
						])}
						filetype="markdown"
						syntax={syntax}
					/>
				</Show>
				<For each={props.document?.comments ?? []}>
					{(comment) => (
						<box flexDirection="column">
							<text wrapMode="word">
								Comment {String(comment.id)} on revision{" "}
								{String(comment.pageRevision)}: {String(comment.comment)}
							</text>
							<Show when={typeof comment.taskId === "number"}>
								<ActionHeader
									onActivate={() => props.openTask(Number(comment.taskId))}
								>
									<text fg={color("accent")}>
										Open admitted comment task #{String(comment.taskId)}{" "}
										(admission is not completion)
									</text>
								</ActionHeader>
							</Show>
							<Show when={comment.taskId === null}>
								<text fg={color("warning")}>
									Admission pending/uncertain; explicit retry requires identical
									request identity and content. No automatic retry.
								</text>
							</Show>
						</box>
					)}
				</For>
			</Show>
			<text fg={color("primary")}>
				Ephemeral {props.mode} JSON editor · not saved in viewpoints
			</text>
			<text wrapMode="word">
				Page fields: id/title/content/baseRevision (0 for a new page). Comment
				fields:
				pageId/pageRevision/comment/profile/repository/baseRef/requestId. All
				targets and text must be explicit; do not paste credentials. Editing
				cannot submit. Existing drafts are never replaced by automatic reads.
			</text>
			<ActionHeader onActivate={() => props.edit("page")}>
				<text fg={color("accent")}>Edit page candidate JSON</text>
			</ActionHeader>
			<ActionHeader onActivate={() => props.edit("comment")}>
				<text fg={color("accent")}>Edit read-only comment-task JSON</text>
			</ActionHeader>
			<LocalJsonEditor
				value={draft()}
				scope={`wiki:${props.mode}:${String(props.document?.page.id)}:${String(props.document?.page.revision)}`}
				editing={props.editing}
				interactive={props.connected}
				enter={() => props.edit(props.mode)}
				change={(value) => {
					if (props.mode === "page") props.changePage(value);
					else props.changeComment(value);
				}}
			/>
			<Show when={props.connected && !props.error}>
				<ActionHeader
					onActivate={() => {
						props.leave();
						props.prepare("/wiki-new");
					}}
				>
					<text fg={color("accent")}>
						Prepare resetting page editor for a new page
					</text>
				</ActionHeader>
				<Show when={props.document}>
					<ActionHeader
						onActivate={() => {
							props.leave();
							props.prepare("/wiki-reset");
						}}
					>
						<text fg={color("accent")}>
							Prepare resetting both editors to selected revision (discards
							edits on submission only)
						</text>
					</ActionHeader>
				</Show>
				<ActionHeader
					onActivate={() => {
						props.leave();
						props.prepare("/wiki-preview");
					}}
				>
					<text fg={color("accent")}>
						Prepare immutable page preview (no save)
					</text>
				</ActionHeader>
				<ActionHeader
					onActivate={() => {
						props.leave();
						props.prepare("/wiki-comment");
					}}
				>
					<text fg={color("warning")}>
						Prepare explicit read-only comment task admission (submit only after
						inspecting JSON)
					</text>
				</ActionHeader>
			</Show>
			<Show when={props.candidate}>
				<text wrapMode="word">
					Candidate {props.candidate?.id} · expires {props.candidate?.expiresAt}{" "}
					· exact snapshot digest {props.candidate?.digest}
				</text>
				<SuppliedCode
					content={props.candidate?.snapshot ?? ""}
					identity={props.candidate?.id}
					filetype="json"
					syntax={syntax}
				/>
				<text fg={color("warning")}>
					Inspect the exact snapshot and manually type approve:DIGEST.
					Preparation supplies a placeholder, never approval. Editing,
					navigation, refresh and disconnect invalidate client confirmation.
				</text>
				<Show when={props.connected && !props.error}>
					<ActionHeader
						onActivate={() => {
							props.leave();
							props.prepare(
								`/wiki-apply ${props.candidate?.id} approve:TYPE_THE_SNAPSHOT_DIGEST`,
							);
						}}
					>
						<text fg={color("accent")}>
							Prepare save with manual confirmation placeholder
						</text>
					</ActionHeader>
				</Show>
			</Show>
		</box>
	);
}
