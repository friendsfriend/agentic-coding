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
	isOrchestratorStarted,
	isReviewStep,
	isRunningStatus,
	SIDEBAR_FILTERS,
	sidebarIndexFor,
	sidebarStatusGlyph,
	workflowMeta,
	workflowRowLabel,
} from "../src/tui/otel/app/sidebar-model.ts";

function overview(options: {
	workflowId: string;
	status: WorkflowOverview["state"]["status"];
	phase?: string;
	repository?: string;
	createdAt?: string;
	phaseStartedAt?: string;
	projectIdent?: string;
	pendingQuestions?: number;
	attention?: string[];
	valid?: boolean;
	stepId?: string;
	startedBy?: WorkflowOverview["startedBy"];
}): WorkflowOverview {
	return {
		target: options.repository ?? "/repo",
		...(options.startedBy ? { startedBy: options.startedBy } : {}),
		state: {
			workflowId: options.workflowId,
			changeId: "",
			phase: options.phase ?? "apply",
			...(options.stepId ? { stepId: options.stepId } : {}),
			stepLabel: options.phase ?? "apply",
			revision: 1,
			status: options.status,
			health: {
				valid: options.valid ?? true,
				attention: options.attention ?? [],
			},
			repository: options.repository ?? "/repo",
			worktree: options.repository ?? "/repo",
			branch: "main",
			verificationRound: 0,
			runs: [],
			...(options.pendingQuestions
				? {
						pendingQuestions: Array.from(
							{ length: options.pendingQuestions },
							(_, index) =>
								({
									id: `q-${index}`,
									role: "planner",
									prompt: "?",
								}) as unknown as NonNullable<
									WorkflowOverview["state"]["pendingQuestions"]
								>[number],
						),
					}
				: {}),
			...(options.createdAt ? { createdAt: options.createdAt } : {}),
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

	test("orders newest workflow first with a stable id tiebreak", () => {
		const older = overview({
			workflowId: "older",
			status: "active",
			createdAt: "2024-01-01T00:00:00.000Z",
		});
		const newer = overview({
			workflowId: "newer",
			status: "active",
			createdAt: "2024-06-01T00:00:00.000Z",
		});
		const same = overview({
			workflowId: "aaa",
			status: "active",
			createdAt: "2024-06-01T00:00:00.000Z",
		});
		expect(
			filterOverviews([older, newer, same], "active").map(
				(entry) => entry.state.workflowId,
			),
		).toEqual(["aaa", "newer", "older"]);
	});

	test("phase changes cannot reorder the list", () => {
		const before = overview({
			workflowId: "wf",
			status: "active",
			createdAt: "2024-06-01T00:00:00.000Z",
			phaseStartedAt: "2024-06-02T00:00:00.000Z",
		});
		const after = overview({
			workflowId: "wf",
			status: "active",
			createdAt: "2024-06-01T00:00:00.000Z",
			phaseStartedAt: "2024-07-01T00:00:00.000Z",
		});
		const other = overview({
			workflowId: "other",
			status: "active",
			createdAt: "2024-05-01T00:00:00.000Z",
		});
		expect(
			filterOverviews([other, before], "active").map(
				(entry) => entry.state.workflowId,
			),
		).toEqual(["wf", "other"]);
		expect(
			filterOverviews([other, after], "active").map(
				(entry) => entry.state.workflowId,
			),
		).toEqual(["wf", "other"]);
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

	test("row glyphs name the state that needs a reader", () => {
		// Running is the ellipsis; idle is the hollow bullet.
		expect(
			sidebarStatusGlyph(overview({ workflowId: "a", status: "active" })),
		).toEqual({ glyph: "…", tone: "info" });
		expect(
			sidebarStatusGlyph(overview({ workflowId: "p", status: "paused" })),
		).toEqual({ glyph: "◦", tone: "muted" });
		// A developer question beats the generic blocker.
		expect(
			sidebarStatusGlyph(
				overview({
					workflowId: "q",
					status: "attention-required",
					pendingQuestions: 1,
					attention: ["waiting"],
				}),
			),
		).toEqual({ glyph: "?", tone: "warning" });
		// A blocker is `!`; an invalid workflow is the error tone of the same glyph.
		expect(
			sidebarStatusGlyph(
				overview({
					workflowId: "b",
					status: "attention-required",
					attention: ["retry limit reached"],
				}),
			),
		).toEqual({ glyph: "!", tone: "warning" });
		expect(
			sidebarStatusGlyph(
				overview({ workflowId: "i", status: "active", valid: false }),
			),
		).toEqual({ glyph: "!", tone: "error" });
		// A running implementation keeps the ellipsis even when attention holds
		// diagnostic notes (a skipped gate, a classifier that failed open):
		// attention is not a request for developer input.
		expect(
			sidebarStatusGlyph(
				overview({
					workflowId: "impl",
					status: "active",
					stepId: "core.implementation",
					attention: ["stage gate skipped tests (policy always)"],
				}),
			),
		).toEqual({ glyph: "…", tone: "info" });
		// A blocked review gate still reads as a blocker, not a checkmark.
		expect(
			sidebarStatusGlyph(
				overview({
					workflowId: "blocked-review",
					status: "attention-required",
					stepId: "core.developer-review",
				}),
			),
		).toEqual({ glyph: "!", tone: "warning" });
		// A review step reads as a checkmark even while the workflow is running.
		expect(
			sidebarStatusGlyph(
				overview({
					workflowId: "r",
					status: "active",
					stepId: "core.developer-review",
				}),
			),
		).toEqual({ glyph: "✓", tone: "info" });
		expect(
			sidebarStatusGlyph(overview({ workflowId: "d", status: "completed" })),
		).toEqual({ glyph: "✓", tone: "success" });
		expect(
			sidebarStatusGlyph(overview({ workflowId: "c", status: "closed" })),
		).toEqual({ glyph: "·", tone: "muted" });
		expect(
			sidebarStatusGlyph(overview({ workflowId: "other", status: "weird" })),
		).toEqual({ glyph: "·", tone: "muted" });
	});

	test("review steps are the review/approval/gate/verification stages", () => {
		expect(isReviewStep("core.developer-review")).toBe(true);
		expect(isReviewStep("core.plan-approval")).toBe(true);
		expect(isReviewStep("core.review-gate")).toBe(true);
		expect(isReviewStep("core.wiki-gate")).toBe(true);
		expect(isReviewStep("core.verification")).toBe(true);
		expect(isReviewStep("core.implementation")).toBe(false);
		expect(isReviewStep(undefined)).toBe(false);
	});

	test("orchestrator-started rows carry a Home marker; operator rows do not", () => {
		expect(
			isOrchestratorStarted(
				overview({
					workflowId: "a",
					status: "active",
					startedBy: "orchestrator",
				}),
			),
		).toBe(true);
		expect(
			isOrchestratorStarted(
				overview({
					workflowId: "b",
					status: "active",
					startedBy: "developer",
				}),
			),
		).toBe(false);
		// A row without the attribution (a snapshot from before the field)
		// reads as operator work, so nothing is marked that was not recorded.
		expect(
			isOrchestratorStarted(overview({ workflowId: "c", status: "active" })),
		).toBe(false);
		expect(
			workflowRowLabel(
				overview({
					workflowId: "orchestrated",
					status: "active",
					startedBy: "orchestrator",
				}),
			),
		).toBe("⌂ orchestrated");
		expect(
			workflowRowLabel(
				overview({
					workflowId: "mine",
					status: "active",
					startedBy: "developer",
				}),
			),
		).toBe("mine");
		// The marker is part of the label, so the row's clip budget still holds.
		expect(
			clip(
				workflowRowLabel(
					overview({
						workflowId: "a-very-long-orchestrated-id",
						status: "active",
						startedBy: "orchestrator",
					}),
				),
				12,
			),
		).toBe("⌂ a-very-lo…");
	});

	test("clip never exceeds the budget and keeps short values whole", () => {
		expect(clip("short", 10)).toBe("short");
		expect(clip("0123456789abc", 10)).toBe("012345678…");
		expect(clip("anything", 0)).toBe("");
	});

	test("the open workflow is revealed by id and target", () => {
		const rows = [
			overview({ workflowId: "a", status: "active", repository: "/one" }),
			overview({ workflowId: "b", status: "active", repository: "/two" }),
		];
		expect(sidebarIndexFor(rows, { repo: "/two", workflowId: "b" })).toBe(1);
		// Same id in another store is not the open row.
		expect(sidebarIndexFor(rows, { repo: "/three", workflowId: "b" })).toBe(-1);
		// A filtered-out workflow leaves the cursor alone.
		expect(
			sidebarIndexFor(filterOverviews(rows, "attention"), {
				repo: "/two",
				workflowId: "b",
			}),
		).toBe(-1);
		expect(sidebarIndexFor(rows, undefined)).toBe(-1);
	});
});
