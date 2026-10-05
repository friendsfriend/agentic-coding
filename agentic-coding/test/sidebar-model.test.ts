// Workspace sidebar projection tests (integrated-multiplexer sidebar): the pure
// list/filter/geometry logic behind the shell's sidebar panel. Renderer-free, so
// the semantics — active-by-default filtering, stable ordering, edge-clipped
// labels, panel directions — are pinned without a terminal.
import { describe, expect, test } from "bun:test";
import type { WorkflowOverview } from "../src/contracts/workflow.ts";
import {
	clip,
	cycleFilter,
	DEFAULT_SIDEBAR_FILTER,
	filterOverviews,
	isRunningStatus,
	SIDEBAR_FILTERS,
	statusGlyph,
	workflowMeta,
} from "../src/tui/otel/app/sidebar-model.ts";

function overview(options: {
	workflowId: string;
	status: WorkflowOverview["state"]["status"];
	phase?: string;
	repository?: string;
	phaseStartedAt?: string;
	projectIdent?: string;
}): WorkflowOverview {
	return {
		target: options.repository ?? "/repo",
		state: {
			workflowId: options.workflowId,
			changeId: "",
			phase: options.phase ?? "apply",
			stepLabel: options.phase ?? "apply",
			revision: 1,
			status: options.status,
			health: { valid: true, attention: [] },
			repository: options.repository ?? "/repo",
			worktree: options.repository ?? "/repo",
			branch: "main",
			verificationRound: 0,
			runs: [],
			...(options.phaseStartedAt
				? { phaseStartedAt: options.phaseStartedAt }
				: {}),
		},
		tasks: [0, 0],
		...(options.projectIdent ? { projectIdent: options.projectIdent } : {}),
		agents: [],
	};
}

describe("workspace sidebar filters", () => {
	test("active is the default and hides completed/closed workflows", () => {
		expect(DEFAULT_SIDEBAR_FILTER).toBe("active");
		const running = overview({ workflowId: "b", status: "active" });
		const attention = overview({
			workflowId: "a",
			status: "attention-required",
		});
		const paused = overview({ workflowId: "p", status: "paused" });
		const finished = overview({ workflowId: "f", status: "completed" });
		const closed = overview({ workflowId: "c", status: "closed" });
		const all = [running, attention, paused, finished, closed];
		expect(isRunningStatus("active")).toBe(true);
		expect(isRunningStatus("completed")).toBe(false);
		expect(
			filterOverviews(all, "active")
				.map((entry) => entry.state.workflowId)
				.sort(),
		).toEqual(["a", "b", "p"]);
		expect(
			filterOverviews(all, "attention").map((entry) => entry.state.workflowId),
		).toEqual(["a"]);
		expect(filterOverviews(all, "all")).toHaveLength(5);
	});

	test("orders most recently touched first with a stable id tiebreak", () => {
		const older = overview({
			workflowId: "older",
			status: "active",
			phaseStartedAt: "2024-01-01T00:00:00.000Z",
		});
		const newer = overview({
			workflowId: "newer",
			status: "active",
			phaseStartedAt: "2024-06-01T00:00:00.000Z",
		});
		const same = overview({
			workflowId: "aaa",
			status: "active",
			phaseStartedAt: "2024-06-01T00:00:00.000Z",
		});
		expect(
			filterOverviews([older, newer, same], "active").map(
				(entry) => entry.state.workflowId,
			),
		).toEqual(["aaa", "newer", "older"]);
	});

	test("cycling walks the catalog and wraps", () => {
		expect(SIDEBAR_FILTERS.map((entry) => entry.id)).toEqual([
			"active",
			"attention",
			"all",
		]);
		expect(cycleFilter("active")).toBe("attention");
		expect(cycleFilter("attention")).toBe("all");
		expect(cycleFilter("all")).toBe("active");
	});
});

describe("workspace sidebar rows", () => {
	test("meta combines the phase label with the project identity", () => {
		expect(
			workflowMeta(
				overview({
					workflowId: "wf",
					status: "active",
					phase: "verify",
					repository: "/work/repo",
					projectIdent: "catalog-ident",
				}),
			),
		).toBe("verify · catalog-ident");
		expect(
			workflowMeta(
				overview({ workflowId: "wf", status: "active", phase: "apply" }),
			),
		).toBe("apply · /repo");
	});

	test("status glyphs cover running, attention and terminal states", () => {
		expect(statusGlyph("active")).toEqual({ glyph: "●", tone: "info" });
		expect(statusGlyph("attention-required")).toEqual({
			glyph: "◆",
			tone: "warning",
		});
		expect(statusGlyph("completed").tone).toBe("success");
		expect(statusGlyph("closed").tone).toBe("muted");
		expect(statusGlyph("something-else").tone).toBe("muted");
	});

	test("clip never exceeds the budget and keeps short values whole", () => {
		expect(clip("short", 10)).toBe("short");
		expect(clip("0123456789abc", 10)).toBe("012345678…");
		expect(clip("anything", 0)).toBe("");
	});
});
