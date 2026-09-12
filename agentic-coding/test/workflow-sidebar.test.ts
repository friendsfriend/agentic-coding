// Pure sidebar projection tests (improve-herdr-workflow-sidebar, task 2.5):
// card text and width, duplicate project basenames, new registered gate ids,
// question attribution and partial questionnaires, unknown/live status,
// optional actions, repository-independent targets, and pane reuse.
import { describe, expect, test } from "bun:test";
import type {
	DeveloperDialogueRecord,
	WorkflowView,
} from "../src/workflow/contracts.ts";
import {
	agentViewSetParams,
	INPUT_RANK_NONE,
	INPUT_RANK_REQUIRED,
	INPUT_RANK_UNKNOWN,
	paneInputFacts,
	projectSidebar,
	retainedRequiredPaneIds,
	SIDEBAR_PANE_TOKENS,
	SIDEBAR_WORKSPACE_TOKENS,
	sidebarText,
	standaloneClassifications,
} from "../src/workflow/sidebar.ts";

function question(
	overrides: Partial<DeveloperDialogueRecord>,
): DeveloperDialogueRecord {
	return {
		id: "q1",
		workflowId: "wf",
		runId: "run-1",
		stepId: "core.implementation",
		role: "worker",
		description: "Which approach?",
		options: [],
		status: "pending",
		createdAt: "2026-01-01T00:00:00.000Z",
		expiresAt: "2099-01-01T00:00:00.000Z",
		...overrides,
	};
}

function view(overrides: {
	workflowId?: string;
	repository?: string;
	worktree?: string;
	workspace?: string;
	status?: WorkflowView["status"];
	definitionId?: string;
	stepLabel?: string;
	stepId?: string;
	runs?: Array<{ id: string; role: string; paneId?: string }>;
	actions?: Array<{ id: string; requiresInput?: boolean }>;
	pending?: DeveloperDialogueRecord[];
}): WorkflowView {
	return {
		workflowId: overrides.workflowId ?? "improve-authentication",
		changeId: "improve-authentication",
		revision: 3,
		definition: {
			id: overrides.definitionId ?? "openspec-full",
			version: 1,
			digest: "d",
			label: "Full",
		},
		status: overrides.status ?? "active",
		repository: overrides.repository ?? "/projects/agentic-coding",
		worktree: overrides.worktree ?? "/projects/agentic-coding",
		branch: "feature/x",
		baseCommit: "abc",
		...(overrides.workspace ? { workspace: overrides.workspace } : {}),
		createdAt: "2026-01-01T00:00:00.000Z",
		updatedAt: "2026-01-01T00:00:00.000Z",
		currentStep: {
			id: overrides.stepId ?? "core.implementation",
			label: overrides.stepLabel ?? "Implementation",
			attempt: 1,
			enteredAt: "2026-01-01T00:00:00.000Z",
		},
		runs: (
			overrides.runs ?? [{ id: "run-1", role: "worker", paneId: "w1:p1" }]
		).map((run) => ({
			id: run.id,
			stepId: "core.implementation",
			role: run.role,
			attempt: 1,
			status: "working" as const,
			runtime: "pi",
			profile: "default",
			...(run.paneId ? { paneId: run.paneId } : {}),
		})),
		routing: { defaultProfile: "default", routes: [] },
		effects: [],
		observations: [],
		health: { valid: true, attention: [] },
		pendingQuestions: overrides.pending ?? [],
		availableActions: (overrides.actions ?? []).map((action) => ({
			id: action.id,
			label: action.id,
			confirmation: "confirm" as const,
			...(action.requiresInput ? { requiresInput: true } : {}),
		})),
	};
}

describe("sidebar projection", () => {
	test("renders four one-token rows with fixed tree indentation", () => {
		const publication = projectSidebar({
			views: [view({ workspace: "w1" })],
			observations: [{ paneId: "w1:p1", status: "working", fresh: true }],
			unmanagedPanes: [],
		});
		expect(publication.panes[0]?.tokens).toEqual({
			[SIDEBAR_PANE_TOKENS.project]: "◇ agentic-coding",
			[SIDEBAR_PANE_TOKENS.workflow]: "├─ improve-authentication",
			[SIDEBAR_PANE_TOKENS.role]: "│  worker",
			[SIDEBAR_PANE_TOKENS.status]: "└─ ● working",
			[SIDEBAR_PANE_TOKENS.rank]: INPUT_RANK_NONE,
		});
		expect(publication.workspaces[0]?.tokens).toEqual({
			[SIDEBAR_WORKSPACE_TOKENS.project]: "◇ agentic-coding",
			[SIDEBAR_WORKSPACE_TOKENS.workflow]: "├─ improve-authentication",
			[SIDEBAR_WORKSPACE_TOKENS.kind]: "│  openspec-full",
			[SIDEBAR_WORKSPACE_TOKENS.phase]: "└─ Implementation",
		});
	});

	test("attention toggles in the same cell and never moves the project text", () => {
		const quiet = projectSidebar({
			views: [view({ workspace: "w1" })],
			observations: [{ paneId: "w1:p1", status: "idle", fresh: true }],
			unmanagedPanes: [],
		});
		const owed = projectSidebar({
			views: [view({ workspace: "w1", pending: [question({})] })],
			observations: [{ paneId: "w1:p1", status: "idle", fresh: true }],
			unmanagedPanes: [],
		});
		const quietLine = quiet.panes[0]?.tokens[SIDEBAR_PANE_TOKENS.project] ?? "";
		const owedLine = owed.panes[0]?.tokens[SIDEBAR_PANE_TOKENS.project] ?? "";
		expect(quietLine).toBe("◇ agentic-coding");
		expect(owedLine).toBe("◆ agentic-coding");
		expect(quietLine.length).toBe(owedLine.length);
		expect(owedLine.slice(2)).toBe(quietLine.slice(2));
		for (const token of [
			SIDEBAR_PANE_TOKENS.workflow,
			SIDEBAR_PANE_TOKENS.role,
			SIDEBAR_PANE_TOKENS.status,
		])
			expect(owed.panes[0]?.tokens[token]).toBe(quiet.panes[0]?.tokens[token]);
	});

	test("linked worktree keeps the canonical repository basename", () => {
		const publication = projectSidebar({
			views: [
				view({
					repository: "/projects/agentic-coding",
					worktree: "/projects/agentic-coding-wt-17",
				}),
			],
			observations: [],
			unmanagedPanes: [],
		});
		expect(publication.panes[0]?.tokens[SIDEBAR_PANE_TOKENS.project]).toBe(
			"◇ agentic-coding",
		);
	});

	test("duplicate project basenames stay distinct panes and ranks", () => {
		const publication = projectSidebar({
			views: [
				view({
					workflowId: "alpha",
					repository: "/one/agentic-coding",
					runs: [{ id: "a1", role: "worker", paneId: "w1:p1" }],
					pending: [question({ runId: "a1" })],
				}),
				view({
					workflowId: "beta",
					repository: "/two/agentic-coding",
					runs: [{ id: "b1", role: "worker", paneId: "w2:p1" }],
				}),
			],
			observations: [],
			unmanagedPanes: [],
		});
		const byPane = new Map(
			publication.panes.map((card) => [card.paneId, card]),
		);
		expect(byPane.get("w1:p1")?.tokens[SIDEBAR_PANE_TOKENS.project]).toBe(
			"◆ agentic-coding",
		);
		expect(byPane.get("w2:p1")?.tokens[SIDEBAR_PANE_TOKENS.project]).toBe(
			"◇ agentic-coding",
		);
		expect(byPane.get("w1:p1")?.tokens[SIDEBAR_PANE_TOKENS.rank]).toBe(
			INPUT_RANK_REQUIRED,
		);
		expect(byPane.get("w2:p1")?.tokens[SIDEBAR_PANE_TOKENS.rank]).toBe(
			INPUT_RANK_UNKNOWN,
		);
	});

	test("repository-independent targets use the existing classification", () => {
		const research = view({
			workflowId: "r1",
			repository: "",
			worktree: "/home/me/.config/agentic-coding/wiki/.workflow",
			definitionId: "research",
		});
		const wiki = view({
			workflowId: "w1",
			repository: "",
			worktree: "/tmp/x",
			definitionId: "wiki-comments",
		});
		const standalone = standaloneClassifications([research, wiki]);
		const publication = projectSidebar({
			views: [research, wiki],
			observations: [],
			unmanagedPanes: [],
			standalone,
		});
		expect(publication.panes[0]?.tokens[SIDEBAR_PANE_TOKENS.project]).toBe(
			"◇ Research",
		);
		expect(publication.panes[1]?.tokens[SIDEBAR_PANE_TOKENS.project]).toBe(
			"◇ Wiki",
		);
	});

	test("registered blocking actions fill the workflow marker without an agent", () => {
		const publication = projectSidebar({
			views: [
				view({
					workspace: "w1",
					runs: [],
					stepId: "core.plan-approval",
					stepLabel: "Plan approval",
					actions: [{ id: "approve-plan", requiresInput: true }],
				}),
			],
			observations: [],
			unmanagedPanes: [],
		});
		expect(
			publication.workspaces[0]?.tokens[SIDEBAR_WORKSPACE_TOKENS.phase],
		).toBe("└─ Plan approval");
		expect(
			publication.workspaces[0]?.tokens[SIDEBAR_WORKSPACE_TOKENS.project],
		).toBe("◆ agentic-coding");
		expect(publication.panes).toEqual([]);
	});

	test("an unfamiliar registered gate needs no publisher table entry", () => {
		const publication = projectSidebar({
			views: [
				view({
					workspace: "w1",
					stepId: "core.brand-new-gate",
					stepLabel: "Brand new gate",
					actions: [{ id: "decide", requiresInput: true }],
				}),
			],
			observations: [],
			unmanagedPanes: [],
		});
		expect(
			publication.workspaces[0]?.tokens[SIDEBAR_WORKSPACE_TOKENS.project],
		).toBe("◆ agentic-coding");
		expect(
			publication.workspaces[0]?.tokens[SIDEBAR_WORKSPACE_TOKENS.phase],
		).toBe("└─ Brand new gate");
	});

	test("optional terminal and research actions never fill the marker", () => {
		const publication = projectSidebar({
			views: [
				view({
					status: "completed",
					stepId: "core.completed",
					stepLabel: "Completed",
					runs: [],
					actions: [{ id: "close" }, { id: "create-pr" }],
				}),
				view({
					workflowId: "research",
					definitionId: "research",
					stepId: "core.research",
					runs: [{ id: "r1", role: "researcher", paneId: "w2:p1" }],
					actions: [{ id: "research-follow-up" }],
					workspace: "w2",
				}),
			],
			observations: [{ paneId: "w2:p1", status: "idle", fresh: true }],
			unmanagedPanes: [],
		});
		for (const card of publication.panes)
			expect(card.tokens[SIDEBAR_PANE_TOKENS.project].startsWith("◇")).toBe(
				true,
			);
	});

	test("only the asking run is marked, and its workflow inherits the marker", () => {
		const publication = projectSidebar({
			views: [
				view({
					workspace: "w1",
					runs: [
						{ id: "run-1", role: "worker", paneId: "w1:p1" },
						{ id: "run-2", role: "verifier", paneId: "w1:p2" },
					],
					pending: [question({ runId: "run-2", groupId: "g1" })],
				}),
			],
			observations: [
				{ paneId: "w1:p1", status: "working", fresh: true },
				{ paneId: "w1:p2", status: "idle", fresh: true },
			],
			unmanagedPanes: [],
		});
		const byPane = new Map(
			publication.panes.map((card) => [card.paneId, card]),
		);
		expect(byPane.get("w1:p1")?.tokens[SIDEBAR_PANE_TOKENS.project]).toBe(
			"◇ agentic-coding",
		);
		expect(byPane.get("w1:p2")?.tokens[SIDEBAR_PANE_TOKENS.project]).toBe(
			"◆ agentic-coding",
		);
		expect(
			publication.workspaces[0]?.tokens[SIDEBAR_WORKSPACE_TOKENS.project],
		).toBe("◆ agentic-coding");
	});

	test("a partially answered questionnaire keeps the obligation", () => {
		const remaining = question({ runId: "run-1", groupId: "g1" });
		const publication = projectSidebar({
			views: [view({ workspace: "w1", pending: [remaining] })],
			observations: [{ paneId: "w1:p1", status: "idle", fresh: true }],
			unmanagedPanes: [],
		});
		expect(publication.panes[0]?.tokens[SIDEBAR_PANE_TOKENS.rank]).toBe(
			INPUT_RANK_REQUIRED,
		);
		expect(publication.panes[0]?.tokens[SIDEBAR_PANE_TOKENS.project]).toBe(
			"◆ agentic-coding",
		);
	});

	test("peer questions and historical runs never mark a successor pane", () => {
		const peer = question({ runId: "run-2", targetRole: "verifier" });
		expect(
			paneInputFacts(false, { paneId: "p", status: "idle", fresh: true }),
		).toEqual({ requiresInput: false, unknown: false });
		const publication = projectSidebar({
			views: [
				view({
					workspace: "w1",
					// The persistent pane was reused: the older run asked, the
					// current run did not.
					runs: [
						{ id: "old", role: "worker", paneId: "w1:p1" },
						{ id: "run-1", role: "verifier", paneId: "w1:p1" },
					],
					pending: [question({ runId: "old" })],
				}),
			],
			observations: [{ paneId: "w1:p1", status: "idle", fresh: true }],
			unmanagedPanes: [],
		});
		expect(publication.panes).toHaveLength(1);
		expect(publication.panes[0]?.tokens[SIDEBAR_PANE_TOKENS.role]).toBe(
			"│  verifier",
		);
		expect(publication.panes[0]?.tokens[SIDEBAR_PANE_TOKENS.rank]).toBe(
			INPUT_RANK_NONE,
		);
		expect(peer.targetRole).toBe("verifier");
	});

	test("live blocked observation fills, later fresh state clears", () => {
		const blocked = projectSidebar({
			views: [view({})],
			observations: [{ paneId: "w1:p1", status: "blocked", fresh: true }],
			unmanagedPanes: [],
		});
		expect(blocked.panes[0]?.tokens[SIDEBAR_PANE_TOKENS.project]).toBe(
			"◆ agentic-coding",
		);
		expect(blocked.panes[0]?.tokens[SIDEBAR_PANE_TOKENS.status]).toBe(
			"└─ ◆ blocked (input)",
		);
		const cleared = projectSidebar({
			views: [view({})],
			observations: [{ paneId: "w1:p1", status: "working", fresh: true }],
			unmanagedPanes: [],
		});
		expect(cleared.panes[0]?.tokens[SIDEBAR_PANE_TOKENS.project]).toBe(
			"◇ agentic-coding",
		);
	});

	test("no observation is unknown, never verified idle", () => {
		const publication = projectSidebar({
			views: [view({})],
			observations: [],
			unmanagedPanes: [],
		});
		expect(publication.panes[0]?.tokens[SIDEBAR_PANE_TOKENS.rank]).toBe(
			INPUT_RANK_UNKNOWN,
		);
		expect(publication.panes[0]?.tokens[SIDEBAR_PANE_TOKENS.project]).toBe(
			"◇ agentic-coding",
		);
		expect(publication.panes[0]?.tokens[SIDEBAR_PANE_TOKENS.status]).toBe(
			"└─ ? unknown",
		);
	});

	test("retains a known runtime obligation across a failed read", () => {
		const stale = projectSidebar({
			views: [view({})],
			observations: [{ paneId: "w1:p1", status: "idle", fresh: false }],
			unmanagedPanes: [],
			retainedRequiredPanes: ["w1:p1"],
		});
		expect(stale.panes[0]?.tokens[SIDEBAR_PANE_TOKENS.rank]).toBe(
			INPUT_RANK_REQUIRED,
		);
		expect(stale.panes[0]?.tokens[SIDEBAR_PANE_TOKENS.status]).toBe(
			"└─ ? unknown",
		);
		expect(retainedRequiredPaneIds(stale)).toEqual(["w1:p1"]);
		expect(retainedRequiredPaneIds(stale, ["gone"]).sort()).toEqual([
			"gone",
			"w1:p1",
		]);
	});

	test("unmanaged entries keep native names and no managed sort key", () => {
		const publication = projectSidebar({
			views: [view({ workspace: "w1" })],
			observations: [],
			unmanagedPanes: [
				{
					paneId: "w9:p1",
					workspaceId: "w9",
					label: "scratch",
					status: "working",
					tabLabel: "zsh",
				},
				{
					paneId: "w1:p1",
					workspaceId: "w1",
					label: "shadowed",
					status: "idle",
				},
			],
			unmanagedWorkspaces: [
				{ workspaceId: "w9", label: "scratch-space", status: "blocked" },
			],
		});
		const unmanaged = publication.panes.find((card) => card.paneId === "w9:p1");
		expect(unmanaged?.tokens).toEqual({
			[SIDEBAR_PANE_TOKENS.project]: "scratch",
			[SIDEBAR_PANE_TOKENS.workflow]: "├─ zsh",
			[SIDEBAR_PANE_TOKENS.status]: "└─ working",
		});
		expect(
			publication.panes.some(
				(card) =>
					card.paneId === "w1:p1" && !card.tokens[SIDEBAR_PANE_TOKENS.rank],
			),
		).toBe(false);
		expect(publication.workspaces.map((card) => card.workspaceId)).toEqual([
			"w1",
			"w9",
		]);
		expect(publication.workspaces[1]?.tokens).toEqual({
			ac_project_line: "scratch-space",
			ac_phase_line: "└─ blocked",
		});
	});

	test("clears obsolete managed tokens when an association disappears", () => {
		const publication = projectSidebar({
			views: [view({ workspace: "w1" })],
			observations: [],
			unmanagedPanes: [],
			managedPaneIds: ["w0:p9"],
			managedWorkspaceIds: ["w0"],
		});
		expect(publication.clearedPanes).toEqual([
			{
				targetId: "w0:p9",
				tokens: [
					"ac_project_line",
					"ac_workflow_line",
					"ac_role_line",
					"ac_status_line",
					"ac_input_rank",
				],
			},
		]);
		expect(publication.clearedWorkspaces).toEqual([
			{
				targetId: "w0",
				tokens: [
					"ac_project_line",
					"ac_workflow_line",
					"ac_type_line",
					"ac_phase_line",
				],
			},
		]);
	});

	test("bounded display text drops control characters and never truncates identity", () => {
		expect(sidebarText("ab\u001b[31mc\nd")).toBe("ab [31mc d");
		expect(sidebarText("x".repeat(200)).length).toBe(80);
		const publication = projectSidebar({
			views: [
				view({
					workflowId: `wf-${"y".repeat(120)}`,
					repository: "/projects/agentic-coding",
					stepLabel: "Phase\u0007name",
				}),
			],
			observations: [],
			unmanagedPanes: [],
		});
		expect(
			publication.panes[0]?.tokens[SIDEBAR_PANE_TOKENS.workflow]?.length,
		).toBeLessThanOrEqual(80);
		// Canonical identity is untouched by display truncation.
		expect(publication.panes[0]?.paneId).toBe("w1:p1");
	});

	test("view query sorts by input rank then native topology, with no filter", () => {
		const params = agentViewSetParams();
		expect(params).toEqual({
			source: "agentic-coding",
			label: "input first",
			sort: [
				{ field: { token: "ac_input_rank" }, order: "desc" },
				{ field: "workspace_order", order: "asc" },
				{ field: "tab_order", order: "asc" },
				{ field: "pane_order", order: "asc" },
			],
		});
	});

	test("one space card per workspace, preferring the workflow owing input", () => {
		const publication = projectSidebar({
			views: [
				view({ workflowId: "b", workspace: "w1", runs: [] }),
				view({
					workflowId: "a",
					workspace: "w1",
					runs: [],
					actions: [{ id: "approve-plan", requiresInput: true }],
				}),
			],
			observations: [],
			unmanagedPanes: [],
		});
		expect(publication.workspaces).toHaveLength(1);
		expect(
			publication.workspaces[0]?.tokens[SIDEBAR_WORKSPACE_TOKENS.workflow],
		).toBe("├─ a");
		expect(
			publication.workspaces[0]?.tokens[SIDEBAR_WORKSPACE_TOKENS.project],
		).toBe("◆ agentic-coding");
	});
});
