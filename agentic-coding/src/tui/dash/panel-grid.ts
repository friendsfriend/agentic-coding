/**
 * 2D panel navigation model for the dashboard detail view.
 *
 * The rendered panels form a 2×2 occupancy grid; a panel may span more than
 * one cell:
 *
 * ```
 *         col 0         col 1
 * row 0   Change (0)    Agents (1)
 * row 1   OpenSpec (6)  Agents (1)   (span: rows 0–1)
 * ```
 *
 * When no open-spec artifacts are listed the OpenSpec cell `(1, 0)` is empty
 * and navigation transparently skips it. `movePanel` scans from the active
 * panel's anchor cell in the pressed direction, skipping cells owned by the
 * same panel's span and empty cells, wrapping at every grid edge, and landing
 * on the first distinct panel found. A direction with no distinct rendered
 * panel after the scan leaves focus on the active panel.
 */

export type PanelId = number;
export type PanelDirection = "up" | "down" | "left" | "right";

export const CHANGE_PANEL = 0;
export const AGENTS_PANEL = 1;
export const OPENSPEC_PANEL = 6;

export const GRID_ROWS = 2;
export const GRID_COLS = 2;

export interface PanelGridOptions {
	/** True while open-spec artifacts are listed (OpenSpec cell occupied). */
	readonly artifactsVisible: boolean;
}

/** Static geometry: every cell incl. the OpenSpec cell, used to anchor panels. */
const FULL_GRID: ReadonlyArray<ReadonlyArray<PanelId>> = [
	[CHANGE_PANEL, AGENTS_PANEL],
	[OPENSPEC_PANEL, AGENTS_PANEL],
];

/** Rendered occupancy: the OpenSpec cell is empty while no artifacts exist. */
function renderedGrid(
	opts: PanelGridOptions,
): Array<Array<PanelId | undefined>> {
	return [
		[CHANGE_PANEL, AGENTS_PANEL],
		[opts.artifactsVisible ? OPENSPEC_PANEL : undefined, AGENTS_PANEL],
	];
}

/** First (row-major) cell of the active panel's span — the scan origin. */
function anchorCell(panel: PanelId): { row: number; col: number } {
	for (let row = 0; row < GRID_ROWS; row++) {
		for (let col = 0; col < GRID_COLS; col++) {
			if (FULL_GRID[row][col] === panel) return { row, col };
		}
	}
	return { row: 0, col: 0 };
}

const directionDelta: Record<PanelDirection, { row: number; col: number }> = {
	up: { row: -1, col: 0 },
	down: { row: 1, col: 0 },
	left: { row: 0, col: -1 },
	right: { row: 0, col: 1 },
};

/** Move focus one cell in `direction` with edge wrap; stays put on no neighbor. */
export function movePanel(
	active: PanelId,
	direction: PanelDirection,
	opts: PanelGridOptions,
): PanelId {
	const grid = renderedGrid(opts);
	const origin = anchorCell(active);
	const delta = directionDelta[direction];
	const steps =
		direction === "up" || direction === "down" ? GRID_ROWS : GRID_COLS;
	for (let step = 1; step <= steps; step++) {
		const row = modulo(origin.row + delta.row * step, GRID_ROWS);
		const col = modulo(origin.col + delta.col * step, GRID_COLS);
		const cell = grid[row][col];
		if (cell === undefined || cell === active) continue;
		return cell;
	}
	return active;
}

/** Non-negative modulo so up/left scans wrap from the first cell to the last. */
function modulo(value: number, size: number): number {
	return ((value % size) + size) % size;
}
