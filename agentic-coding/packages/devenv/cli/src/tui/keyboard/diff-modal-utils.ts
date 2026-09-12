import { isDiffFileAddedOrDeleted } from "@devenv/core";

/**
 * Computes the initial split-view preference when opening the diff modal.
 *
 * Mirrors DiffViewModal's new/deleted-file handling, but evaluated once at open-time so
 * the store always holds a concrete boolean — no null "auto" state is needed at runtime.
 *
 *   - Truly new/deleted files → unified (false), side-by-side comparison makes no sense.
 *   - Addition-only/deletion-only hunks in existing files can still use split view.
 *   - Otherwise → split when terminal is wide enough (≥ 160 columns), staggered if not.
 */
export function computeInitialSplitView(
	diff: string,
	terminalWidth: number,
	isNewOrDeletedFile = false,
): boolean {
	if (isNewOrDeletedFile || isDiffFileAddedOrDeleted(diff)) return false;

	return terminalWidth >= 160;
}
