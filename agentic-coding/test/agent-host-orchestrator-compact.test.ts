// The compact result contract of the orchestrator's workflow-management tools
// (efficiency backlog items 4 and 5). The fixture is deliberately realistic:
// 30 workflows carrying the 4 KB task text, three runs and five gate decisions
// each — the fields the default projections leave out — so the byte assertions
// measure the projection, not an empty shape.
import { describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { summarizeWorkflowView } from "../src/agent-host/orchestrator.ts";
import {
	cachedBranchRefs,
	compactBranchRefs,
	compactWorkflowStatus,
	compactWorkflowStatusView,
	invalidateBranchCache,
	noteFullDetail,
	pendingQuestionUnion,
	projectAgentConfig,
	projectWorkflowList,
} from "../src/agent-host/orchestrator-compact.ts";

/** One realistic 4 KB task text. */
const TASK =
	"Apply the change, keep the TUI views unchanged, and cover it with focused tests. "
		.repeat(60)
		.slice(0, 4096);

const NOW = "2026-10-16T10:00:00.000Z";
const LATER = "2027-10-16T10:00:00.000Z";

function question(
	workflowId: string,
	id: string,
	targetRole?: string,
): Record<string, unknown> {
	return {
		id,
		workflowId,
		runId: `${workflowId}-run-2`,
		stepId: "core.implementation",
		role: "worker",
		ident: "scope",
		description: "Should the change also cover the CLI path?",
		options: [
			{ value: "yes", label: "Yes" },
			{ value: "no", label: "No" },
		],
		...(targetRole ? { targetRole } : {}),
		status: "pending",
		createdAt: NOW,
		expiresAt: LATER,
	};
}

function workflowFixture(
	index: number,
	status = "active",
): Record<string, unknown> {
	const id = `wf-${String(index).padStart(3, "0")}`;
	return {
		workflowId: id,
		changeId: id,
		revision: 40 + index,
		definition: {
			id: "solo",
			version: 1,
			digest: `digest-${index}`,
			label: "Solo",
		},
		status,
		repository: "/repos/shop",
		worktree: `/repos/shop/.herdr-workflow/${id}`,
		branch: `feature/${id}`,
		baseCommit: "0123456789abcdef0123456789abcdef01234567",
		task: TASK,
		createdAt: NOW,
		updatedAt: NOW,
		selectedPreset: "pi-opencode-go-deepseek-flash",
		startedBy: "orchestrator",
		gatePolicies: { planApproval: "always", developerReview: "always" },
		currentStep: {
			id: "core.implementation",
			label: "Implementation",
			attempt: 1,
			enteredAt: NOW,
		},
		runs: [0, 1, 2].map((run) => ({
			id: `${id}-run-${run}`,
			stepId: "core.implementation",
			role: "worker",
			attempt: run + 1,
			status: "completed",
			runtime: "pi",
			profile: "pi-opencode-go-deepseek-flash",
			model: "opencode-go/deepseek-flash",
		})),
		routing: { defaultProfile: "", routes: [] },
		effects: [
			{
				id: `${id}-effect-1`,
				kind: "agent.run",
				status: "failed",
				attempts: 3,
				lastError: "agent host exited",
			},
		],
		observations: [],
		health: {
			valid: true,
			attention: index % 7 === 0 ? ["run stalled"] : [],
		},
		gateDecisions: [0, 1, 2, 3, 4].map((gate) => ({
			stage: `stage-${gate}`,
			policy: "always",
			decidedBy: "developer",
			at: NOW,
		})),
		pendingQuestions: [
			question(id, `${id}-q1`),
			question(id, `${id}-q2`, "orchestrator"),
		],
		// The routed subset the server repeats: byte-identical records.
		orchestratorQuestions: [question(id, `${id}-q2`, "orchestrator")],
		availableActions: [
			{ id: "resume", label: "Resume", confirmation: "none" },
			{
				id: "retry-effect:1",
				label: "Retry failed effect",
				confirmation: "none",
			},
			{ id: "close", label: "Close workflow", confirmation: "confirm" },
		],
	};
}

function overviewFixture(
	view: Record<string, unknown>,
	startedBy = "orchestrator",
): Record<string, unknown> {
	return {
		state: {
			workflowId: view.workflowId,
			status: view.status,
			stepId: (view.currentStep as { id: string }).id,
			stepLabel: (view.currentStep as { label: string }).label,
			definition: view.definition,
			task: view.task,
			branch: view.branch,
			health: view.health,
			availableActions: view.availableActions,
		},
		target: view.repository,
		startedBy,
		tasks: [3, 8],
		agents: [
			{
				role: "worker",
				status: "completed",
				model: "opencode-go/deepseek-flash",
			},
		],
	};
}

const VIEWS = Array.from({ length: 30 }, (_, index) =>
	// The last five are closed, so the default filter has something to hide.
	workflowFixture(index, index >= 25 ? "closed" : "active"),
);
const OVERVIEWS = VIEWS.map((view) => overviewFixture(view));

/** The bytes one tool result costs the conversation. */
function bytes(value: unknown): number {
	return JSON.stringify(value).length;
}

function median(values: number[]): number {
	const sorted = [...values].sort((a, b) => a - b);
	const middle = Math.floor(sorted.length / 2);
	return sorted.length % 2 === 0
		? (sorted[middle - 1] + sorted[middle]) / 2
		: sorted[middle];
}

describe("compact workflow_status projection", () => {
	test("the default row stays under the median and cap budgets", () => {
		const sizes = VIEWS.map((view) => bytes(compactWorkflowStatusView(view)));
		// Target: median under 2 kB, hard cap 4 kB (backlog item 4; the baseline
		// was 472,527 B over 86 calls, 51,245 B max).
		expect(median(sizes)).toBeLessThan(2_048);
		expect(Math.max(...sizes)).toBeLessThan(4_096);
	});

	test("the compact row carries what the model must act on and drops the rest", () => {
		const row = compactWorkflowStatusView(VIEWS[0]) as Record<string, unknown>;
		expect(row.workflowId).toBe("wf-000");
		expect(row.target).toBe("/repos/shop");
		expect(row.status).toBe("active");
		expect(row.step).toEqual({
			id: "core.implementation",
			label: "Implementation",
		});
		expect(row.revision).toBe(40);
		expect(row.startedBy).toBe("orchestrator");
		// Action ids and labels only.
		expect(row.availableActions).toEqual([
			{ id: "resume", label: "Resume" },
			{ id: "retry-effect:1", label: "Retry failed effect" },
			{ id: "close", label: "Close workflow" },
		]);
		expect(row.failedEffects).toEqual([
			{
				id: "wf-000-effect-1",
				kind: "agent.run",
				attempts: 3,
				lastError: "agent host exited",
			},
		]);
		// The current run, in one short row.
		expect(row.run).toEqual({
			role: "worker",
			status: "completed",
			model: "opencode-go/deepseek-flash",
		});
		// The expensive fields are gone by default.
		expect(row.task).toBeUndefined();
		expect(row.runs).toBeUndefined();
		expect(row.gateDecisions).toBeUndefined();
		expect(row.worktree).toBeUndefined();
		expect(row.availableActions).not.toContainEqual(
			expect.objectContaining({ confirmation: "confirm" }),
		);
		// The text is opt-in and then present.
		const withTask = compactWorkflowStatusView(VIEWS[0], {
			includeTask: true,
		}) as Record<string, unknown>;
		expect(withTask.task).toBe(TASK);
		expect(bytes(withTask)).toBeGreaterThan(bytes(row));
	});

	test("routed questions stay visible in pendingQuestions and are not duplicated", () => {
		const view = VIEWS[0];
		// The server repeats the routed question byte-identically in both arrays.
		expect(view.orchestratorQuestions).toEqual([
			(view.pendingQuestions as unknown[])[1],
		]);
		const row = compactWorkflowStatusView(view) as Record<string, unknown>;
		expect(row.orchestratorQuestions).toBeUndefined();
		expect(
			(row.pendingQuestions as Array<{ id: string }>).map((q) => q.id),
		).toEqual(["wf-000-q1", "wf-000-q2"]);
		// The routed record keeps its marker, so it is still answerable.
		expect(
			(row.pendingQuestions as Array<{ targetRole?: string }>).map(
				(q) => q.targetRole,
			),
		).toEqual([undefined, "orchestrator"]);
		const union = pendingQuestionUnion(view);
		expect(union).toHaveLength(2);
		expect(bytes(union)).toBeLessThan(
			bytes(view.pendingQuestions) + bytes(view.orchestratorQuestions),
		);
	});

	test("an unchanged revision answers in a few bytes", () => {
		const view = VIEWS[0];
		const unchanged = compactWorkflowStatus(view, {
			sinceRevision: view.revision as number,
		}) as Record<string, unknown>;
		expect(unchanged).toEqual({
			unchanged: true,
			revision: 40,
			status: "active",
			step: { id: "core.implementation", label: "Implementation" },
		});
		expect(bytes(unchanged)).toBeLessThan(160);
		// A stale revision still gets the row.
		const moved = compactWorkflowStatus(view, {
			sinceRevision: (view.revision as number) - 1,
		}) as Record<string, unknown>;
		expect(moved.unchanged).toBeUndefined();
		expect(moved.workflowId).toBe("wf-000");
	});

	test("detail full still returns everything the tool returned before", () => {
		const view = VIEWS[3];
		const full = summarizeWorkflowView(view) as Record<string, unknown>;
		// Every field of the original projection, in one place or the other.
		for (const field of [
			"workflowId",
			"revision",
			"workflowType",
			"status",
			"currentStep",
			"repository",
			"worktree",
			"branch",
			"task",
			"preset",
			"startedBy",
			"gatePolicies",
			"health",
			"availableActions",
			"pendingQuestions",
			"runs",
			"failedEffects",
			"gateDecisions",
		])
			expect(full).toHaveProperty(field);
		expect(full.task).toBe(TASK);
		expect(full.runs).toHaveLength(3);
		expect(full.gateDecisions).toHaveLength(5);
		expect(full.workflowType).toBe("solo");
		expect(full.preset).toBe("pi-opencode-go-deepseek-flash");
		// `orchestratorQuestions` is gone as a second array; every routed and
		// pending question is still there, once, with its routing marker.
		expect(full.orchestratorQuestions).toBeUndefined();
		expect(
			(full.pendingQuestions as Array<{ id: string; targetRole?: string }>).map(
				(q) => [q.id, q.targetRole],
			),
		).toEqual([
			["wf-003-q1", undefined],
			["wf-003-q2", "orchestrator"],
		]);
		const questions = (full.pendingQuestions as Array<{ id: string }>).map(
			(q) => q.id,
		);
		for (const record of [
			...(view.pendingQuestions as Array<{ id: string }>),
			...(view.orchestratorQuestions as Array<{ id: string }>),
		])
			expect(questions).toContain(record.id);
		expect(bytes(full)).toBeGreaterThan(4_096);
	});
});

describe("compact list_workflows rows", () => {
	test("five active rows fit the budget and each further row is bounded", () => {
		const five = projectWorkflowList(OVERVIEWS.slice(0, 5));
		const fiveBytes = bytes(five);
		expect(five).toHaveLength(5);
		expect(fiveBytes).toBeLessThan(2_048);
		const all = projectWorkflowList(OVERVIEWS);
		expect(all).toHaveLength(25);
		const marginal = (bytes(all) - fiveBytes) / (all.length - five.length);
		// The row's own fields are the contract; the planning figure was ~100 B
		// per row and the JSON keys add their own overhead on top of it.
		expect(marginal).toBeLessThan(200);
	});

	test("a row carries the identifier the other tools take", () => {
		const row = projectWorkflowList(OVERVIEWS)[0] as Record<string, unknown>;
		expect(row).toEqual({
			workflowId: "wf-000",
			target: "/repos/shop",
			workflowType: "solo",
			status: "active",
			step: "Implementation",
			branch: "feature/wf-000",
			startedBy: "orchestrator",
			attention: 1,
		});
		// Attention is a count, never the text.
		expect(typeof row.attention).toBe("number");
		expect(row.task).toBeUndefined();
		expect(row.agents).toBeUndefined();
		expect(row.availableActions).toBeUndefined();
	});

	test("closed workflows are hidden by default and the filter can widen or narrow", () => {
		expect(projectWorkflowList(OVERVIEWS)).toHaveLength(25);
		expect(projectWorkflowList(OVERVIEWS, { status: "all" })).toHaveLength(30);
		expect(projectWorkflowList(OVERVIEWS, { status: "closed" })).toHaveLength(
			5,
		);
		expect(
			projectWorkflowList(OVERVIEWS, { status: "completed" }),
		).toHaveLength(0);
		expect(projectWorkflowList(OVERVIEWS, { status: "active" })).toHaveLength(
			25,
		);
		expect(
			projectWorkflowList(OVERVIEWS, { status: "attention" }),
		).toHaveLength(0);
		// A paused workflow is still the developer's live work.
		const paused = overviewFixture(workflowFixture(31));
		(paused.state as Record<string, unknown>).status = "paused";
		expect(projectWorkflowList([paused])).toHaveLength(1);
		expect(projectWorkflowList([paused], { status: "active" })).toHaveLength(1);
		expect(projectWorkflowList([paused], { status: "completed" })).toHaveLength(
			0,
		);
	});

	test("detail full restores the task text, attention text, actions and agents", () => {
		const full = projectWorkflowList(OVERVIEWS, {
			status: "all",
			detail: "full",
		}) as Array<Record<string, unknown>>;
		expect(full).toHaveLength(30);
		expect(full[0].task).toBe(TASK);
		expect(full[0].attention).toEqual(["run stalled"]);
		expect(full[0].availableActions).toHaveLength(3);
		expect(full[0].agents).toHaveLength(1);
		expect(bytes(full)).toBeGreaterThan(bytes(projectWorkflowList(OVERVIEWS)));
	});
});

describe("compact list_agent_config", () => {
	const agents = {
		default_profile: "pi-opencode-go-deepseek-flash",
		profiles: {
			"pi-opencode-go-deepseek-flash": {
				runtime: "pi",
				model: "deepseek-flash",
			},
		},
		presets: { "cheap-medium": { description: "the pool", pools: [] } },
		gates: { developerReview: "always" },
	};

	test("a repository read is names by default and tables with detail full", () => {
		const compact = projectAgentConfig(agents, { repository: "/repos/shop" });
		expect(compact).toEqual({
			defaultProfile: "pi-opencode-go-deepseek-flash",
			profiles: ["pi-opencode-go-deepseek-flash"],
			presets: ["cheap-medium"],
			gates: { developerReview: "always" },
		});
		expect(bytes(compact)).toBeLessThan(bytes(agents));
		const full = projectAgentConfig(agents, {
			repository: "/repos/shop",
			detail: "full",
		});
		expect(full.profiles).toEqual(agents.profiles);
		expect(full.presets).toEqual(agents.presets);
		// Without a repository the read is the user-level configuration the tool
		// always returned.
		expect(projectAgentConfig(agents).profiles).toEqual(agents.profiles);
	});
});

describe("list_branches result and its short-lived cache", () => {
	test("identical calls reuse one answer until a start invalidates it", async () => {
		const repo = `/repos/cache-${Date.now()}-${Math.random()}`;
		const refs = {
			current: "main",
			local: ["main"],
			remote: ["origin/main"],
			default: "origin/main",
		};
		let loads = 0;
		const load = async () => {
			loads += 1;
			return refs;
		};
		const first = await cachedBranchRefs(repo, load);
		const second = await cachedBranchRefs(repo, load);
		expect(loads).toBe(1);
		expect(second).toEqual(first);
		expect(first).toEqual(compactBranchRefs(refs));
		invalidateBranchCache();
		await cachedBranchRefs(repo, load);
		expect(loads).toBe(2);
	});
});

describe("detail-full usage telemetry", () => {
	test("a full read records one envelope without changing the answer", () => {
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), "orchestrator-detail-"));
		const telemetryPath = path.join(dir, "telemetry.jsonl");
		const env = {
			HERDR_TELEMETRY_PATH: telemetryPath,
			HERDR_RUN_ID: "orchestrator",
			HERDR_ROLE: "orchestrator",
		};
		noteFullDetail(env, "workflow_status");
		const lines = fs
			.readFileSync(telemetryPath, "utf8")
			.trim()
			.split("\n")
			.map((line) => JSON.parse(line) as Record<string, unknown>);
		expect(lines).toHaveLength(1);
		expect(lines[0].event).toBe("orchestrator.detail_full");
		expect(lines[0].tool).toBe("workflow_status");
		expect(lines[0].runId).toBe("orchestrator");
		// No content: the record says only which tool asked for the full view.
		expect(JSON.stringify(lines[0])).not.toContain(TASK.slice(0, 40));
		fs.rmSync(dir, { recursive: true, force: true });
	});
});
