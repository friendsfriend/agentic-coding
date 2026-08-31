/** @jsxImportSource @opentui/solid */
import type { KeyEvent, Renderable, ScrollBoxRenderable } from "@opentui/core";
import type { Keymap } from "@opentui/keymap";
import {
	createEffect,
	createMemo,
	createSignal,
	For,
	onCleanup,
	onMount,
	Show,
} from "solid-js";
import type {
	WikiConcept,
	WikiReviewComment,
	WikiTreeNode,
} from "../../../workflow/wiki";
import {
	buildWikiTree,
	flattenWikiTree,
	listConcepts,
	readConcept,
	renderDocument,
} from "../../../workflow/wiki";
import { MarkdownViewModal } from "../../dash/devenv-ui/components/MarkdownViewModal";
import type { Discussion } from "../../dash/devenv-ui/types";
import { notify } from "../app/notifications";
import { ScrollableContent } from "../components/ScrollableContent";
import { uiColors } from "../ui/colors";

export interface WikiViewProps {
	keymap: Keymap<Renderable, KeyEvent>;
	comments: readonly WikiReviewComment[];
	onAddComment: (comment: WikiReviewComment) => void;
	onFinish: (comments: readonly WikiReviewComment[]) => Promise<string>;
	/** Owned by the shell so the submission guard survives tab unmounts. */
	submitting: boolean;
	onSubmittingChange: (value: boolean) => void;
	onClearComments: () => void;
}

type WikiLoadState =
	| { kind: "loading" }
	| { kind: "ready"; concepts: WikiConcept[]; tree: WikiTreeNode[] }
	| { kind: "empty" }
	| { kind: "error"; message: string };

const printable = (event: KeyEvent): string =>
	event.sequence && event.sequence.length === 1 ? event.sequence : "";

/** Home-mode browser for the centralized OKF wiki and its temporary review. */
export function WikiView(props: WikiViewProps) {
	const [state, setState] = createSignal<WikiLoadState>({ kind: "loading" });
	const [selected, setSelected] = createSignal(0);
	const [expanded, setExpanded] = createSignal<Set<string>>(new Set());
	const [note, setNote] = createSignal<WikiConcept>();
	const [noteIndex, setNoteIndex] = createSignal(0);
	const [selectedLine, setSelectedLine] = createSignal(0);
	const [visualStart, setVisualStart] = createSignal(0);
	const [visualMode, setVisualMode] = createSignal(false);
	const [commentMode, setCommentMode] = createSignal(false);
	const [commentText, setCommentText] = createSignal("");
	const [sourceRange, setSourceRange] = createSignal<{
		start?: number;
		end?: number;
	}>({});

	const errorMessage = () => {
		const current = state();
		return current.kind === "error" ? current.message : "unknown error";
	};
	const rows = createMemo(() => {
		const current = state();
		return current.kind === "ready"
			? flattenWikiTree(current.tree, expanded())
			: [];
	});
	let treeScroll: ScrollBoxRenderable | undefined;
	createEffect(() => {
		const index = selected();
		rows();
		const child = treeScroll?.getChildren()[0]?.getChildren()[index];
		if (child) treeScroll?.scrollChildIntoView(child.id);
	});
	const concepts = createMemo<WikiConcept[]>(() => {
		const current = state();
		return current.kind === "ready" ? current.concepts : [];
	});
	const notePosition = createMemo(() => {
		const current = note();
		return current
			? concepts().findIndex((item) => item.id === current.id)
			: -1;
	});
	const commentsForNote = createMemo<Discussion[]>(() =>
		props.comments
			.filter((comment) => comment.conceptId === note()?.id)
			.map((comment, index) => ({
				id: `wiki-${index}`,
				individual_note: true,
				position: {
					base_sha: "wiki",
					start_sha: "wiki",
					head_sha: "wiki",
					old_path: note()?.id ?? "",
					new_path: note()?.id ?? "",
					position_type: "text",
					new_line: comment.startLine ?? comment.line,
				},
				notes: [
					{
						id: index,
						type: "DiscussionNote",
						body: comment.body,
						author: { name: "You" },
						created_at: new Date().toISOString(),
						updated_at: new Date().toISOString(),
						system: false,
						resolvable: false,
						resolved: false,
						position: {
							base_sha: "wiki",
							start_sha: "wiki",
							head_sha: "wiki",
							old_path: note()?.id ?? "",
							new_path: note()?.id ?? "",
							position_type: "text",
							new_line: comment.startLine ?? comment.line,
						},
					},
				],
			})),
	);

	const refresh = () => {
		setState({ kind: "loading" });
		try {
			const listed = listConcepts();
			const tree = buildWikiTree(listed);
			const open = new Set<string>();
			const visit = (nodes: WikiTreeNode[]) => {
				for (const node of nodes) {
					if (node.kind === "directory") {
						open.add(node.id);
						visit(node.children);
					}
				}
			};
			visit(tree);
			setExpanded(open);
			setSelected(0);
			setState(
				listed.length
					? { kind: "ready", concepts: listed, tree }
					: { kind: "empty" },
			);
		} catch (error) {
			setState({
				kind: "error",
				message: error instanceof Error ? error.message : String(error),
			});
		}
	};

	const openNote = (conceptId: string) => {
		try {
			const loaded = readConcept(conceptId);
			setNote(loaded);
			setNoteIndex(
				Math.max(
					0,
					concepts().findIndex((item) => item.id === conceptId),
				),
			);
			setSelectedLine(0);
			setVisualMode(false);
			setCommentMode(false);
			setCommentText("");
			setSourceRange({});
		} catch (error) {
			notify(
				`Wiki note is unavailable: ${error instanceof Error ? error.message : String(error)}`,
				"warning",
			);
		}
	};

	const navigateNote = (direction: 1 | -1) => {
		const all = concepts();
		if (!all.length) return;
		const next = (noteIndex() + direction + all.length) % all.length;
		const target = all[next];
		if (target) openNote(target.id);
	};

	const finish = async () => {
		if (props.submitting) return;
		if (!props.comments.length) {
			notify("Add at least one wiki comment before finishing", "warning");
			return;
		}
		props.onSubmittingChange(true);
		try {
			notify("Starting wiki comment workflow…", "info");
			const message = await props.onFinish(props.comments);
			notify(message, "success");
			props.onClearComments();
			props.onSubmittingChange(false);
			setNote(undefined);
		} catch (error) {
			props.onSubmittingChange(false);
			notify(
				`Wiki review could not start: ${error instanceof Error ? error.message : String(error)}`,
				"error",
			);
		}
	};

	const submitComment = () => {
		const body = commentText().trim();
		if (!body) {
			notify("A comment body is required", "warning");
			return;
		}
		const current = note();
		if (!current) return;
		const range = sourceRange();
		props.onAddComment({
			conceptId: current.id,
			line: range.start ?? selectedLine() + 1,
			...(range.start !== undefined ? { startLine: range.start } : {}),
			...(range.end !== undefined && range.end !== range.start
				? { endLine: range.end }
				: {}),
			body,
		});
		setCommentMode(false);
		setCommentText("");
		notify("Wiki comment added", "success");
	};

	const handleKey = (event: KeyEvent): boolean => {
		const key = event.name.toLowerCase();
		const currentNote = note();
		if (commentMode()) {
			if (key === "escape") {
				setCommentMode(false);
				setCommentText("");
			} else if (key === "backspace" || key === "delete") {
				setCommentText((text) => text.slice(0, -1));
			} else if (key === "return" || key === "enter") {
				if (event.ctrl || event.meta) submitComment();
				else setCommentText((text) => `${text}\n`);
			} else if (!event.ctrl && !event.meta) {
				const text = printable(event);
				if (text) setCommentText((value) => value + text);
			}
			return true;
		}
		if (key === "f") {
			void finish();
			return true;
		}
		if (key === "q") {
			globalThis.__requestShutdown?.();
			return true;
		}
		if (currentNote) {
			if (key === "escape") {
				setNote(undefined);
				setVisualMode(false);
				return true;
			}
			if (key === "j" || key === "down") {
				setSelectedLine((line) => line + 1);
				return true;
			}
			if (key === "k" || key === "up") {
				setSelectedLine((line) => Math.max(0, line - 1));
				return true;
			}
			if (key === "v") {
				if (visualMode()) setVisualMode(false);
				else {
					setVisualStart(selectedLine());
					setVisualMode(true);
				}
				return true;
			}
			if (key === "c") {
				setCommentText("");
				setCommentMode(true);
				return true;
			}
			if (key === "n") {
				navigateNote(event.shift ? -1 : 1);
				return true;
			}
			return true;
		}
		if (key === "r") {
			refresh();
			return true;
		}
		if (key === "j" || key === "down") {
			setSelected((index) =>
				Math.min(Math.max(0, rows().length - 1), index + 1),
			);
			return true;
		}
		if (key === "k" || key === "up") {
			setSelected((index) => Math.max(0, index - 1));
			return true;
		}
		if (key === "enter" || key === "return") {
			const row = rows()[selected()];
			if (row?.kind === "directory")
				setExpanded((value) => {
					const next = new Set(value);
					if (next.has(row.id)) next.delete(row.id);
					else next.add(row.id);
					return next;
				});
			else if (row) openNote(row.id);
			return true;
		}
		if (key === "?") {
			notify(
				"j/k select · Enter open/expand · r refresh · f finish · q quit",
				"info",
			);
			return true;
		}
		return true;
	};

	onMount(() => {
		refresh();
		const dispose = props.keymap.registerLayer({
			name: "wiki-view",
			priority: 200,
			appView: "home",
			activeModal: "none",
			commands: [
				{ name: "wiki-view.handle", run: ({ event }) => handleKey(event) },
			],
			bindings: [
				"escape",
				"return",
				"enter",
				"ctrl+return",
				"ctrl+enter",
				"meta+return",
				"meta+enter",
				"backspace",
				"delete",
				"up",
				"down",
				"j",
				"k",
				"c",
				"C",
				"v",
				"n",
				"N",
				"f",
				"r",
				"?",
				"space",
				..."abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789-_=+[]{};:\\|,.<>`~!@#$%^&*() "
					.split("")
					.map((key) => (key === " " ? "space" : key)),
			].map((key) => ({ key, cmd: "wiki-view.handle" })),
		});
		onCleanup(dispose);
	});

	return (
		<box style={{ width: "100%", height: "100%", flexDirection: "column" }}>
			<Show when={state().kind === "loading"}>
				<text fg={uiColors.textMuted}>Loading centralized wiki…</text>
			</Show>
			<Show when={state().kind === "empty"}>
				<text fg={uiColors.textMuted}>
					No readable wiki concepts found. Press r to refresh.
				</text>
			</Show>
			<Show when={state().kind === "error"}>
				<text fg={uiColors.error}>
					Wiki unavailable: {errorMessage()} · Press r to retry.
				</text>
			</Show>
			<Show when={state().kind === "ready"}>
				<box style={{ flexDirection: "row", flexGrow: 1, minHeight: 0 }}>
					<box style={{ width: "100%", flexDirection: "column" }}>
						<text fg={uiColors.textMuted}>
							Wiki · Enter open/expand · c comment · f finish · r refresh
						</text>
						<ScrollableContent
							onScrollBoxReady={(scrollBox) => {
								treeScroll = scrollBox;
							}}
						>
							<For each={rows()}>
								{(row, index) => (
									<box
										height={1}
										paddingLeft={1}
										backgroundColor={
											index() === selected()
												? uiColors.primary
												: uiColors.bgBase
										}
										onMouseUp={() => setSelected(index())}
									>
										<text
											fg={
												index() === selected()
													? uiColors.bgBase
													: uiColors.textPrimary
											}
										>
											{"  ".repeat(row.depth)}
											{row.kind === "directory"
												? expanded().has(row.id)
													? "▾ "
													: "▸ "
												: "• "}
											{row.label}
										</text>
									</box>
								)}
							</For>
						</ScrollableContent>
					</box>
				</box>
			</Show>
			<Show when={note()}>
				{(current) => (
					<MarkdownViewModal
						filePath={current().id}
						content={renderDocument(current().frontmatter, current().body)}
						currentFileIndex={Math.max(0, notePosition())}
						totalFiles={Math.max(1, concepts().length)}
						selectedLine={selectedLine()}
						visualModeActive={visualMode()}
						visualModeStart={visualStart()}
						commentMode={commentMode()}
						commentText={commentText()}
						discussions={commentsForNote()}
						onSelectedLineChange={setSelectedLine}
						onSelectedSourceRangeChange={(start, end) =>
							setSourceRange({ start, end })
						}
						onClose={() => setNote(undefined)}
						onNavigateFile={navigateNote}
					/>
				)}
			</Show>
		</box>
	);
}
