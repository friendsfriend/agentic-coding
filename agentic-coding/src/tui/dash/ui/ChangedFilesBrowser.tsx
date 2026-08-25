/** @jsxImportSource @opentui/solid */

import type { KeyEvent } from "@opentui/core";
import { useTerminalDimensions } from "@opentui/solid";
import { createMemo, createSignal, onMount, Show } from "solid-js";
import { type LocalChange, loadLocalChanges, loadLocalDiff } from "../data";
import { ChangedFilesView } from "../devenv-ui/components/ChangedFilesView";
import { DiffViewModal } from "../devenv-ui/components/DiffViewModal";
import { GenericModal } from "../devenv-ui/components/GenericModal";

/**
 * Shared changed-files list-to-diff interaction.
 *
 * Owns the boundary around the presentational ChangedFilesView: loads the
 * workflow's local changes, file selection + search, Enter opens the diff
 * (DiffViewModal), Escape returns from the diff to the list and then closes.
 * Both the workspace overview (`G`) and any dashboard surface can open it;
 * review-specific behavior (findings, comments, finish gating) stays with its
 * owner — this browser never mutates workflow state.
 */
export function ChangedFilesBrowser(props: {
	title: string;
	repo: string;
	change: string;
	onKeyReady?: (handler: (event: KeyEvent) => boolean) => void;
	onClose: () => void;
}) {
	const dimensions = useTerminalDimensions();
	const [changes, setChanges] = createSignal<LocalChange[]>([]);
	const [loading, setLoading] = createSignal(true);
	const [error, setError] = createSignal<string>();
	const [view, setView] = createSignal<"files" | "diff">("files");
	const [index, setIndex] = createSignal(0);
	const [line, setLine] = createSignal(0);
	const [diffText, setDiffText] = createSignal("");
	const [selectableLineCount, setSelectableLineCount] = createSignal(0);
	const [searchMode, setSearchMode] = createSignal(false);
	const [searchQuery, setSearchQuery] = createSignal("");

	onMount(() => {
		try {
			setChanges(loadLocalChanges(props.repo, props.change));
		} catch (cause) {
			setError(cause instanceof Error ? cause.message : String(cause));
		} finally {
			setLoading(false);
		}
	});

	const visible = createMemo(() => {
		const query = searchQuery().toLowerCase();
		if (!query) return changes();
		return changes().filter((change) =>
			[change.newPath, change.oldPath].some((path) =>
				path?.toLowerCase().includes(query),
			),
		);
	});
	const currentFile = () => visible()[index()];

	const changeForView = (change: LocalChange) => ({
		old_path: change.oldPath ?? change.newPath,
		new_path: change.newPath,
		a_mode: "100644",
		b_mode: "100644",
		new_file: change.newFile,
		renamed_file: change.renamedFile,
		deleted_file: change.deletedFile,
		diff: "",
		lines_added: change.linesAdded,
		lines_deleted: change.linesDeleted,
		review_finding_count: 0,
	});

	// Mirrors App.tsx: GenericModal chrome (4) + ChangedFilesView chrome (3).
	const filesAvailableLines = () =>
		Math.max(
			1,
			Math.min(dimensions().height, Math.floor(dimensions().height * 0.75)) -
				4 -
				3,
		);

	const openDiff = () => {
		const file = currentFile();
		if (!file) return;
		try {
			setDiffText(loadLocalDiff(props.repo, props.change, file));
			setLine(0);
			setView("diff");
		} catch (cause) {
			setError(cause instanceof Error ? cause.message : String(cause));
		}
	};

	const handleKey = (event: KeyEvent) => {
		const key = event.name.toLowerCase();
		if (view() === "files" && searchMode()) {
			if (key === "escape") {
				setSearchMode(false);
				setSearchQuery("");
				setIndex(0);
			} else if (key === "enter" || key === "return") {
				setSearchMode(false);
			} else if (key === "backspace" || key === "delete") {
				setSearchQuery((query) => query.slice(0, -1));
				setIndex(0);
			} else if (
				event.sequence &&
				event.sequence.length === 1 &&
				event.sequence >= " "
			) {
				setSearchQuery((query) => query + event.sequence);
				setIndex(0);
			}
			return true;
		}
		if (key === "escape") {
			if (view() === "diff") {
				setView("files");
			} else if (searchQuery()) {
				setSearchQuery("");
				setSearchMode(false);
				setIndex(0);
			} else {
				props.onClose();
			}
		} else if (view() === "files" && (key === "/" || event.sequence === "/")) {
			setSearchMode(true);
			setSearchQuery("");
			setIndex(0);
		} else if (view() === "files" && (key === "j" || key === "down"))
			setIndex((current) =>
				Math.min(Math.max(0, visible().length - 1), current + 1),
			);
		else if (view() === "files" && (key === "k" || key === "up"))
			setIndex((current) => Math.max(0, current - 1));
		else if (view() === "files" && (key === "enter" || key === "return"))
			openDiff();
		else if (view() === "diff" && (key === "j" || key === "down"))
			setLine((current) =>
				Math.min(Math.max(0, selectableLineCount() - 1), current + 1),
			);
		else if (view() === "diff" && (key === "k" || key === "up"))
			setLine((current) => Math.max(0, current - 1));
		return true;
	};

	onMount(() => {
		props.onKeyReady?.(handleKey);
	});

	return (
		<>
			<Show when={view() === "files"}>
				<GenericModal
					title={props.title}
					widthPercent={0.9}
					heightPercent={0.75}
					helpText={[
						{ key: "j/k", action: "Navigate" },
						{ key: "Enter", action: "Open diff" },
						{ key: "/", action: "Search files" },
						{ key: "Esc", action: "Close" },
					]}
					onBackdropClick={props.onClose}
				>
					<ChangedFilesView
						changes={visible().map(changeForView)}
						selectedIndex={index()}
						searchMode={searchMode()}
						searchQuery={searchQuery()}
						loading={loading()}
						error={error()}
						availableLines={filesAvailableLines()}
						onClose={props.onClose}
					/>
				</GenericModal>
			</Show>
			<Show when={view() === "diff" && currentFile()}>
				{(file) => (
					<DiffViewModal
						filePath={changeForView(file()).new_path}
						diff={diffText()}
						currentFileIndex={index()}
						totalFiles={visible().length}
						selectedLine={line()}
						visualModeActive={false}
						visualModeStart={0}
						isNewFile={file().newFile}
						isDeletedFile={file().deletedFile}
						commentMode={false}
						commentText=""
						onSelectedLineChange={setLine}
						onSelectableLineCountChange={setSelectableLineCount}
						onClose={() => setView("files")}
					/>
				)}
			</Show>
		</>
	);
}
