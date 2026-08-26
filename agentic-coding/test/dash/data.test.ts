import { Database } from "bun:sqlite";
import { afterEach, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import {
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	agentMetrics,
	costMessages,
	costSummary,
	type DeveloperReviewComment,
	getTaskViewport,
	isStale,
	loadDashboard,
	loadLocalChanges,
	loadLocalDiff,
	loadPlanReviewComments,
	requiredUserActionFor,
	saveDeveloperReview,
	savePlanReview,
	testDashboard,
	worktreeGitStatus,
} from "../../src/tui/dash/data";
import { startArgs, viewToDashboardState } from "../../src/tui/dash/engine";
import { registerBuiltins } from "../../src/workflow/definitions";
import { canonicalStorePath, WorkflowEngine } from "../../src/workflow/runtime";

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

function removeWorkflowTask(repo: string, change: string) {
	const db = new Database(canonicalStorePath(repo));
	const row = db
		.query("SELECT id, snapshot_json FROM workflow_instances WHERE change_id=?")
		.get(change) as { id: string; snapshot_json: string };
	const snapshot = JSON.parse(row.snapshot_json) as {
		metadata: { task?: string };
	};
	delete snapshot.metadata.task;
	db.query("UPDATE workflow_instances SET snapshot_json=? WHERE id=?").run(
		JSON.stringify(snapshot),
		row.id,
	);
	db.close();
}

afterEach(() => {
	for (const root of roots.splice(0))
		rmSync(root, { recursive: true, force: true });
});

test("workflow metadata task reaches dashboard state and request", () => {
	const repo = fixture();
	writeState(repo);
	const workflowView = new WorkflowEngine(registerBuiltins()).status(
		repo,
		"review",
	);

	expect(workflowView.task).toBe("test");
	expect(viewToDashboardState(workflowView)).toMatchObject({ task: "test" });
	const dashboard = loadDashboard(repo, "review");
	expect(dashboard.request).toBe("test");
	expect(dashboard.gitStatus).toMatchObject({
		available: true,
		changedFiles: 0,
		addedFiles: 0,
		deletedFiles: 0,
		noUpstream: true,
	});
});

test("loadDashboard falls back to the legacy request artifact", () => {
	const repo = fixture();
	const workflowRoot = writeState(repo, "legacy");
	removeWorkflowTask(repo, "legacy");
	writeFileSync(
		join(workflowRoot, "request.md"),
		`# Request

- Keep the legacy fallback
`,
	);

	expect(loadDashboard(repo, "legacy").request).toBe(
		"Keep the legacy fallback",
	);
});

test("loadDashboard shows the empty request state without either source", () => {
	const repo = fixture();
	writeState(repo, "empty");
	removeWorkflowTask(repo, "empty");

	expect(loadDashboard(repo, "empty").request).toBe("Not created yet");
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

test("worktreeGitStatus reports clean worktrees and missing upstreams", () => {
	const repo = fixture();
	const status = worktreeGitStatus(repo);
	expect(status.available).toBe(true);
	expect(status.branch).toBeTypeOf("string");
	expect(status.changedFiles).toBe(0);
	expect(status.addedFiles).toBe(0);
	expect(status.deletedFiles).toBe(0);
	// A fresh local fixture branch has no configured upstream.
	expect(status.noUpstream).toBe(true);
	expect(status.ahead).toBeUndefined();
	expect(status.behind).toBeUndefined();
});

test("worktreeGitStatus classifies modified, added, deleted, and renamed paths once each", () => {
	const repo = fixture();
	writeFileSync(join(repo, "tracked.ts"), "const value = 2;\n"); // modified
	writeFileSync(join(repo, "untracked.ts"), "new\n"); // untracked -> added
	writeFileSync(join(repo, "gone.ts"), "export {};\n");
	runGit(repo, "add", "gone.ts");
	runGit(repo, "commit", "-qm", "second");
	rmSync(join(repo, "gone.ts")); // deleted
	runGit(repo, "mv", "tracked.ts", "moved.ts"); // staged rename
	// Staged add + further worktree edits must count once.
	writeFileSync(join(repo, "partial.ts"), "a\n");
	runGit(repo, "add", "partial.ts");
	writeFileSync(join(repo, "partial.ts"), "b\n");
	const status = worktreeGitStatus(repo);
	expect(status.changedFiles).toBe(1); // moved.ts (rename)
	expect(status.addedFiles).toBe(2); // untracked.ts + partial.ts (staged+edited once)
	expect(status.deletedFiles).toBe(1); // gone.ts
});

test("worktreeGitStatus expands untracked directories into their files", () => {
	const repo = fixture();
	mkdirSync(join(repo, "fresh-dir"), { recursive: true });
	writeFileSync(join(repo, "fresh-dir", "inside.ts"), "export {};\n");
	const status = worktreeGitStatus(repo);
	// The directory record must not count as a single added "file".
	expect(status.addedFiles).toBe(1);
});

test("worktreeGitStatus computes ahead/behind against the configured upstream", () => {
	const repo = fixture();
	const main = runGit(repo, "rev-parse", "--abbrev-ref", "HEAD");
	runGit(repo, "checkout", "-qb", "feature");
	writeFileSync(join(repo, "feature.ts"), "export {};\n");
	runGit(repo, "add", "feature.ts");
	runGit(repo, "commit", "-qm", "feature work");
	runGit(repo, "branch", "--set-upstream-to", main);
	let status = worktreeGitStatus(repo);
	expect(status.noUpstream).toBe(false);
	expect(status.ahead).toBe(1);
	expect(status.behind).toBe(0);
	runGit(repo, "checkout", "-q", main);
	writeFileSync(join(repo, "main.ts"), "export {};\n");
	runGit(repo, "add", "main.ts");
	runGit(repo, "commit", "-qm", "main work");
	runGit(repo, "checkout", "-q", "feature");
	status = worktreeGitStatus(repo);
	expect(status.ahead).toBe(1);
	expect(status.behind).toBe(1);
});

test("loadDashboard exposes the complete Git status snapshot", () => {
	const repo = fixture();
	writeState(repo);
	writeFileSync(join(repo, "tracked.ts"), "const value = 2;\n");
	writeFileSync(join(repo, "new.ts"), "export const added = true;\n");

	expect(loadDashboard(repo, "review").gitStatus).toMatchObject({
		available: true,
		changedFiles: 1,
		addedFiles: 1,
		deletedFiles: 0,
		noUpstream: true,
	});
});

test("worktreeGitStatus reports bounded diagnostics for unavailable worktrees", () => {
	const missing = worktreeGitStatus(join(tmpdir(), "missing-worktree-fixture"));
	expect(missing.available).toBe(false);
	expect(missing.diagnostic).toContain("worktree not found");
	const plain = mkdtempSync(join(tmpdir(), "agent-dash-nongit-"));
	roots.push(plain);
	const status = worktreeGitStatus(plain);
	expect(status.available).toBe(false);
	expect(status.diagnostic).toBeTruthy();
	expect((status.diagnostic ?? "").length).toBeLessThanOrEqual(96);
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

	// Engine step id naming must resolve to the same stable action key.
	const engineAction = requiredUserActionFor("core.plan-approval", false, []);
	expect(engineAction?.key).toBe("plan-review");
	expect(engineAction?.items).toEqual([]);
});

test("required user actions expose developer review and completion commands", () => {
	const review = requiredUserActionFor("developer-review");
	expect(review).toBeDefined();
	expect(review?.key).toBe("developer-review");
	expect(review?.title).toContain("Developer review");
	expect(review?.items).toEqual([]); // trigger-only: popup opens the changed-files view directly

	// Engine step id naming must resolve to the same stable action key.
	const engineReview = requiredUserActionFor("core.developer-review");
	expect(engineReview?.key).toBe("developer-review");
	expect(engineReview?.items).toEqual([]);
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
	const proposal = requiredUserActionFor(
		"core.completed",
		false,
		[],
		"standard-propose",
	);
	expect(proposal?.items.map((item) => item.label)).toEqual([
		"Close Herdr workspace",
		"Not now",
	]);
	expect(proposal?.items.map((item) => item.kind)).toEqual([
		"workflow",
		"dismiss",
	]);
	const planAction = requiredUserActionFor(
		"core.plan-approval",
		false,
		[],
		"standard-propose",
	);
	expect(planAction?.prompt).toContain("before completing the proposal");
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

test("costSummary aggregates runtime.usage and legacy model_usage rows", () => {
	const rows = costSummary([
		{
			event: "runtime.usage",
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
	]);
	expect(rows).toHaveLength(1);
	expect(rows[0]?.messages).toBe(2);
	expect(rows[0]?.cost).toBeCloseTo(0.3, 10);
});

test("agentMetrics sums usage events per role and prefers generation time for tok/s", () => {
	const metrics = agentMetrics([
		{ event: "runtime.started", role: "worker", at: "2026-01-01T10:00:00Z" },
		{
			event: "runtime.usage",
			role: "worker",
			at: "2026-01-01T10:01:00Z",
			inputTokens: 1000,
			outputTokens: 200,
			cacheReadTokens: 800,
			cacheWriteTokens: 100,
			cost: 0.1,
			durationMs: 40000,
		},
		{
			event: "runtime.usage",
			role: "worker",
			at: "2026-01-01T10:03:00Z",
			inputTokens: 500,
			outputTokens: 100,
			cacheReadTokens: 400,
			cacheWriteTokens: 50,
			cost: 0.05,
			durationMs: 10000,
		},
	]);
	const worker = metrics.get("worker");
	expect(worker?.cost).toBeCloseTo(0.15, 10);
	expect(worker?.inputTokens).toBe(1500);
	expect(worker?.outputTokens).toBe(300);
	expect(worker?.cacheReadTokens).toBe(1200);
	expect(worker?.cacheWriteTokens).toBe(150);
	expect(
		(worker?.cacheReadTokens ?? 0) /
			((worker?.inputTokens ?? 0) +
				(worker?.cacheReadTokens ?? 0) +
				(worker?.cacheWriteTokens ?? 0)),
	).toBeCloseTo(0.421, 3);
	// Wall-clock span from first to last role event.
	expect(worker?.durationSeconds).toBe(180);
	// Summed generation time (50s), not wall-clock (180s).
	expect(worker?.tokensPerSecond).toBe(6);
});

test("agentMetrics retains complete cache inputs when cached reads exceed uncached input", () => {
	const metrics = agentMetrics([
		{
			event: "runtime.usage",
			role: "worker",
			inputTokens: 1000,
			cacheReadTokens: 3000,
			cacheWriteTokens: 0,
		},
	]);

	const worker = metrics.get("worker");
	expect(worker?.cacheReadTokens).toBe(3000);
	expect(
		(worker?.cacheReadTokens ?? 0) /
			((worker?.inputTokens ?? 0) +
				(worker?.cacheReadTokens ?? 0) +
				(worker?.cacheWriteTokens ?? 0)),
	).toBe(0.75);
});

test("agentMetrics omits cache metrics when any usage event is incomplete", () => {
	const metrics = agentMetrics([
		{
			event: "runtime.usage",
			role: "worker",
			inputTokens: 100,
			cacheReadTokens: 900,
			cacheWriteTokens: 0,
		},
		{
			event: "runtime.usage",
			role: "worker",
			inputTokens: 200,
			cacheReadTokens: 1800,
		},
		{
			event: "runtime.usage",
			role: "invalid",
			inputTokens: 100,
			cacheReadTokens: 900,
			cacheWriteTokens: -1,
		},
	]);

	expect(metrics.get("worker")).toMatchObject({ inputTokens: 300 });
	expect(metrics.get("worker")?.cacheReadTokens).toBeUndefined();
	expect(metrics.get("worker")?.cacheWriteTokens).toBeUndefined();
	expect(metrics.get("invalid")?.cacheReadTokens).toBeUndefined();
	expect(metrics.get("invalid")?.cacheWriteTokens).toBeUndefined();
});

test("agentMetrics omits invalid cache inputs instead of poisoning aggregates", () => {
	const metrics = agentMetrics([
		{
			event: "runtime.usage",
			role: "missing",
			inputTokens: 100,
			cost: 0.01,
		},
		{
			event: "runtime.usage",
			role: "negative",
			inputTokens: 100,
			cacheReadTokens: -1,
		},
		{
			event: "runtime.usage",
			role: "non-finite",
			inputTokens: Number.POSITIVE_INFINITY,
			cacheReadTokens: 10,
		},
		{
			event: "runtime.usage",
			role: "zero",
			inputTokens: 0,
			cacheReadTokens: 0,
			cacheWriteTokens: 0,
		},
		{
			event: "runtime.usage",
			role: "missing-input",
			cacheReadTokens: 10,
		},
		{
			event: "runtime.usage",
			role: "non-finite-cache",
			inputTokens: 100,
			cacheReadTokens: Number.NaN,
			cacheWriteTokens: 0,
		},
		{
			event: "runtime.usage",
			role: "negative-write",
			inputTokens: 100,
			cacheReadTokens: 10,
			cacheWriteTokens: -1,
		},
		{
			event: "runtime.usage",
			role: "non-finite-write",
			inputTokens: 100,
			cacheReadTokens: 10,
			cacheWriteTokens: Number.POSITIVE_INFINITY,
		},
	]);

	expect(metrics.get("missing")?.cacheReadTokens).toBeUndefined();
	expect(metrics.get("negative")?.cacheReadTokens).toBeUndefined();
	expect(metrics.get("non-finite")?.inputTokens).toBeUndefined();
	expect(metrics.get("missing-input")?.inputTokens).toBeUndefined();
	expect(metrics.get("non-finite-cache")?.cacheReadTokens).toBeUndefined();
	expect(metrics.get("negative-write")?.cacheWriteTokens).toBeUndefined();
	expect(metrics.get("non-finite-write")?.cacheWriteTokens).toBeUndefined();
	expect(metrics.get("zero")).toMatchObject({
		inputTokens: 0,
		cacheReadTokens: 0,
		cacheWriteTokens: 0,
	});
});

test("agentMetrics omits fields the events never recorded", () => {
	const metrics = agentMetrics([
		// Usage row without cache or timing detail.
		{
			event: "model_usage",
			role: "planner",
			at: "2026-01-01T10:00:00Z",
			inputTokens: 100,
			outputTokens: 10,
			cost: 0.01,
		},
		// Lifecycle-only role: duration without any usage values.
		{ event: "runtime.started", role: "verifier", at: "2026-01-01T10:00:00Z" },
		{ event: "runtime.settled", role: "verifier", at: "2026-01-01T10:02:00Z" },
	]);
	const planner = metrics.get("planner");
	expect(planner?.cost).toBe(0.01);
	expect(planner?.cacheReadTokens).toBeUndefined();
	expect(planner?.durationSeconds).toBeUndefined();
	expect(planner?.tokensPerSecond).toBeUndefined();
	const verifier = metrics.get("verifier");
	expect(verifier?.durationSeconds).toBe(120);
	expect(verifier?.cost).toBeUndefined();
	expect(verifier?.inputTokens).toBeUndefined();
	// Roles without any metric-bearing event are omitted entirely.
	expect(metrics.has("worker")).toBe(false);
});

test("demo dashboard renders every metric field with runtime.usage fixtures", () => {
	const dashboard = testDashboard("verify");
	for (const role of [
		"planner",
		"worker",
		"security-verifier",
		"quality-verifier",
	]) {
		const metrics = dashboard.agents.find(
			(agent) => agent.role === role,
		)?.metrics;
		expect(metrics?.cost).toBeDefined();
		expect(metrics?.inputTokens).toBeGreaterThan(0);
		expect(metrics?.outputTokens).toBeGreaterThan(0);
		expect(metrics?.cacheReadTokens).toBeGreaterThan(0);
		expect(metrics?.cacheWriteTokens).toBeGreaterThanOrEqual(0);
		expect(metrics?.durationSeconds).toBeGreaterThan(0);
		expect(metrics?.tokensPerSecond).toBeGreaterThan(0);
	}
	// Partial agent: lifecycle events only → duration, no invented values.
	const partial = dashboard.agents.find(
		(agent) => agent.role === "agents-verifier",
	)?.metrics;
	expect(partial?.durationSeconds).toBeGreaterThan(0);
	expect(partial?.cost).toBeUndefined();
	expect(partial?.inputTokens).toBeUndefined();
	// Untouched agents carry no metrics at all.
	expect(
		dashboard.agents.find((agent) => agent.role === "test-verifier")?.metrics,
	).toBeUndefined();
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
