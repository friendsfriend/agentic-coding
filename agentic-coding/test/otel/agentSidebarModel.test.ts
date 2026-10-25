import { expect, test } from "bun:test";
import type { WorkflowOverview } from "../../src/contracts/workflow.ts";
import {
	clampAgentListOffset,
	createAgentSidebarProjector,
	filterAgentSidebarRows,
	projectAgentSidebarRows,
	reconcileAgentSelection,
	shellSidebarWidths,
} from "../../src/tui/otel/app/agent-sidebar-model.ts";

function overview(
	target: string,
	workflowId: string,
	runs: Array<{
		id: string;
		role: string;
		attempt: number;
		status:
			| "pending"
			| "working"
			| "completed"
			| "blocked"
			| "failed"
			| "expired";
		runtime?: string;
		model?: string;
		hostSocket?: string;
		conversationId?: string;
	}>,
): WorkflowOverview {
	return {
		target,
		state: {
			workflowId,
			stepId: "apply",
			stepLabel: "Apply change",
			runs,
		} as WorkflowOverview["state"],
	} as WorkflowOverview;
}

const baseOverview = overview("/repo", "flow-123", [
	{
		id: "implementer-old",
		role: "implementer",
		attempt: 1,
		status: "working",
		runtime: "pi",
		model: "model-a",
	},
	{
		id: "implementer-latest",
		role: "implementer",
		attempt: 2,
		status: "completed",
		runtime: "opencode",
		model: "model-b",
		hostSocket: "/tmp/agent.sock",
		conversationId: "conversation-9",
	},
	{
		id: "reviewer",
		role: "reviewer",
		attempt: 1,
		status: "working",
		runtime: "pi",
	},
	{ id: "git-run", role: "git", attempt: 1, status: "working" },
	{ id: "dashboard-run", role: "dashboard", attempt: 1, status: "pending" },
]);

test("projects latest role runs, excludes utility roles, and preserves recorded session data", () => {
	const rows = projectAgentSidebarRows([baseOverview]);
	expect(rows.map(({ role, runId }) => [role, runId])).toEqual([
		["implementer", "implementer-latest"],
		["reviewer", "reviewer"],
	]);
	expect(rows[0]).toMatchObject({
		runtime: "opencode",
		model: "model-b",
		hostSocket: "/tmp/agent.sock",
		conversationId: "conversation-9",
		workflowStep: "Apply change",
	});
});

test("revision-cached projections skip unchanged histories and evict removed workflows", () => {
	const project = createAgentSidebarProjector();
	const runs = Array.from({ length: 10_000 }, (_, index) => ({
		id: `run-${index}`,
		role: `role-${index % 10}`,
		attempt: index,
		status: "working" as const,
	}));
	const first = overview("/repo", "long-history", runs);
	first.state.revision = 1;
	let scans = 0;
	Object.defineProperty(first.state, "runs", {
		get: () => {
			scans += 1;
			return runs;
		},
	});
	const initial = project([first]);
	expect(initial).toHaveLength(10);
	expect(scans).toBe(1);
	const refreshed = overview("/repo", "long-history", []);
	refreshed.state.revision = 1;
	Object.defineProperty(refreshed.state, "runs", {
		get: () => {
			throw new Error("unchanged history rescanned");
		},
	});
	expect(project([refreshed])).toEqual(initial);
	const changed = overview("/repo", "long-history", [
		{
			...runs[0],
			id: "new-run",
			role: "role-0",
			attempt: 10_001,
			status: "completed",
		},
	]);
	changed.state.revision = 2;
	expect(project([changed]).map((row) => row.runId)).toEqual(["new-run"]);
	expect(project([])).toEqual([]);
	expect(project([first])).toEqual(initial);
	expect(scans).toBe(2);
});

test("Active filters only latest pending/working runs; All keeps terminal states", () => {
	const rows = projectAgentSidebarRows([
		baseOverview,
		overview("/other", "flow-456", [
			{ id: "verifier", role: "verifier", attempt: 1, status: "blocked" },
		]),
	]);
	expect(
		filterAgentSidebarRows(rows, "active").map((row) => row.runId),
	).toEqual(["reviewer"]);
	expect(filterAgentSidebarRows(rows, "all").map((row) => row.runId)).toEqual([
		"verifier",
		"implementer-latest",
		"reviewer",
	]);
});

test("selection survives filters and refreshes while the selected identity exists", () => {
	const sourceRows = projectAgentSidebarRows([baseOverview]);
	const activeRows = filterAgentSidebarRows(sourceRows, "active");
	const selected = { preferredKey: sourceRows[0]?.key, index: 0 };
	const hidden = reconcileAgentSelection({
		selection: selected,
		sourceRows,
		visibleRows: activeRows,
	});
	expect(hidden).toEqual({ preferredKey: sourceRows[0]?.key, index: 0 });
	const restored = reconcileAgentSelection({
		selection: hidden,
		sourceRows,
		visibleRows: sourceRows,
	});
	expect(restored).toEqual(selected);
	const removed = reconcileAgentSelection({
		selection: selected,
		sourceRows: sourceRows.slice(1),
		visibleRows: sourceRows.slice(1),
	});
	expect(removed).toEqual({ preferredKey: sourceRows[1]?.key, index: 0 });
});

test("run identity includes the target store and survives mutable status/model updates", () => {
	const first = projectAgentSidebarRows([baseOverview]);
	const updated = structuredClone(baseOverview);
	const run = updated.state.runs.find(
		(item) => item.id === "implementer-latest",
	);
	if (!run) throw new Error("run fixture missing");
	run.status = "failed";
	run.model = "new-model";
	const next = projectAgentSidebarRows([updated]);
	expect(next.map((item) => item.key)).toEqual(first.map((item) => item.key));
	const otherStore = projectAgentSidebarRows([
		{ ...baseOverview, target: "wiki" },
	]);
	expect(otherStore[0]?.key).not.toBe(first[0]?.key);
	expect(
		reconcileAgentSelection({
			selection: { preferredKey: first[0]?.key, index: 0 },
			sourceRows: [],
			visibleRows: [],
		}),
	).toEqual({ index: -1 });
});

test("list offset clamps independently from the selected identity", () => {
	expect(clampAgentListOffset(7, 10, 4)).toBe(6);
	expect(clampAgentListOffset(-3, 10, 4)).toBe(0);
	expect(clampAgentListOffset(7, 2, 4)).toBe(0);
});

test("panel widths compose at either side and shrink for narrow terminals", () => {
	expect(
		shellSidebarWidths({
			terminalWidth: 60,
			workspaceExpanded: true,
			agentExpanded: true,
		}),
	).toEqual({ workspace: 18, agent: 18 });
	expect(
		shellSidebarWidths({
			terminalWidth: 60,
			workspaceExpanded: false,
			agentExpanded: true,
		}),
	).toEqual({ workspace: 6, agent: 30 });
	const narrow = shellSidebarWidths({
		terminalWidth: 30,
		workspaceExpanded: true,
		agentExpanded: true,
	});
	expect(narrow.workspace + narrow.agent).toBeLessThanOrEqual(30);
});
