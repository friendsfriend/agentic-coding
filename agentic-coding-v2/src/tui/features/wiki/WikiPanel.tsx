/** @jsxImportSource @opentui/solid */
import { SyntaxStyle } from "@opentui/core";
import { useRenderer } from "@opentui/solid";
import { createMemo, onCleanup, Show } from "solid-js";
import type { Data } from "../../../protocol/index.ts";
import { ActionHeader } from "../../ui/ActionHeader.tsx";
import { LocalJsonEditor } from "../../ui/LocalJsonEditor.tsx";
import { SuppliedObservation } from "../../ui/SuppliedObservation.tsx";
import { SuppliedRecordWindow } from "../../ui/SuppliedRecordWindow.tsx";
import { color } from "../../ui/theme/index.ts";
import { SuppliedCode } from "../sessions/SuppliedCode.tsx";
export function WikiPanel(props: {
	rows: Data[];
	catalog: Data[];
	tasks: Data[];
	selectedId: string | null;
	document: { page: Data; comments: Data[] } | null;
	candidate: {
		id: string;
		snapshot: string;
		digest: string;
		expiresAt: number;
	} | null;
	error: string | null;
	connected: boolean;
	fresh: boolean;
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
	let disposed = false,
		generation = 0;
	onCleanup(() => {
		disposed = true;
		syntax.destroy();
	});
	const token = (id: unknown): id is string =>
		typeof id === "string" &&
		id.length > 0 &&
		id.length <= 128 &&
		!/\s/.test(id) &&
		Array.from(id).every(
			(char) => char.charCodeAt(0) >= 32 && char.charCodeAt(0) !== 127,
		);
	const pageMember = (id: unknown) =>
		!disposed &&
		token(id) &&
		props.catalog.filter((row) => row.id === id).length === 1;
	const source = createMemo(() => ({
		rows: props.rows,
		catalog: props.catalog,
		tasks: props.tasks,
		selected: props.selectedId,
		document: props.document,
		connected: props.connected,
		fresh: props.fresh,
		error: props.error,
		generation: ++generation,
	}));
	const controls = createMemo(() => [
		source(),
		props.mode,
		props.pageDraft,
		props.commentDraft,
		props.candidate,
	]);
	const ready = () =>
		!disposed && props.connected && props.fresh && !props.error;
	const document = createMemo(() =>
		props.document?.page.id === props.selectedId &&
		pageMember(props.document.page.id)
			? props.document
			: null,
	);
	// Retire the old input owner after supplied document replacement, even if
	// id/revision/bytes repeat. Text mirroring itself never edits/seals a draft.
	let editorGeneration = 0;
	const editorOwner = createMemo(
		() => ({
			document: props.document,
			selected: props.selectedId,
			mode: props.mode,
			generation: ++editorGeneration,
		}),
		undefined,
		{
			equals: (previous, next) =>
				previous?.document === next.document &&
				previous?.selected === next.selected &&
				previous?.mode === next.mode,
		},
	);
	const editorScope = () =>
		JSON.stringify([
			"wiki-editor",
			editorOwner().generation,
			props.mode,
			props.selectedId,
		]);
	const prepare = (command: string) => {
		if (ready()) {
			props.leave();
			props.prepare(command);
		}
	};
	return (
		<box flexDirection="column" gap={1}>
			<text fg={color("primary")}>Wiki · {props.rows.length} pages</text>
			<text wrapMode="word" fg={color("textMuted")}>
				Comments are proposals: submitting one admits a read-only review task
			</text>
			<Show when={props.error}>
				<text fg={color("warning")}>{props.error}</text>
			</Show>
			<Show when={!props.connected || !props.fresh}>
				<text fg={color("warning")}>Disconnected · showing the last read</text>
			</Show>
			<SuppliedRecordWindow
				rows={props.rows}
				scope={source()}
				label="wiki page descriptors"
				title={(row) =>
					`${String(row.title)} · ${String(row.id)}@${String(row.revision)}`
				}
				search={(row) => JSON.stringify(row)}
				selected={(row) => row.id === props.selectedId}
			>
				{(row) => (
					<ActionHeader
						scope={controls()}
						interactive={
							pageMember(row.id) && props.rows.some((entry) => entry === row)
						}
						onActivate={() => {
							if (
								pageMember(row.id) &&
								props.rows.some((entry) => entry === row) &&
								token(row.id)
							)
								props.select(row.id);
						}}
					>
						<text fg={color("accent")}>
							{props.selectedId === row.id ? "▾" : "▸"} {String(row.title)} ·{" "}
							{String(row.id)}@{String(row.revision)}
						</text>
					</ActionHeader>
				)}
			</SuppliedRecordWindow>
			<Show when={props.document && !document()}>
				<text fg={color("warning")}>
					Cached document does not match a unique selected supplied page; source
					navigation withheld. Existing editor text is not replaced.
				</text>
			</Show>
			<Show when={document()} keyed>
				{(saved) => {
					const current = () => !disposed && document() === saved;
					const taskMember = (comment: Data) =>
						current() &&
						saved.comments.some((entry) => entry === comment) &&
						comment.pageId === saved.page.id &&
						Number.isSafeInteger(comment.taskId) &&
						Number(comment.taskId) > 0 &&
						props.tasks.filter((task) => task.id === comment.taskId).length ===
							1;
					return (
						<box flexDirection="column" gap={1}>
							<text wrapMode="word">
								Loaded page {String(saved.page.id)} revision{" "}
								{String(saved.page.revision)} · native content digest{" "}
								{String(saved.page.digest)}
							</text>
							<Show
								when={props.catalog.some(
									(row) =>
										row.id === saved.page.id &&
										row.revision !== saved.page.revision,
								)}
							>
								<text fg={color("warning")}>
									Loaded revision differs from supplied inventory; observations
									are non-atomic. Explicitly refresh before proposing changes.
								</text>
							</Show>
							<Show
								when={typeof saved.page.content === "string"}
								fallback={
									<text fg={color("warning")}>
										Page content was not supplied (distinct from an empty page).
									</text>
								}
							>
								<SuppliedCode
									content={String(saved.page.content)}
									identity={JSON.stringify([
										saved.page.id,
										saved.page.revision,
										saved.page.digest,
									])}
									filetype="markdown"
									syntax={syntax}
								/>
							</Show>
							<SuppliedRecordWindow
								rows={saved.comments}
								scope={source()}
								label="wiki comment observations"
								title={(comment) =>
									`${String(comment.id)} · revision ${String(comment.pageRevision)} · ${String(comment.comment)}`
								}
								search={(comment) => JSON.stringify(comment)}
							>
								{(comment, index) => (
									<box flexDirection="column" gap={1}>
										<text wrapMode="word">
											{index() + 1}. Comment {String(comment.id)} on page{" "}
											{String(comment.pageId)} revision{" "}
											{String(comment.pageRevision)}
										</text>
										<SuppliedObservation
											value={comment.comment}
											scope={source()}
											label="Exact supplied comment text"
										/>
										<Show when={taskMember(comment)}>
											<ActionHeader
												scope={controls()}
												interactive={taskMember(comment)}
												onActivate={() => {
													if (taskMember(comment))
														props.openTask(Number(comment.taskId));
												}}
											>
												<text fg={color("accent")}>
													Open unique supplied comment task #
													{String(comment.taskId)} (admission is not completion)
												</text>
											</ActionHeader>
										</Show>
										<Show
											when={comment.taskId !== null && !taskMember(comment)}
										>
											<text fg={color("warning")}>
												Comment task/owner pointer is missing, ambiguous or
												outside the supplied native catalog; no arbitrary
												adoption.
											</text>
										</Show>
										<Show when={comment.taskId === null}>
											<text fg={color("warning")}>
												Admission pending/uncertain. Explicit retry needs
												identical request identity/content; no automatic retry.
											</text>
										</Show>
										<SuppliedObservation
											value={comment}
											scope={source()}
											label="Complete supplied comment observation"
										/>
									</box>
								)}
							</SuppliedRecordWindow>
						</box>
					);
				}}
			</Show>
			<text fg={color("primary")}>
				{props.mode === "page" ? "Page draft" : "Comment draft"}
			</text>
			<text wrapMode="word" fg={color("textMuted")}>
				{props.mode === "page"
					? "id · title · content · baseRevision (0 for a new page)"
					: "pageId · pageRevision · comment · profile · repository · baseRef · requestId"}
			</text>
			<ActionHeader
				scope={controls()}
				interactive={ready()}
				onActivate={() => {
					if (ready()) props.edit("page");
				}}
			>
				<text fg={color("accent")}>Edit page</text>
			</ActionHeader>
			<ActionHeader
				scope={controls()}
				interactive={ready()}
				onActivate={() => {
					if (ready()) props.edit("comment");
				}}
			>
				<text fg={color("accent")}>Edit comment</text>
			</ActionHeader>
			<Show when={props.editing}>
				<LocalJsonEditor
					value={props.mode === "page" ? props.pageDraft : props.commentDraft}
					scope={editorScope()}
					editing={props.editing}
					interactive={ready()}
					enter={() => {
						if (ready()) props.edit(props.mode);
					}}
					change={(value) => {
						if (ready()) {
							if (props.mode === "page") props.changePage(value);
							else props.changeComment(value);
						}
					}}
				/>
			</Show>
			<Show when={ready()}>
				<ActionHeader
					scope={controls()}
					interactive={ready()}
					onActivate={() => prepare("/wiki-new")}
				>
					<text fg={color("accent")}>New page</text>
				</ActionHeader>
				<Show when={document()}>
					<ActionHeader
						scope={controls()}
						interactive={ready() && document() !== null}
						onActivate={() => {
							if (document()) prepare("/wiki-reset");
						}}
					>
						<text fg={color("textMuted")}>Reload this page</text>
					</ActionHeader>
				</Show>
				<ActionHeader
					scope={controls()}
					interactive={ready()}
					onActivate={() => prepare("/wiki-preview")}
				>
					<text fg={color("accent")}>Preview page</text>
				</ActionHeader>
				<ActionHeader
					scope={controls()}
					interactive={ready()}
					onActivate={() => prepare("/wiki-comment")}
				>
					<text fg={color("warning")}>Submit comment for review</text>
				</ActionHeader>
			</Show>
			<Show when={props.candidate} keyed>
				{(saved) => {
					const valid = () =>
						ready() &&
						props.candidate === saved &&
						token(saved.id) &&
						/^[a-f0-9]{64}$/.test(saved.digest) &&
						Number.isSafeInteger(saved.expiresAt) &&
						saved.expiresAt > Date.now();
					return (
						<box flexDirection="column" gap={1}>
							<text wrapMode="word">
								Candidate {saved.id} · expires {saved.expiresAt} (epoch ms) ·
								native exact snapshot digest {saved.digest}
							</text>
							<SuppliedCode
								content={saved.snapshot}
								identity={saved.id}
								filetype="json"
								syntax={syntax}
							/>
							<text fg={color("warning")}>
								Inspect exact snapshot and manually type approve:DIGEST.
								Preparation gives a placeholder, never approval.
								Editing/navigation/refresh/disconnect invalidate confirmation.
								Native expiry/owner/revision/approval checks remain final.
							</text>
							<Show when={valid()}>
								<ActionHeader
									scope={controls()}
									interactive={valid()}
									onActivate={() => {
										if (valid())
											prepare(
												`/wiki-apply ${saved.id} approve:TYPE_THE_SNAPSHOT_DIGEST`,
											);
									}}
								>
									<text fg={color("accent")}>
										Prepare save with manual confirmation placeholder
									</text>
								</ActionHeader>
							</Show>
						</box>
					);
				}}
			</Show>
		</box>
	);
}
