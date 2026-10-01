import { describe, expect, test } from "bun:test";
import {
	AGENTS_PANEL,
	CHANGE_PANEL,
	CLASSIFIER_PANEL,
	movePanel,
	OPENSPEC_PANEL,
	type PanelDirection,
	type PanelId,
} from "../../src/tui/dash/panel-grid.ts";

type Row = Record<PanelDirection, PanelId>;

/** Transition tables from the design: design.md → section `### 2.`, with the
 * Classifications cell always occupied (its empty state is the panel) and only
 * the OpenSpec cell conditional. */
const WITHOUT_ARTIFACTS: Record<PanelId, Row> = {
	[CHANGE_PANEL]: {
		down: CLASSIFIER_PANEL,
		up: CLASSIFIER_PANEL,
		left: AGENTS_PANEL,
		right: AGENTS_PANEL,
	},
	[CLASSIFIER_PANEL]: {
		down: CHANGE_PANEL,
		up: CHANGE_PANEL,
		left: AGENTS_PANEL,
		right: AGENTS_PANEL,
	},
	[AGENTS_PANEL]: {
		down: AGENTS_PANEL,
		up: AGENTS_PANEL,
		left: CHANGE_PANEL,
		right: CHANGE_PANEL,
	},
};

const DIRECTIONS: PanelDirection[] = ["down", "up", "left", "right"];

describe("movePanel with open-spec artifacts listed", () => {
	const table: Record<PanelId, Row> = {
		[CHANGE_PANEL]: {
			down: OPENSPEC_PANEL,
			up: CLASSIFIER_PANEL,
			left: AGENTS_PANEL,
			right: AGENTS_PANEL,
		},
		[OPENSPEC_PANEL]: {
			down: CLASSIFIER_PANEL,
			up: CHANGE_PANEL,
			left: AGENTS_PANEL,
			right: AGENTS_PANEL,
		},
		[CLASSIFIER_PANEL]: {
			down: CHANGE_PANEL,
			up: OPENSPEC_PANEL,
			left: AGENTS_PANEL,
			right: AGENTS_PANEL,
		},
		[AGENTS_PANEL]: {
			down: AGENTS_PANEL,
			up: AGENTS_PANEL,
			left: CHANGE_PANEL,
			right: CHANGE_PANEL,
		},
	};
	for (const [from, moves] of Object.entries(table)) {
		for (const direction of DIRECTIONS) {
			test(`${from} + ${direction} → ${moves[direction]}`, () => {
				expect(
					movePanel(Number(from), direction, { artifactsVisible: true }),
				).toBe(moves[direction]);
			});
		}
	}
});

describe("movePanel without open-spec artifacts", () => {
	for (const [from, table] of Object.entries(WITHOUT_ARTIFACTS)) {
		for (const direction of DIRECTIONS) {
			test(`${from} + ${direction} → ${table[direction]}`, () => {
				expect(
					movePanel(Number(from), direction, { artifactsVisible: false }),
				).toBe(table[direction]);
			});
		}
	}
});

describe("movePanel stale focus on a hidden panel", () => {
	// Only OpenSpec can be hidden; Classifications is rendered everywhere.
	test("OpenSpec loses a panel while focused: any move lands on a rendered panel", () => {
		expect(movePanel(OPENSPEC_PANEL, "down", { artifactsVisible: false })).toBe(
			CLASSIFIER_PANEL,
		);
		expect(movePanel(OPENSPEC_PANEL, "up", { artifactsVisible: false })).toBe(
			CHANGE_PANEL,
		);
		expect(movePanel(OPENSPEC_PANEL, "left", { artifactsVisible: false })).toBe(
			AGENTS_PANEL,
		);
		expect(
			movePanel(OPENSPEC_PANEL, "right", { artifactsVisible: false }),
		).toBe(AGENTS_PANEL);
	});
});
