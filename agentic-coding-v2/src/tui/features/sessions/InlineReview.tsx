/** @jsxImportSource @opentui/solid */

import type { ScrollBoxRenderable } from "@opentui/core";
import { useKeymap } from "@opentui/keymap/solid";
import { createMemo, createSignal, For, onCleanup, Show } from "solid-js";
import type { ReviewComment } from "../../../review-feedback.ts";
import {
	type ReviewFile,
	type ReviewTreeNode,
	reviewFiles,
	reviewFileTree,
} from "../../../review-files.ts";
import type { Review } from "../../../state.ts";
import { useTerminalDimensions } from "../../presentation/hooks/useTerminalDimensions.ts";
import { ActionHeader } from "../../ui/ActionHeader.tsx";
import {
	buildSplitDiffLines,
	parseDiffLines,
} from "../../ui/components/diffView.ts";
import { ModalFooterContext } from "../../ui/components/GenericModal.tsx";
import { formatHelpTextLines } from "../../ui/components/HelpText.tsx";
import { keyLabel } from "../../ui/keybinds.ts";
import { uiColors } from "../../ui/theme/colors";
import { color } from "../../ui/theme/index.ts";
import { DiffReviewView } from "../../ui/views/DiffReviewView.tsx";
import type { Discussion } from "../../ui/views/types.ts";
import type { HumanDraft } from "./human-draft.ts";
import { reviewDiffKeybinds } from "./human-keybinds.ts";

export function InlineReview(props: {
	request: Review;
	draft: HumanDraft;
	editable: boolean;
	active: boolean;
	editorOpen: boolean;
	change: (edit: (d: HumanDraft) => HumanDraft) => void;
	focus: () => void;
	blur: () => void;
	help: () => void;
	edit: (comment: ReviewComment & { id?: string }) => void;
	modal: (open: boolean) => void;
	error: (message: string) => void;
}) {
	const files = createMemo(() => reviewFiles(props.request.snapshot));
	const tree = createMemo(() => reviewFileTree(files()));
	const [fileKey, setFileKey] = createSignal<string | null>(null);
	const file = () => files().find((f) => f.key === fileKey());
	const [line, setLine] = createSignal(0),
		[visual, setVisual] = createSignal(false),
		[visualStart, setVisualStart] = createSignal(0),
		[split, setSplit] = createSignal<boolean | null>(null);
	const [side, setSide] = createSignal<"old" | "new" | null>(null);
	const [commentLines, setCommentLines] = createSignal<number[]>([]);
	const dimensions = useTerminalDimensions();
	let scrollBox: ScrollBoxRenderable | undefined;
	const isSplit = () =>
		file()?.status !== "A" &&
		file()?.status !== "D" &&
		(split() ?? dimensions().width >= 160);
	const modalDiff = () => {
		const raw = file()?.diff ?? "";
		const header = raw.search(/^--- /m);
		return header < 0 ? raw : raw.slice(header);
	};
	const rows = createMemo(() => {
		const parsed = parseDiffLines(modalDiff());
		return isSplit()
			? buildSplitDiffLines(parsed)
					.filter((row) => !row.header)
					.map((row) => ({
						old: row.oldLine?.lineNum,
						new: row.newLine?.lineNum,
					}))
			: parsed
					.filter((row) => row.type !== "header")
					.map((row) => ({ old: row.oldLineNum, new: row.newLineNum }));
	});
	const discussions = createMemo<Discussion[]>(() =>
		props.draft.comments
			.filter(
				(c) =>
					c.anchor &&
					(c.anchor.path === file()?.oldPath ||
						c.anchor.path === file()?.newPath),
			)
			.map((c, i) => ({
				id: c.id,
				individual_note: false,
				notes: [
					{
						id: i,
						type: "DiffNote",
						body: c.body,
						author: { name: "You · draft" },
						created_at: new Date(0).toISOString(),
						updated_at: new Date(0).toISOString(),
						system: false,
						resolvable: false,
						resolved: false,
						position: c.anchor?.start
							? {
									base_sha: props.request.baseCommit ?? "",
									start_sha: props.request.baseCommit ?? "",
									head_sha: props.request.digest,
									old_path: file()?.oldPath ?? "",
									new_path: file()?.newPath ?? "",
									position_type: "text",
									...(c.anchor.side === "old"
										? { old_line: c.anchor.start }
										: { new_line: c.anchor.start }),
								}
							: undefined,
					},
				],
			})),
	);
	const openFile = (next: ReviewFile) => {
		props.focus();
		props.modal(true);
		setFileKey(next.key);
		setLine(0);
		setVisual(false);
		setSide(null);
		if (!props.draft.viewed.includes(next.key))
			props.change((d) => ({ ...d, viewed: [...d.viewed, next.key] }));
	};
	const close = () => {
		setFileKey(null);
		setVisual(false);
		props.modal(false);
		props.blur();
	};
	onCleanup(() => props.modal(false));
	const navigate = (direction: 1 | -1) => {
		const index = files().findIndex((f) => f.key === fileKey());
		const next = files()[index + direction];
		if (next) openFile(next);
	};
	const comment = () => {
		const current = file();
		if (!current || !props.editable) return;
		const selected = rows()[line()];
		const first = rows()[visual() ? visualStart() : line()];
		const selectedSide = side() ?? (first?.new === undefined ? "old" : "new");
		const start = first?.[selectedSide],
			end = selected?.[selectedSide];
		const path = selectedSide === "old" ? current.oldPath : current.newPath;
		if (!path || start === undefined || end === undefined) {
			props.error(
				"No complete source range on that side; select source lines or use a file comment. Draft retained.",
			);
			return;
		}
		props.edit({
			body: "",
			anchor: {
				path,
				side: selectedSide,
				start: Math.min(start, end),
				end: Math.max(start, end),
			},
		});
	};
	const unregister = useKeymap().registerLayer({
		priority: 70,
		enabled: () => props.active && !!file() && !props.editorOpen,
		bindings: reviewDiffKeybinds.map((b) => ({
			key: b.key,
			cmd: () => {
				switch (b.cmd) {
					case "human.scrollLeft":
						scrollBox?.scrollBy({ x: -4, y: 0 });
						break;
					case "human.scrollRight":
						scrollBox?.scrollBy({ x: 4, y: 0 });
						break;
					case "human.editComment": {
						const selected = rows()[line()];
						const existing = props.draft.comments.find(
							(c) =>
								c.anchor &&
								(c.anchor.path === file()?.oldPath ||
									c.anchor.path === file()?.newPath) &&
								c.anchor.start !== undefined &&
								(selected?.[c.anchor.side] ?? -1) >= c.anchor.start &&
								(selected?.[c.anchor.side] ?? Infinity) <=
									(c.anchor.end ?? c.anchor.start),
						);
						if (existing && props.editable) props.edit(existing);
						else
							props.error(
								"No editable draft comment at this selected source line",
							);
						break;
					}
					case "human.up":
						setLine((n) => Math.max(0, n - 1));
						break;
					case "human.down":
						setLine((n) => Math.min(Math.max(0, rows().length - 1), n + 1));
						break;
					case "human.visual":
						setVisualStart(line());
						setVisual((v) => !v);
						break;
					case "human.comment":
						comment();
						break;
					case "human.side":
						setSide((s) => (s === "old" ? "new" : "old"));
						break;
					case "human.split":
						setSplit((s) => !(s ?? dimensions().width >= 160));
						setLine(0);
						setVisual(false);
						break;
					case "human.nextFile":
						navigate(1);
						break;
					case "human.previousFile":
						navigate(-1);
						break;
					case "human.nextComment":
						setLine(
							(n) =>
								commentLines().find((i) => i > n) ?? commentLines()[0] ?? n,
						);
						break;
					case "human.previousComment":
						setLine(
							(n) =>
								[...commentLines()].reverse().find((i) => i < n) ??
								commentLines().at(-1) ??
								n,
						);
						break;
					case "human.leave":
						close();
						break;
					case "human.help":
						props.help();
						break;
				}
			},
		})),
	});
	onCleanup(unregister);
	const toggleFolder = (key: string) =>
		props.change((d) => ({
			...d,
			closedFolders: d.closedFolders.includes(key)
				? d.closedFolders.filter((k) => k !== key)
				: [...d.closedFolders, key],
		}));
	const renderTree = (nodes: ReviewTreeNode[], depth = 0) => (
		<For each={nodes}>
			{(node) => (
				<box flexDirection="column" paddingLeft={depth ? 2 : 0}>
					<Show
						when={node.file}
						fallback={
							<>
								<ActionHeader
									interactive={true}
									onActivate={() => toggleFolder(node.key)}
								>
									<text fg={color("textMuted")}>
										{props.draft.closedFolders.includes(node.key) ? "▸" : "▾"}{" "}
										{node.name}/
									</text>
								</ActionHeader>
								<Show when={!props.draft.closedFolders.includes(node.key)}>
									{renderTree(node.children, depth + 1)}
								</Show>
							</>
						}
					>
						{(f) => (
							<box flexDirection="column">
								<ActionHeader
									interactive={true}
									onActivate={() => openFile(f())}
								>
									<text fg={color("accent")} wrapMode="word">
										{f().status} {node.name} · +{f().added} −{f().deleted}
										{f().binary ? " · binary" : ""} ·{" "}
										{props.draft.viewed.includes(f().key)
											? "viewed"
											: "not viewed"}{" "}
										·{" "}
										{
											props.draft.comments.filter(
												(c) =>
													c.body.trim() &&
													(c.anchor?.path === (f().newPath ?? f().oldPath) ||
														c.anchor?.path === f().oldPath),
											).length
										}{" "}
										comments
									</text>
								</ActionHeader>
								<Show when={f().status === "R"}>
									<text fg={color("textMuted")} wrapMode="word">
										{f().oldPath} → {f().newPath}
									</text>
								</Show>
								<ActionHeader
									interactive={props.editable}
									onActivate={() =>
										props.edit({
											body: "",
											anchor: {
												path: f().newPath ?? f().oldPath ?? "",
												side: f().newPath ? "new" : "old",
											},
										})
									}
								>
									<text fg={color("textMuted")}>Comment on file</text>
								</ActionHeader>
							</box>
						)}
					</Show>
				</box>
			)}
		</For>
	);
	return (
		<box flexDirection="column" gap={1}>
			<text fg={color("textMuted")} wrapMode="word">
				Scope: {props.request.path} · base{" "}
				{props.request.baseCommit ?? "not recorded (legacy snapshot)"}
				{"\n"}Snapshot {props.request.digest} · revision{" "}
				{props.request.revision}
			</text>
			<text>
				{files().length} changed files · +
				{files().reduce((n, f) => n + f.added, 0)} −
				{files().reduce((n, f) => n + f.deleted, 0)}
			</text>
			<Show when={!files().length}>
				<text fg={color("textMuted")} wrapMode="word">
					{props.request.snapshot ||
						"Snapshot content unavailable; no textual diff supplied"}
				</text>
			</Show>
			{renderTree(tree())}
			<Show when={file()}>
				{(current) => (
					<ModalFooterContext.Provider
						value={() => (
							<box paddingTop={1} flexShrink={0} flexDirection="column">
								<For
									each={formatHelpTextLines(
										reviewDiffKeybinds
											.filter((b) => !b.standard)
											.map((b) => ({ ...b, key: keyLabel(b.key) })),
										Math.max(1, Math.floor(dimensions().width * 0.9) - 4),
									)}
								>
									{(line) => <text fg={uiColors.textMuted}>{line}</text>}
								</For>
							</box>
						)}
					>
						<DiffReviewView
							onScrollBoxReady={(node) => {
								scrollBox = node;
							}}
							flagLabel={side() ? `${side()}-side comments` : undefined}
							filePath={`${current().newPath ?? current().oldPath ?? "Unavailable"}${current().binary ? " · binary patch; textual source unavailable" : ""}`}
							diff={modalDiff()}
							currentFileIndex={files().findIndex(
								(f) => f.key === current().key,
							)}
							totalFiles={files().length}
							selectedLine={line()}
							visualModeActive={visual()}
							visualModeStart={visualStart()}
							forceSplitView={split()}
							isNewFile={current().status === "A"}
							isDeletedFile={current().status === "D"}
							commentMode={props.editorOpen}
							commentText=""
							discussions={discussions()}
							currentHeadSHA={props.request.digest}
							onSelectedLineChange={setLine}
							onDiscussionLineIndicesChange={setCommentLines}
							onClose={close}
							onNavigateFile={navigate}
						/>
					</ModalFooterContext.Provider>
				)}
			</Show>
		</box>
	);
}
