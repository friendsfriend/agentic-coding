/** @jsxImportSource @opentui/solid */
import type { ScrollBoxRenderable, TextareaRenderable } from "@opentui/core";
import { useKeymap } from "@opentui/keymap/solid";
import {
	createEffect,
	createResource,
	createSignal,
	For,
	onCleanup,
	Show,
	useContext,
} from "solid-js";
import type { ReviewComment } from "../../../review-feedback.ts";
import type { Review } from "../../../state.ts";
import { MarkdownViewer } from "../../presentation/components/MarkdownViewer.tsx";
import { ActionHeader } from "../../ui/ActionHeader.tsx";
import { GenericModal } from "../../ui/components/GenericModal.tsx";
import { keyLabel, textareaBindings } from "../../ui/keybinds.ts";
import { color } from "../../ui/theme/index.ts";
import { HumanContext } from "./human-context.ts";
import { createHumanDraft } from "./human-draft.ts";
import {
	humanEditorKeybinds,
	humanHelpKeybinds,
	questionEditorKeybinds,
	questionKeybinds,
	reviewDiffKeybinds,
} from "./human-keybinds.ts";
import { InlineReview } from "./InlineReview.tsx";
import { Questionnaire } from "./Questionnaire.tsx";

type Editor = {
	kind: "general" | "custom" | "notes" | "global" | "comment";
	index?: number;
	comment?: ReviewComment & { id?: string };
};
export function HumanInteractionCard(props: { request: Review }) {
	const ctx = useContext(HumanContext);
	if (!ctx) return null;
	const [revealed, setRevealed] = createSignal(
		props.request.state === "pending",
	);
	let cached: Review | null = null;
	const [loadError, setLoadError] = createSignal<string | null>(null);
	const [request, { refetch }] = createResource(
		() =>
			revealed()
				? `${props.request.id}:${props.request.revision}:${ctx.fresh()}`
				: false,
		async () => {
			try {
				const value = await ctx.client.call("human.read", {
					id: props.request.id,
				});
				setLoadError(null);
				cached = value;
				return value;
			} catch (error) {
				setLoadError(String(error));
				return cached?.id === props.request.id ? cached : null;
			}
		},
	);
	return (
		<Show
			when={revealed()}
			fallback={
				<ActionHeader onActivate={() => setRevealed(true)}>
					<text fg={color("textMuted")}>
						▸ Human receipt · {props.request.state} · {props.request.title}
					</text>
				</ActionHeader>
			}
		>
			<Show
				when={request.latest}
				fallback={
					<box flexDirection="column">
						<text fg={color("warning")}>
							Awaiting you · {props.request.title} · immutable request{" "}
							{loadError() ? "unavailable" : "loading"}
						</text>
						<Show when={loadError()}>
							<text wrapMode="word" fg={color("error")}>
								{loadError()}
							</text>
							<ActionHeader
								onActivate={() => {
									void refetch();
								}}
							>
								<text fg={color("accent")}>Retry immutable request read</text>
							</ActionHeader>
						</Show>
					</box>
				}
			>
				{(value) => (
					<HumanInteractionBody
						readProblem={loadError()}
						retry={() => void refetch()}
						request={{
							...value(),
							state: props.request.state,
							revision: props.request.revision,
							digest: props.request.digest,
						}}
					/>
				)}
			</Show>
		</Show>
	);
}
function HumanInteractionBody(props: {
	request: Review;
	readProblem: string | null;
	retry: () => void;
}) {
	const ctx = useContext(HumanContext);
	if (!ctx) return null;
	// Never retarget drafts/modal anchors if a replacement observation changes
	// the request revision or digest. The stale draft remains inspectable.
	const captured = { ...props.request };
	const [acknowledged, setAcknowledged] = createSignal<Review | null>(null);
	let disposed = false;
	const acknowledge = (receipt: Review) => {
		if (!disposed) setAcknowledged(receipt);
	};
	const observed = () => acknowledged() ?? props.request;
	const outcomeTone = () =>
		observed().state === "approved" || observed().state === "answered"
			? color("success")
			: observed().state === "rejected"
				? color("error")
				: observed().state === "cancelled"
					? color("textMuted")
					: color("warning");
	const [inspectDraft, setInspectDraft] = createSignal(false);
	const draft = createHumanDraft(ctx.client, captured);
	const [open, setOpen] = createSignal(true);
	const [busy, setBusy] = createSignal(false),
		[error, setError] = createSignal<string | null>(null);
	const [editor, setEditor] = createSignal<Editor | null>(null),
		[diff, setDiff] = createSignal(false),
		[help, setHelp] = createSignal(false);
	const [text, setText] = createSignal("");
	const active = () => ctx.active() === captured.id;
	const editable = () =>
		ctx.fresh() &&
		!props.readProblem &&
		observed().state === "pending" &&
		observed().revision === captured.revision &&
		observed().digest === captured.digest &&
		draft.ready() &&
		!busy();
	const editorCatalog = () =>
		captured.kind === "question"
			? questionEditorKeybinds.filter(
					(b) => b.cmd !== "human.clearText" || editor()?.kind === "custom",
				)
			: humanEditorKeybinds;
	const interactionCatalog = () =>
		editor()
			? editorCatalog()
			: diff()
				? reviewDiffKeybinds
				: captured.kind === "question"
					? questionKeybinds
					: [];
	const catalog = () => (help() ? humanHelpKeybinds : interactionCatalog());
	createEffect(() => {
		if (active()) ctx.catalog(catalog());
	});
	onCleanup(() => {
		disposed = true;
		if (active()) {
			ctx.focus(null);
			ctx.catalog([]);
		}
	});
	let unregisterAnchor: (() => void) | undefined;
	onCleanup(() => unregisterAnchor?.());
	const focus = () => {
		ctx.focus(captured.id);
		setOpen(true);
	};
	const postpone = () => {
		setEditor(null);
		setDiff(false);
		setOpen(false);
		ctx.focus(null);
		ctx.catalog([]);
	};
	const edit = (next: Editor) => {
		if (!editable()) return;
		focus();
		const answer =
			next.index === undefined ? undefined : draft.value().answers[next.index];
		setText(
			next.kind === "general"
				? draft.value().general
				: next.kind === "global"
					? draft.value().globalNote
					: next.kind === "custom"
						? (answer?.text ?? "")
						: next.kind === "notes"
							? (answer?.notes ?? "")
							: (next.comment?.body ?? ""),
		);
		setEditor(next);
	};
	const persistText = (body: string) => {
		setText(body);
		const target = editor();
		if (!target) return;
		if (target.kind === "comment") {
			const id = target.comment?.id ?? crypto.randomUUID();
			const comment = { ...target.comment, body, id };
			setEditor({ ...target, comment });
			draft.change((d) => ({
				...d,
				comments: d.comments.some((c) => c.id === id)
					? d.comments.map((c) => (c.id === id ? comment : c))
					: [...d.comments, comment],
			}));
		} else
			draft.change((d) =>
				target.kind === "general"
					? { ...d, general: body }
					: target.kind === "global"
						? { ...d, globalNote: body }
						: {
								...d,
								answers: d.answers.map((a, i) =>
									i !== target.index
										? a
										: target.kind === "notes"
											? { ...a, notes: body }
											: { ...a, text: body },
								),
							},
			);
	};
	const comments = () =>
		[
			...draft.value().comments,
			...(draft.value().general.trim()
				? [{ id: "general", body: draft.value().general }]
				: []),
		].filter((c) => c.body.trim());
	const submit = async (
		decision?: "approved" | "changes-requested" | "rejected",
	) => {
		if (!editable()) return;
		setBusy(true);
		setError(null);
		const identity = {
			id: captured.id,
			digest: captured.digest,
			revision: captured.revision,
			requestId: draft.value().requestId,
		};
		try {
			if (captured.kind === "question") {
				const answerReceipt = await ctx.client.call("question.submit", {
					...identity,
					answers: draft.value().answers.map((answer) => ({
						...answer,
						text: answer.customSelected ? answer.text : "",
					})),
					globalNote: draft.value().globalNote,
				});
				acknowledge({
					...captured,
					state: "answered",
					revision: captured.revision + 1,
					answerReceipt,
				});
			} else if (captured.kind === "code-review") {
				const receipt = await ctx.client.call("review.submit", {
					...identity,
					comments: comments().map(({ body, anchor }) => ({ body, anchor })),
				});
				acknowledge({
					...captured,
					state: receipt.decision,
					revision: captured.revision + 1,
					receipt,
					comments: receipt.comments.map((c) => c.body).join("\n\n"),
				});
			} else {
				if (!decision)
					throw new Error("An explicit approval decision is required");
				const approvalReceipt = await ctx.client.call("approval.submit", {
					...identity,
					decision,
					comments: draft.value().general,
				});
				acknowledge({
					...captured,
					state: approvalReceipt.decision,
					revision: captured.revision + 1,
					approvalReceipt,
					comments: approvalReceipt.comments,
				});
			}
			if (disposed) return;
			setOpen(false);
			if (active()) {
				ctx.focus(null);
				ctx.catalog([]);
			}
		} catch (e) {
			if (!disposed) setError(e instanceof Error ? e.message : String(e));
		} finally {
			if (!disposed) setBusy(false);
		}
	};
	const keepText = () => {
		const target = editor();
		if (target?.kind === "custom")
			draft.change((d) => ({
				...d,
				answers: d.answers.map((a, i) =>
					i === target.index
						? {
								...a,
								customSelected: Boolean(text().trim()),
								optionIndexes:
									!text().trim() || captured.questions?.[i]?.multiSelect
										? a.optionIndexes
										: [],
							}
						: a,
				),
			}));
		setEditor(null);
	};
	const unregister = useKeymap().registerLayer({
		priority: 85,
		enabled: () => active() && editor() !== null && !help(),
		bindings: (captured.kind === "question"
			? questionEditorKeybinds
			: humanEditorKeybinds
		).map((b) => ({
			key: b.key,
			cmd: () => {
				if (b.cmd === "human.leave") {
					setEditor(null);
					return;
				}
				if (!editable()) return;
				if (b.cmd === "human.saveText") keepText();
				else if (b.cmd === "editor.newline") area?.insertText("\n");
				else if (b.cmd === "human.clearText" && editor()?.kind === "custom") {
					area?.setText("");
					persistText("");
				}
			},
		})),
	});
	onCleanup(unregister);
	let area: TextareaRenderable | undefined;
	let helpArea: ScrollBoxRenderable | undefined;
	const unregisterHelp = useKeymap().registerLayer({
		priority: 100,
		enabled: () => active() && help(),
		bindings: humanHelpKeybinds.map((b) => ({
			key: b.key,
			cmd: () => {
				if (b.cmd === "human.leave") {
					setHelp(false);
				} else helpArea?.scrollBy(b.cmd === "human.helpUp" ? -1 : 1);
			},
		})),
	});
	onCleanup(unregisterHelp);
	const textArea = () => (
		<textarea
			ref={(node) => {
				area = node;
			}}
			initialValue={text()}
			focused={active() && !help() && editable()}
			flexGrow={1}
			width="100%"
			keyBindings={textareaBindings(editorCatalog())}
			onContentChange={() => {
				if (area) persistText(area.plainText);
			}}
		/>
	);
	return (
		<box
			ref={(node) => {
				unregisterAnchor = ctx.register(captured.id, node);
			}}
			flexDirection="column"
			border={["left"]}
			borderColor={outcomeTone()}
			paddingLeft={1}
			gap={1}
		>
			<ActionHeader
				scope={`${captured.id}:${observed().revision}`}
				onActivate={() => {
					if (open()) {
						setOpen(false);
						setEditor(null);
						ctx.focus(null);
					} else setOpen(true);
				}}
			>
				<text fg={outcomeTone()} wrapMode="word">
					{open() ? "▾" : "▸"}{" "}
					{observed().state === "pending"
						? "Awaiting you"
						: `Human receipt · ${observed().state}`}{" "}
					· {captured.title}
				</text>
			</ActionHeader>
			<Show
				when={
					open() &&
					observed().state === "pending" &&
					captured.kind === "question" &&
					!active()
				}
			>
				<ActionHeader interactive={editable()} onActivate={focus}>
					<text fg={color("accent")}>Focus questionnaire</text>
				</ActionHeader>
			</Show>
			<Show when={observed().state !== "pending"}>
				<text fg={color("textMuted")} wrapMode="word">
					{observed().kind === "question"
						? observed().answerReceipt
							? `${observed().answerReceipt?.answers.length ?? 0} answers submitted`
							: "No answers submitted"
						: observed().comments || "No review comments"}{" "}
					· immutable snapshot {observed().digest.slice(0, 12)}
				</text>
			</Show>
			<Show when={props.readProblem}>
				<text fg={color("warning")} wrapMode="word">
					Cached immutable request · controls disabled · {props.readProblem}
				</text>
				<ActionHeader onActivate={props.retry}>
					<text fg={color("accent")}>Retry immutable request read</text>
				</ActionHeader>
			</Show>
			<Show when={open()}>
				<Show when={!ctx.fresh()}>
					<text fg={color("warning")}>
						Cached observation; reconnect before submitting. Draft retained.
					</text>
				</Show>
				<Show
					when={
						observed().digest !== captured.digest ||
						(observed().revision !== captured.revision &&
							observed().state === "pending")
					}
				>
					<text fg={color("warning")}>
						Request superseded. This draft still belongs to the displayed
						original snapshot; it was not retargeted.
					</text>
				</Show>
				<Show when={error() || draft.error()}>
					<text fg={color("error")} wrapMode="word">
						{error() ?? draft.error()}
					</text>
				</Show>
				<Show when={draft.error()}>
					<ActionHeader onActivate={draft.retry}>
						<text fg={color("accent")}>
							Retry draft persistence (local text retained)
						</text>
					</ActionHeader>
				</Show>
				<Show when={observed().state !== "pending"}>
					<For each={observed().answerReceipt?.answers ?? []}>
						{(answer) => (
							<box flexDirection="column" gap={1}>
								<text fg={color("textMuted")} wrapMode="word">
									{answer.question}
								</text>
								<Show when={answer.selected?.length}>
									<text fg={color("text")} wrapMode="word">
										{answer.selected?.join(" · ")}
									</text>
								</Show>
								<Show when={answer.answer}>
									<text fg={color("text")} wrapMode="word">
										{answer.answer}
									</text>
								</Show>
								<Show when={answer.notes}>
									<text fg={color("textMuted")} wrapMode="word">
										Note: {answer.notes}
									</text>
								</Show>
								<Show when={answer.preview}>
									<MarkdownViewer content={answer.preview ?? ""} />
								</Show>
							</box>
						)}
					</For>
					<Show when={observed().answerReceipt?.globalNote}>
						<text fg={color("textMuted")} wrapMode="word">
							Global note: {observed().answerReceipt?.globalNote}
						</text>
					</Show>
					<For each={observed().receipt?.comments ?? []}>
						{(comment) => (
							<box flexDirection="column">
								<text fg={color("textMuted")} wrapMode="word">
									{comment.anchor
										? `${comment.anchor.side} ${comment.anchor.path}${comment.anchor.start ? `:${comment.anchor.start}${comment.anchor.end && comment.anchor.end !== comment.anchor.start ? `–${comment.anchor.end}` : ""}` : " · file"}`
										: "General feedback"}
								</text>
								<text fg={color("text")} wrapMode="word">
									{comment.body}
								</text>
							</box>
						)}
					</For>
					<Show when={!observed().receipt && !observed().answerReceipt}>
						<text fg={color("textMuted")} wrapMode="word">
							{observed().comments ||
								(observed().state === "cancelled"
									? "Cancelled without human submission"
									: "No feedback comments")}
						</text>
					</Show>
					<Show
						when={
							comments().length ||
							draft
								.value()
								.answers.some((a) => a.text || a.optionIndexes.length)
						}
					>
						<ActionHeader onActivate={() => setInspectDraft((value) => !value)}>
							<text fg={color("textMuted")}>
								{inspectDraft() ? "Hide" : "Inspect"} retained local draft ·
								read-only, not another committed decision
							</text>
						</ActionHeader>
					</Show>
				</Show>
				<Show when={observed().state === "pending" || inspectDraft()}>
					<Show
						when={captured.kind === "question"}
						fallback={
							<Show
								when={captured.kind === "code-review"}
								fallback={
									<>
										<text fg={color("warning")} wrapMode="word">
											Explicit approval gate · scope {captured.path} · snapshot{" "}
											{captured.digest}. This is not a code review; comments
											never imply approval.
										</text>
										<scrollbox height={10}>
											<text wrapMode="word">{captured.snapshot}</text>
										</scrollbox>
									</>
								}
							>
								<InlineReview
									request={captured}
									draft={draft.value()}
									editable={editable()}
									active={active() && !help()}
									editorOpen={editor() !== null}
									change={draft.change}
									focus={focus}
									blur={() => ctx.focus(null)}
									help={() => setHelp(true)}
									edit={(comment) => edit({ kind: "comment", comment })}
									modal={setDiff}
									error={setError}
								/>
							</Show>
						}
					>
						<Questionnaire
							questions={captured.questions ?? []}
							draft={draft.value()}
							customEditing={editor()?.kind === "custom"}
							editable={editable() && editor() === null}
							active={active() && !editor() && !help()}
							change={draft.change}
							focus={focus}
							postpone={postpone}
							help={() => setHelp(true)}
							submit={() => void submit()}
							edit={(kind, index) => edit({ kind, index })}
						/>
					</Show>
					<Show when={captured.kind !== "question"}>
						<Show when={draft.value().general}>
							<text wrapMode="word">
								General feedback: {draft.value().general}
							</text>
						</Show>
						<ActionHeader
							interactive={editable()}
							onActivate={() => edit({ kind: "general" })}
						>
							<text fg={color("accent")}>Edit general feedback</text>
						</ActionHeader>
						<For each={draft.value().comments}>
							{(c) => (
								<box flexDirection="column">
									<text wrapMode="word">
										{c.anchor
											? `${c.anchor.path} · ${c.anchor.side}${c.anchor.start ? `:${c.anchor.start}–${c.anchor.end ?? c.anchor.start}` : " · file"}`
											: "General"}
										: {c.body || "Empty draft (not submitted)"}
									</text>
									<ActionHeader
										interactive={editable()}
										onActivate={() => edit({ kind: "comment", comment: c })}
									>
										<text fg={color("accent")}>Edit draft comment</text>
									</ActionHeader>
									<ActionHeader
										interactive={editable()}
										onActivate={() =>
											draft.change((d) => ({
												...d,
												comments: d.comments.filter(
													(other) => other.id !== c.id,
												),
											}))
										}
									>
										<text fg={color("textMuted")}>Delete draft comment</text>
									</ActionHeader>
								</box>
							)}
						</For>
						<Show
							when={captured.kind === "code-review"}
							fallback={
								<For
									each={["approved", "changes-requested", "rejected"] as const}
								>
									{(decision) => (
										<ActionHeader
											interactive={editable()}
											onActivate={() => void submit(decision)}
										>
											<text fg={color("accent")}>
												Submit explicit {decision} decision
											</text>
										</ActionHeader>
									)}
								</For>
							}
						>
							<ActionHeader
								interactive={editable()}
								onActivate={() => void submit()}
							>
								<text fg={color("accent")}>
									{comments().length
										? `Submit ${comments().length} comments · request changes`
										: "Approve review"}
								</text>
							</ActionHeader>
						</Show>
					</Show>

					<text fg={color("textMuted")}>
						{busy()
							? "Saving human response…"
							: draft.saving()
								? "Saving draft…"
								: draft.ready()
									? "Draft retained in v2 state · not submitted"
									: "Loading retained draft…"}
					</text>
					<ActionHeader onActivate={postpone}>
						<text fg={color("textMuted")}>Postpone · keep draft</text>
					</ActionHeader>
				</Show>
			</Show>
			<Show when={editor()}>
				{(target) => (
					<Show
						when={target().kind === "comment"}
						fallback={
							<box
								ref={(node) => ctx.reveal?.(node)}
								flexDirection="column"
								width="100%"
								height={10}
								border={["left"]}
								borderColor={color("accent")}
								paddingLeft={1}
							>
								<text fg={color("accent")}>
									{target().kind === "custom"
										? "Type something…"
										: target().kind === "notes"
											? "Note for this answer"
											: target().kind === "global"
												? "Global note"
												: "General review feedback"}{" "}
									· draft
								</text>
								{textArea()}
							</box>
						}
					>
						<GenericModal
							title={`Draft comment · ${target().comment?.anchor?.side ?? "general"} ${target().comment?.anchor?.path ?? ""}`}
							widthPercent={0.6}
							heightPercent={0.5}
							helpText={editorCatalog().map((b) => ({
								key:
									b.key === "ctrl+return"
										? "Ctrl+Enter"
										: b.key === "shift+return"
											? "Shift+Enter"
											: b.key === "ctrl+u"
												? "Ctrl+U"
												: b.key === "return"
													? "Enter"
													: "Esc",
								action: b.action,
							}))}
							onBackdropClick={() => setEditor(null)}
						>
							{textArea()}
						</GenericModal>
					</Show>
				)}
			</Show>
			<Show when={help()}>
				<GenericModal
					title="Human interaction keybindings"
					widthPercent={0.7}
					heightPercent={0.75}
					helpText={humanHelpKeybinds
						.filter((b) => !b.standard)
						.map((b) => ({ ...b, key: keyLabel(b.key) }))}
					onBackdropClick={() => setHelp(false)}
				>
					<scrollbox
						ref={(node) => {
							helpArea = node;
						}}
					>
						<For each={interactionCatalog()}>
							{(b) => (
								<text>
									{keyLabel(b.key)} · {b.action}
								</text>
							)}
						</For>
					</scrollbox>
				</GenericModal>
			</Show>
		</box>
	);
}
