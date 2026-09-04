import { describe, expect, test } from "bun:test";
import {
	AGENTS_PANEL,
	CHANGE_PANEL,
	movePanel,
	OPENSPEC_PANEL,
	type PanelDirection,
	type PanelId,
} from "../../src/tui/dash/panel-grid";

type Row = Record<PanelDirection, PanelId>;

/** Transition tables from the design: design.md → section `### 2.`. */
const WITH_ARTIFACTS: Record<PanelId, Row> = {
	[CHANGE_PANEL]: {
		down: OPENSPEC_PANEL,
		up: OPENSPEC_PANEL,
		left: AGENTS_PANEL,
		right: AGENTS_PANEL,
	},
	[OPENSPEC_PANEL]: {
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

const WITHOUT_ARTIFACTS: Record<PanelId, Row> = {
	[CHANGE_PANEL]: {
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
	for (const [from, table] of Object.entries(WITH_ARTIFACTS)) {
		for (const direction of DIRECTIONS) {
			test(`${from} + ${direction} → ${table[direction]}`, () => {
				expect(
					movePanel(Number(from), direction, { artifactsVisible: true }),
				).toBe(table[direction]);
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
	test("OpenSpec loses a panel while focused: any move lands on a rendered panel", () => {
		expect(movePanel(OPENSPEC_PANEL, "down", { artifactsVisible: false })).toBe(
			CHANGE_PANEL,
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
