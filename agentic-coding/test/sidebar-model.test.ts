// Workspace sidebar projection tests (integrated-multiplexer sidebar): the pure
// list/filter/geometry logic behind the shell's sidebar panel. Renderer-free, so
// the semantics — active-by-default filtering, stable ordering, edge-clipped
// labels, panel directions — are pinned without a terminal.
import { describe, expect, test } from "bun:test";
import type { WorkflowOverview } from "../src/contracts/workflow.ts";
import {
	clip,
	clipMetaSegments,
	cycleCursor,
	cycleFilter,
	DEFAULT_SIDEBAR_FILTER,
	filterOverviews,
	isCustomDefinition,
	isOrchestratorStarted,
	isReviewStep,
	isRunningStatus,
	SIDEBAR_FILTERS,
	SIDEBAR_HOME_PINS,
	SIDEBAR_OPENCODE_PIN,
	SIDEBAR_ORCHESTRATOR_PIN,
	sidebarCollapsedRow,
	sidebarCursorCount,
	sidebarCursorForWorkflow,
	sidebarIndexFor,
	sidebarPhaseSignal,
	sidebarStatusGlyph,
	sidebarStatusNeedsReader,
	sidebarWorkflowIndex,
	workflowMeta,
	workflowProjectName,
	workflowRowLabel,
	workflowStageMeta,
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
	definitionOrigin?: WorkflowOverview["state"]["definitionOrigin"];
	verification?: WorkflowOverview["verification"];
	tasks?: [number, number];
	agents?: WorkflowOverview["agents"];
}): WorkflowOverview {
	return {
		target: options.repository ?? "/repo",
		...(options.startedBy ? { startedBy: options.startedBy } : {}),
		...(options.verification ? { verification: options.verification } : {}),
		state: {
			workflowId: options.workflowId,
			changeId: "",
			phase: options.phase ?? "apply",
			...(options.stepId ? { stepId: options.stepId } : {}),
			...(options.definitionOrigin
				? { definitionOrigin: options.definitionOrigin }
				: {}),
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
		tasks: options.tasks ?? [0, 0],
		...(options.projectIdent ? { projectIdent: options.projectIdent } : {}),
		agents: options.agents ?? [],
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

describe("workspace sidebar pinned entries", () => {
	test("names the Orchestrator and OpenCode and carries their marks", () => {
		expect(SIDEBAR_ORCHESTRATOR_PIN.label).toBe("Orchestrator");
		// The same mark an orchestrator-started workflow row carries.
		expect(SIDEBAR_ORCHESTRATOR_PIN.glyph).toBe("⌂");
		expect(SIDEBAR_ORCHESTRATOR_PIN.page).toBe("orchestrator");
		expect(SIDEBAR_OPENCODE_PIN.label).toBe("OpenCode");
		expect(SIDEBAR_OPENCODE_PIN.glyph).toBe("󱚞");
		expect(SIDEBAR_OPENCODE_PIN.page).toBe("opencode");
		expect(SIDEBAR_HOME_PINS).toEqual([
			SIDEBAR_ORCHESTRATOR_PIN,
			SIDEBAR_OPENCODE_PIN,
		]);
	});

	test("leads the cursor space, shifting every workflow row by the pin count", () => {
		// No pin: the cursor space is exactly the workflow rows.
		expect(sidebarCursorCount(3, 0)).toBe(3);
		expect(sidebarWorkflowIndex(0, 0)).toBe(0);
		expect(sidebarCursorForWorkflow(2, 0)).toBe(2);

		// One pin: it wins the first slot, so workflow 0 sits at cursor 1 and
		// the pin itself names no workflow (-1).
		expect(sidebarCursorCount(0, 1)).toBe(1);
		expect(sidebarCursorCount(3, 1)).toBe(4);
		expect(sidebarWorkflowIndex(0, 1)).toBe(-1);
		expect(sidebarWorkflowIndex(1, 1)).toBe(0);
		expect(sidebarWorkflowIndex(2, 1)).toBe(1);
		expect(sidebarCursorForWorkflow(0, 1)).toBe(1);
		expect(sidebarCursorForWorkflow(2, 1)).toBe(3);
		// The reveal mapping round-trips, so a pin never steals a row's slot.
		expect(sidebarWorkflowIndex(sidebarCursorForWorkflow(2, 1), 1)).toBe(2);

		// Two Home pins shift every workflow row by two.
		expect(sidebarCursorCount(3, 2)).toBe(5);
		expect(sidebarWorkflowIndex(0, 2)).toBe(-2);
		expect(sidebarWorkflowIndex(1, 2)).toBe(-1);
		expect(sidebarWorkflowIndex(2, 2)).toBe(0);
		expect(sidebarCursorForWorkflow(0, 2)).toBe(2);
		expect(sidebarWorkflowIndex(sidebarCursorForWorkflow(2, 2), 2)).toBe(2);
	});
});

describe("workspace sidebar cycle", () => {
	test("wraps at both ends and never leaves the cursor space", () => {
		// Three entries: forward walks 0→1→2→0, backward 0→2→1→0.
		expect(cycleCursor(0, 3, 1)).toBe(1);
		expect(cycleCursor(1, 3, 1)).toBe(2);
		expect(cycleCursor(2, 3, 1)).toBe(0);
		expect(cycleCursor(0, 3, -1)).toBe(2);
		expect(cycleCursor(2, 3, -1)).toBe(1);
		expect(cycleCursor(1, 3, -1)).toBe(0);
	});

	test("a step longer than the space still lands inside it", () => {
		expect(cycleCursor(0, 3, 5)).toBe(2);
		expect(cycleCursor(0, 3, -5)).toBe(1);
		expect(cycleCursor(0, 3, 3)).toBe(0);
	});

	test("the pinned pages keep the cycle in their cursor space with no workflows", () => {
		// No workflows under the filter: the two pins are the whole cursor space.
		expect(cycleCursor(0, 2, 1)).toBe(1);
		expect(cycleCursor(1, 2, 1)).toBe(0);
		expect(cycleCursor(0, 2, -1)).toBe(1);
		expect(cycleCursor(1, 2, -1)).toBe(0);
	});

	test("an empty cursor space has nowhere to go", () => {
		// No pin and no rows: the cycle stays put instead of inventing a row.
		expect(cycleCursor(3, 0, 1)).toBe(0);
		expect(cycleCursor(0, 0, -1)).toBe(0);
	});

	test("a position left outside the space clamps before stepping", () => {
		// A poll or a filter change can shrink the list under the cursor; the
		// cycle must not step from a position that no longer exists.
		expect(cycleCursor(9, 3, 1)).toBe(0);
		expect(cycleCursor(9, 3, -1)).toBe(1);
		expect(cycleCursor(-4, 3, -1)).toBe(2);
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

	test("the stage line colour-codes verification findings and verifier progress", () => {
		const row = overview({
			workflowId: "wf",
			status: "active",
			phase: "Verification",
			stepId: "core.verification",
			verification: {
				findings: { critical: 0, warning: 1, info: 3 },
				completedVerifiers: 3,
				totalVerifiers: 7,
				runningVerifiers: 2,
				failed: true,
			},
		});
		expect(
			workflowStageMeta(row).map(({ text, tone }) => [text, tone]),
		).toEqual([
			["Verification", "info"],
			[" · ", "muted"],
			["0", "error"],
			[" ", "muted"],
			["1", "warning"],
			[" ", "muted"],
			["3", "info"],
			[" · ", "muted"],
			["3", "error"],
			["/7", "muted"],
			["✓", "muted"],
		]);
	});

	test("a completed verification marks its verifier progress successful", () => {
		const row = overview({
			workflowId: "wf",
			status: "active",
			phase: "Verification",
			stepId: "core.verification",
			verification: {
				findings: { critical: 0, warning: 0, info: 0 },
				completedVerifiers: 7,
				totalVerifiers: 7,
				runningVerifiers: 0,
				failed: false,
			},
		});
		expect(
			workflowStageMeta(row)
				.slice(-3)
				.map(({ text, tone }) => [text, tone]),
		).toEqual([
			["7", "success"],
			["/7", "muted"],
			["✓", "success"],
		]);
	});

	test("the stage line keeps task progress outside verification", () => {
		expect(
			workflowStageMeta(
				overview({
					workflowId: "wf",
					status: "active",
					phase: "Apply",
					tasks: [3, 7],
				}),
			).map(({ text, tone }) => [text, tone]),
		).toEqual([
			["Apply", "info"],
			[" · ", "muted"],
			["3/7 tasks", "muted"],
		]);
		expect(
			workflowStageMeta(
				overview({
					workflowId: "wf",
					status: "active",
					phase: "Apply",
					tasks: [7, 7],
				}),
			).at(-1),
		).toEqual({ text: "7/7 tasks", tone: "success" });
	});

	test("the project line keeps the last path segment", () => {
		expect(
			workflowProjectName(
				overview({
					workflowId: "wf",
					status: "active",
					repository: "/work/project-name",
				}),
			),
		).toBe("project-name");
		expect(
			workflowProjectName(
				overview({
					workflowId: "wf",
					status: "active",
					repository: "/work/project-name",
					projectIdent: "catalog-ident",
				}),
			),
		).toBe("catalog-ident");
	});

	test("clipping a coloured stage line keeps every surviving segment's tone", () => {
		const row = overview({
			workflowId: "wf",
			status: "active",
			phase: "Verification",
			stepId: "core.verification",
			verification: {
				findings: { critical: 0, warning: 1, info: 3 },
				completedVerifiers: 3,
				totalVerifiers: 7,
				runningVerifiers: 2,
				failed: true,
			},
		});
		expect(
			clipMetaSegments(workflowStageMeta(row), 24).map(({ text, tone }) => [
				text,
				tone,
			]),
		).toEqual([
			["Verification", "info"],
			[" · ", "muted"],
			["0", "error"],
			[" ", "muted"],
			["1", "warning"],
			[" ", "muted"],
			["3", "info"],
			[" · ", "muted"],
			["3", "error"],
		]);
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

	test("custom-definition rows carry a shape mark beside the Home marker", () => {
		expect(
			isCustomDefinition(
				overview({
					workflowId: "shaped",
					status: "active",
					definitionOrigin: { kind: "custom", origin: "blueprint" },
				}),
			),
		).toBe(true);
		// A built-in definition and a row from before the projection existed are
		// both unmarked: nothing is drawn that was not recorded.
		expect(
			isCustomDefinition(
				overview({
					workflowId: "built-in",
					status: "active",
					definitionOrigin: { kind: "built-in" },
				}),
			),
		).toBe(false);
		expect(
			isCustomDefinition(overview({ workflowId: "plain", status: "active" })),
		).toBe(false);
		expect(
			workflowRowLabel(
				overview({
					workflowId: "shaped",
					status: "active",
					definitionOrigin: { kind: "custom", origin: "operator" },
				}),
			),
		).toBe("◊ shaped");
		// A custom shape the orchestrator started carries both glyphs, still a
		// useable label inside the row's clip budget.
		expect(
			workflowRowLabel(
				overview({
					workflowId: "shaped",
					status: "active",
					startedBy: "orchestrator",
					definitionOrigin: { kind: "custom", origin: "blueprint" },
				}),
			),
		).toBe("⌂ ◊ shaped");
		expect(
			clip(
				workflowRowLabel(
					overview({
						workflowId: "a-very-long-shaped-id",
						status: "active",
						definitionOrigin: { kind: "custom", origin: "blueprint" },
					}),
				),
				12,
			),
		).toBe("◊ a-very-lo…");
	});

	test("a verifying row's phase signal counts the verifiers still running", () => {
		const row = overview({
			workflowId: "wf",
			status: "active",
			phase: "Verification",
			stepId: "core.verification",
			verification: {
				findings: { critical: 3, warning: 1, info: 3 },
				completedVerifiers: 3,
				totalVerifiers: 7,
				runningVerifiers: 2,
				failed: true,
			},
		});
		expect(sidebarPhaseSignal(row)).toEqual({ text: "2", tone: "error" });
		expect(
			sidebarPhaseSignal(
				overview({
					workflowId: "clean",
					status: "active",
					phase: "Verification",
					stepId: "core.verification",
					verification: {
						findings: { critical: 0, warning: 0, info: 0 },
						completedVerifiers: 7,
						totalVerifiers: 7,
						runningVerifiers: 0,
						failed: false,
					},
				}),
			),
		).toEqual({ text: "0", tone: "success" });
		expect(
			sidebarPhaseSignal(
				overview({
					workflowId: "busy",
					status: "active",
					phase: "Verification",
					stepId: "core.verification",
					verification: {
						findings: { critical: 0, warning: 0, info: 0 },
						completedVerifiers: 0,
						totalVerifiers: 12,
						runningVerifiers: 12,
						failed: false,
					},
				}),
			),
		).toEqual({ text: "+", tone: "info" });
	});

	test("other phases pick one phase-specific character", () => {
		// Task-backed stages show what still has to be done.
		expect(
			sidebarPhaseSignal(
				overview({
					workflowId: "impl",
					status: "active",
					phase: "Implementation",
					tasks: [3, 7],
				}),
			),
		).toEqual({ text: "4", tone: "info" });
		expect(
			sidebarPhaseSignal(
				overview({
					workflowId: "done-tasks",
					status: "active",
					phase: "Implementation",
					tasks: [7, 7],
				}),
			),
		).toEqual({ text: "0", tone: "success" });
		// A review/approval asks for a reader rather than a progress count.
		expect(
			sidebarPhaseSignal(
				overview({
					workflowId: "review",
					status: "active",
					stepId: "core.developer-review",
					tasks: [7, 7],
				}),
			),
		).toEqual({ text: "?", tone: "warning" });
		// A stage with no task list falls back to its live agent count.
		expect(
			sidebarPhaseSignal(
				overview({
					workflowId: "agents",
					status: "active",
					agents: [
						{ role: "worker", status: "working" },
						{ role: "audit", status: "completed" },
					],
				}),
			),
		).toEqual({ text: "1", tone: "info" });
		// Quiet terminal rows have nothing left to report.
		expect(
			sidebarPhaseSignal(overview({ workflowId: "done", status: "completed" })),
		).toEqual({ text: "·", tone: "muted" });
	});

	test("the collapsed strip row stacks the index, glyph and phase signal", () => {
		expect(
			sidebarCollapsedRow(
				overview({ workflowId: "a", status: "active" }),
				0,
				4,
			),
		).toEqual({
			index: "1",
			glyph: "…",
			tone: "info",
			needsReader: false,
			signal: { text: "·", tone: "muted" },
		});
		expect(
			sidebarCollapsedRow(
				overview({
					workflowId: "q",
					status: "attention-required",
					pendingQuestions: 1,
				}),
				2,
				4,
			),
		).toEqual({
			index: "3",
			glyph: "?",
			tone: "warning",
			needsReader: true,
			signal: { text: "·", tone: "muted" },
		});
		// The review gate and the completed workflow share the `✓`, so the tone —
		// and the emphasis it drives — is what tells "waiting for a reader" from
		// "done"; the phase line adds the review marker.
		expect(
			sidebarCollapsedRow(
				overview({
					workflowId: "r",
					status: "active",
					stepId: "core.developer-review",
				}),
				0,
				4,
			),
		).toEqual({
			index: "1",
			glyph: "✓",
			tone: "info",
			needsReader: true,
			signal: { text: "?", tone: "warning" },
		});
		expect(
			sidebarCollapsedRow(
				overview({ workflowId: "d", status: "completed" }),
				0,
				4,
			),
		).toEqual({
			index: "1",
			glyph: "✓",
			tone: "success",
			needsReader: false,
			signal: { text: "·", tone: "muted" },
		});
	});

	test("a collapsed row clips only its position to the strip width", () => {
		// A list long enough to outgrow the strip loses the tail of its index,
		// never the mark below it.
		expect(
			sidebarCollapsedRow(
				overview({ workflowId: "a", status: "active" }),
				9999,
				4,
			),
		).toEqual({
			index: "100…",
			glyph: "…",
			tone: "info",
			needsReader: false,
			signal: { text: "·", tone: "muted" },
		});
		expect(
			sidebarCollapsedRow(
				overview({ workflowId: "a", status: "active" }),
				0,
				0,
			),
		).toEqual({
			index: "",
			glyph: "…",
			tone: "info",
			needsReader: false,
			signal: { text: "·", tone: "muted" },
		});
	});

	test("a state waiting on a reader is marked for emphasis", () => {
		expect(
			sidebarStatusNeedsReader(overview({ workflowId: "a", status: "active" })),
		).toBe(false);
		expect(
			sidebarStatusNeedsReader(
				overview({
					workflowId: "q",
					status: "attention-required",
					pendingQuestions: 1,
				}),
			),
		).toBe(true);
		expect(
			sidebarStatusNeedsReader(
				overview({
					workflowId: "b",
					status: "attention-required",
					attention: ["retry limit reached"],
				}),
			),
		).toBe(true);
		expect(
			sidebarStatusNeedsReader(
				overview({ workflowId: "i", status: "active", valid: false }),
			),
		).toBe(true);
		expect(
			sidebarStatusNeedsReader(
				overview({
					workflowId: "r",
					status: "active",
					stepId: "core.developer-review",
				}),
			),
		).toBe(true);
		expect(
			sidebarStatusNeedsReader(overview({ workflowId: "p", status: "paused" })),
		).toBe(false);
		expect(
			sidebarStatusNeedsReader(
				overview({ workflowId: "d", status: "completed" }),
			),
		).toBe(false);
		// Diagnostic notes on a running workflow are not a request for the
		// developer: the glyph stays the running ellipsis and so does the emphasis.
		expect(
			sidebarStatusNeedsReader(
				overview({
					workflowId: "impl",
					status: "active",
					stepId: "core.implementation",
					attention: ["stage gate skipped tests (policy always)"],
				}),
			),
		).toBe(false);
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
