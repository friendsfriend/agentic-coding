/** @jsxImportSource @opentui/solid */
import { SyntaxStyle, type TextareaRenderable } from "@opentui/core";
import { useRenderer } from "@opentui/solid";
import { createEffect, For, onCleanup, Show } from "solid-js";
import type { Data } from "../../../protocol/index.ts";
import { ActionHeader } from "../../ui/ActionHeader.tsx";
import { color } from "../../ui/theme/index.ts";
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
	let editor: TextareaRenderable | undefined;
	const syntax = SyntaxStyle.fromStyles(
		{ default: { fg: color("text") } },
		useRenderer().nativeScene,
	);
	onCleanup(() => syntax.destroy());
	const draft = () =>
		props.mode === "page" ? props.pageDraft : props.commentDraft;
	createEffect(() => {
		const value = draft();
		if (editor && editor.plainText !== value) editor.setText(value);
	});
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
				<code
					content={String(props.document?.page.content ?? "")}
					filetype="markdown"
					syntaxStyle={syntax}
					drawUnstyledText={true}
					wrapMode="word"
				/>
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
				targets and text must be explicit; do not paste credentials. Enter
				inserts a newline, Escape leaves the editor. Existing drafts are never
				replaced by automatic reads.
			</text>
			<ActionHeader onActivate={() => props.edit("page")}>
				<text fg={color("accent")}>Edit page candidate JSON</text>
			</ActionHeader>
			<ActionHeader onActivate={() => props.edit("comment")}>
				<text fg={color("accent")}>Edit read-only comment-task JSON</text>
			</ActionHeader>
			<textarea
				ref={(value) => {
					editor = value;
				}}
				initialValue={draft()}
				height={12}
				width="100%"
				focused={props.editing && props.connected}
				keyBindings={[{ name: "return", action: "newline" }]}
				onContentChange={(value) => {
					const text =
						typeof value === "string" ? value : (editor?.plainText ?? "");
					if (props.mode === "page") props.changePage(text);
					else props.changeComment(text);
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
				<code
					content={props.candidate?.snapshot ?? ""}
					filetype="json"
					syntaxStyle={syntax}
					drawUnstyledText={true}
					wrapMode="word"
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
