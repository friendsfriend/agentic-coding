import { afterEach, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	costMessages,
	costSummary,
	type DeveloperReviewComment,
	getTaskViewport,
	isStale,
	loadLocalChanges,
	loadLocalDiff,
	loadPlanReviewComments,
	requiredUserActionFor,
	saveDeveloperReview,
	savePlanReview,
	testDashboard,
} from "../../src/tui/dash/data";
import { startArgs } from "../../src/tui/dash/engine";
import { registerBuiltins } from "../../src/workflow/definitions";
import { WorkflowEngine } from "../../src/workflow/runtime";

function requireChange<T extends { newPath: string }>(
	changes: T[],
	newPath: string,
): T {
	const change = changes.find((item) => item.newPath === newPath);
	if (!change) throw new Error(`expected change ${newPath}`);
	return change;
}

const roots: string[] = [];
const runGit = (repo: string, ...args: string[]) =>
	execFileSync("git", args, { cwd: repo, stdio: "pipe" }).toString().trim();

function fixture() {
	const repo = mkdtempSync(join(tmpdir(), "agent-dash-data-"));
	roots.push(repo);
	runGit(repo, "init", "-q");
	runGit(repo, "config", "user.email", "test@example.com");
	runGit(repo, "config", "user.name", "Test");
	writeFileSync(join(repo, "tracked.ts"), "const value = 1;\n");
	runGit(repo, "add", "tracked.ts");
	runGit(repo, "commit", "-qm", "initial");
	return repo;
}

function writeState(repo: string, change = "review") {
	const baseCommit = runGit(repo, "rev-parse", "HEAD");
	new WorkflowEngine(registerBuiltins()).start({
		repo,
		changeId: change,
		definitionId: "no-openspec",
		metadata: {
			branch: runGit(repo, "branch", "--show-current"),
			baseBranch: "main",
			baseCommit,
			task: "test",
		},
		routing: {
			defaultProfile: "test",
			routes: [
				{
					stepId: "core.implementation",
					role: "worker",
					profile: {
						name: "test",
						runtime: "pi",
						executable: "sh",
						tools: [],
						extensions: [],
						readOnly: false,
						capabilities: ["prompt", "run-environment", "observe"],
						digest: "test",
					},
				},
			],
		},
	});
	return join(repo, ".herdr-workflow", change);
}

afterEach(() => {
	for (const root of roots.splice(0))
		rmSync(root, { recursive: true, force: true });
});

test("loadLocalChanges includes tracked and untracked files, excluding workflow metadata", () => {
	const repo = fixture();
	writeState(repo);
	writeFileSync(join(repo, "tracked.ts"), "const value = 2;\n");
	writeFileSync(join(repo, "new.ts"), "export const added = true;\n");

	expect(
		loadLocalChanges(repo, "review").map((change) => change.newPath),
	).toEqual(["new.ts", "tracked.ts"]);
	expect(
		loadLocalChanges(repo, "review").find(
			(change) => change.newPath === "new.ts",
		),
	).toMatchObject({ newFile: true, linesAdded: 1 });
});

test("loadLocalDiff returns tracked and untracked diffs, and rejects missing state", () => {
	const repo = fixture();
	writeState(repo);
	writeFileSync(join(repo, "tracked.ts"), "const value = 2;\n");
	writeFileSync(join(repo, "new.ts"), "export const added = true;\n");
	const changes = loadLocalChanges(repo, "review");

	expect(
		loadLocalDiff(repo, "review", requireChange(changes, "tracked.ts")),
	).toContain("-const value = 1;");
	expect(
		loadLocalDiff(repo, "review", requireChange(changes, "new.ts")),
	).toContain("+export const added = true;");
	expect(() => loadLocalChanges(repo, "missing")).toThrow();
});

test("saveDeveloperReview creates review directory and serializes comments", async () => {
	const repo = fixture();
	writeState(repo);
	const comments: DeveloperReviewComment[] = [
		{ filePath: "tracked.ts", line: 2, body: "Use const." },
	];

	await saveDeveloperReview(repo, "review", comments);

	expect(
		JSON.parse(
			readFileSync(
				join(
					repo,
					".herdr-workflow",
					"review",
					"reviews",
					"developer-review.json",
				),
				"utf8",
			),
		),
	).toEqual({ comments });
});

test("savePlanReview serializes and reloads plan review comments", async () => {
	const repo = fixture();
	writeState(repo, "plan-review");
	const comments = [
		{ filePath: "proposal.md", line: 3, body: "Clarify scope." },
		{
			filePath: "design.md",
			line: 7,
			startLine: 7,
			endLine: 9,
			body: "Add a diagram.",
		},
	];

	await savePlanReview(repo, "plan-review", comments);

	expect(
		JSON.parse(
			readFileSync(
				join(
					repo,
					".herdr-workflow",
					"plan-review",
					"reviews",
					"plan-review.json",
				),
				"utf8",
			),
		),
	).toEqual({ comments });
	expect(loadPlanReviewComments(repo, "plan-review")).toEqual(comments);
});

test("task viewport centers the active task when possible", () => {
	const tasks = Array.from({ length: 10 }, (_, index) => ({
		done: index !== 4,
		text: `Task ${index + 1}`,
	}));

	expect(getTaskViewport(tasks)).toEqual({
		visibleTasks: tasks.slice(2, 7),
		start: 2,
		activeIndex: 4,
		activePosition: 5,
		activeRow: 2,
	});
});

test("task viewport clamps active task at the beginning and end", () => {
	const tasks = Array.from({ length: 10 }, (_, index) => ({
		done: index !== 0,
		text: `Task ${index + 1}`,
	}));
	expect(getTaskViewport(tasks)).toMatchObject({
		start: 0,
		activeIndex: 0,
		activePosition: 1,
		activeRow: 0,
	});

	const endingTasks = tasks.map((task, index) => ({
		...task,
		done: index !== 9,
	}));
	expect(getTaskViewport(endingTasks)).toMatchObject({
		start: 5,
		activeIndex: 9,
		activePosition: 10,
		activeRow: 4,
	});
});

test("task viewport renders short, empty, and all-complete lists", () => {
	const shortTasks = [
		{ done: true, text: "Task 1" },
		{ done: false, text: "Task 2" },
		{ done: true, text: "Task 3" },
	];
	expect(getTaskViewport(shortTasks)).toMatchObject({
		visibleTasks: shortTasks,
		start: 0,
		activeIndex: 1,
		activePosition: 2,
		activeRow: 1,
	});

	expect(getTaskViewport([])).toEqual({
		visibleTasks: [],
		start: 0,
		activeIndex: undefined,
		activePosition: undefined,
		activeRow: undefined,
	});

	const completeTasks = Array.from({ length: 7 }, (_, index) => ({
		done: true,
		text: `Task ${index + 1}`,
	}));
	expect(getTaskViewport(completeTasks)).toEqual({
		visibleTasks: completeTasks.slice(2),
		start: 2,
		activeIndex: undefined,
		activePosition: undefined,
		activeRow: undefined,
	});
});

test("demo dashboard includes usability verifier", () => {
	expect(testDashboard("verify").agents.map((agent) => agent.role)).toContain(
		"usability-verifier",
	);
});

test("required user actions keep plan review and approval inside modal flow", () => {
	const action = requiredUserActionFor("proposed", false, [
		"proposal.md",
		"tasks.md",
	]);

	expect(action?.key).toBe("plan-review");
	expect(action?.title).toContain("Plan review");
	// Trigger-only: the action opens the artifact-list popup directly, so there
	// are no selectable items in the generic ListViewModal.
	expect(action?.items).toEqual([]);
});

test("required user actions expose developer review and completion commands", () => {
	const review = requiredUserActionFor("developer-review");
	expect(review).toBeDefined();
	expect(review?.key).toBe("developer-review");
	expect(review?.title).toContain("Developer review");
	expect(review?.items).toEqual([]); // trigger-only: popup opens the changed-files view directly
	expect(
		requiredUserActionFor("completed", false)?.items.map((item) => item.label),
	).toEqual([
		"Create MR/PR",
		"Close Herdr workspace",
		"Close and delete worktree",
		"Not now",
	]);
	expect(
		requiredUserActionFor("completed", true)?.items.map((item) => item.label),
	).toEqual(["Close Herdr workspace", "Close and delete worktree", "Not now"]);
	expect(requiredUserActionFor("verify")).toBeUndefined();
});

test("startArgs maps quick workflow type to no-openspec and preserves task text", () => {
	const quickArgs = startArgs({
		repo: ".",
		ticket: "",
		change: "quick-fix",
		task: "Fix login\nand add coverage",
		mode: "worktree",
		workflowType: "quick",
	});

	expect(quickArgs.definitionId).toBe("no-openspec");
	expect(quickArgs.task).toBe("Fix login\nand add coverage");

	const fusionArgs = startArgs({
		repo: ".",
		ticket: "",
		change: "fusion-fix",
		task: "Compare plans\nand recommend one",
		mode: "worktree",
		workflowType: "plan-fusion",
	});

	expect(fusionArgs.definitionId).toBe("plan-fusion");
	expect(fusionArgs.task).toBe("Compare plans\nand recommend one");

	const proposalArgs = startArgs({
		repo: ".",
		ticket: "",
		change: "proposal",
		task: "Draft a plan",
		mode: "worktree",
		workflowType: "standard-propose",
	});
	expect(proposalArgs).toMatchObject({
		definitionId: "standard-propose",
		mode: "checkout",
		sameCheckout: true,
	});
	const fusionProposalArgs = startArgs({
		repo: ".",
		ticket: "T-1",
		change: "fusion-proposal",
		task: "Compare drafts",
		mode: "worktree",
		workflowType: "fusion-propose",
	});
	expect(fusionProposalArgs).toMatchObject({
		definitionId: "fusion-propose",
		ticket: "T-1",
		task: "Compare drafts",
		mode: "checkout",
		sameCheckout: true,
	});
});

test("costSummary aggregates model_usage rows per role and sorts by cost", () => {
	const rows = costSummary([
		{
			event: "model_usage",
			role: "worker",
			inputTokens: 100,
			outputTokens: 20,
			totalTokens: 120,
			cost: 0.1,
		},
		{
			event: "model_usage",
			role: "worker",
			inputTokens: 50,
			outputTokens: 10,
			totalTokens: 60,
			cost: 0.2,
		},
		{
			event: "model_usage",
			role: "planner",
			inputTokens: 30,
			outputTokens: 5,
			totalTokens: 35,
			cost: 0.05,
		},
		{ event: "pi_agent_start", role: "worker" },
	]);
	expect(rows.map((row) => row.role)).toEqual(["worker", "planner"]);
	expect(rows[0]?.messages).toBe(2);
	expect(rows[0]?.inputTokens).toBe(150);
	expect(rows[0]?.outputTokens).toBe(30);
	expect(rows[0]?.totalTokens).toBe(180);
	expect(rows[0]?.cost).toBeCloseTo(0.3, 10);
	expect(rows[1]?.messages).toBe(1);
	expect(rows[1]?.cost).toBe(0.05);
});

test("costMessages returns per-message rows for one role oldest first", () => {
	const messages = costMessages(
		[
			{
				event: "model_usage",
				role: "worker",
				at: "2026-01-01T10:48:00Z",
				inputTokens: 1,
				outputTokens: 1,
				totalTokens: 2,
				cost: 0.01,
			},
			{
				event: "model_usage",
				role: "worker",
				at: "2026-01-01T10:44:00Z",
				inputTokens: 2,
				outputTokens: 2,
				totalTokens: 4,
				cost: 0.02,
			},
			{
				event: "model_usage",
				role: "planner",
				at: "2026-01-01T10:41:00Z",
				inputTokens: 9,
				outputTokens: 9,
				totalTokens: 18,
				cost: 0.09,
			},
		],
		"worker",
	);
	expect(messages.map((message) => message.at)).toEqual([
		"2026-01-01T10:44:00Z",
		"2026-01-01T10:48:00Z",
	]);
	expect(messages[0]?.cost).toBe(0.02);
	expect(messages[1]?.inputTokens).toBe(1);
});

test("demo dashboard exposes cost breakdown", () => {
	const dashboard = testDashboard("verify");
	expect(dashboard.costBreakdown.map((row) => row.role)).toEqual([
		"worker",
		"planner",
		"quality-verifier",
		"security-verifier",
	]);
	expect(dashboard.agents.find((agent) => agent.role === "worker")?.cost).toBe(
		0.42,
	);
});

test("isStale flags long-running non-terminal phases", () => {
	const now = Date.parse("2026-01-01T12:00:00Z");
	expect(
		isStale({ phase: "verify", phaseStartedAt: "2026-01-01T06:01:00Z" }, now),
	).toBe(false);
	expect(
		isStale({ phase: "verify", phaseStartedAt: "2026-01-01T05:59:00Z" }, now),
	).toBe(true);
	expect(
		isStale(
			{
				phase: "verify",
				status: "completed",
				phaseStartedAt: "2026-01-01T00:00:00Z",
			},
			now,
		),
	).toBe(false);
	expect(isStale({ phase: "verify" }, now)).toBe(false);
});
