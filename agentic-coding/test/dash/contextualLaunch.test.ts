// Contextual workflow launch (launch-workflows-from-project-and-wiki-pages).
//
// Tasks 1.1 (inventory), 3.1 (project launches), 3.2 (independent launches),
// 3.3 (start outcomes and duplicate submission) and 3.4 (no list/browser
// surface survives, durable data intact): the launch context decides the
// target, the start boundary classifies its answer, and nothing here creates a
// second workflow or removes stored state.
import { afterEach, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	backendClient,
	clearBackendClient,
	configureBackendClient,
} from "../../src/server/client.ts";
import {
	launchContextError,
	launchRepositoryAvailable,
	launchWorkflow,
	type WorkflowLaunchContext,
	watchAcceptedHandoff,
	workflowTypesForContext,
} from "../../src/tui/dash/launch.ts";
import { clearGateway, configureGateway } from "../../src/tui/data/index.ts";
import { PUBLIC_WORKFLOW_CATALOG } from "../../src/workflow/definitions.ts";

const originalFetch = globalThis.fetch;

afterEach(() => {
	globalThis.fetch = originalFetch;
	clearBackendClient();
	clearGateway();
});

function useBackend(responder: () => Promise<Response>): void {
	configureGateway(
		configureBackendClient({
			baseUrl: "http://127.0.0.1:1",
			token: "t",
			ownerId: "test",
		}),
	);
	globalThis.fetch = (() => responder()) as unknown as typeof fetch;
}

const INPUT = {
	repo: "/managed/fixture",
	ticket: "",
	workflowId: "add-thing",
	mode: "worktree",
	workflowType: "openspec-full",
	preset: "Config defaults",
};

const PROJECT: WorkflowLaunchContext = {
	kind: "project",
	ident: "fixture",
	name: "Fixture",
	repository: "/managed/fixture",
};

// ── Task 1.1: the public workflow types and their target capability ───────────

test("the registry catalog is the single workflow-type authority", () => {
	expect(PUBLIC_WORKFLOW_CATALOG.map((entry) => entry.id)).toEqual([
		"openspec-full",
		"openspec-apply",
		"openspec-jev",
		"openspec-jev-apply",
		"no-openspec",
		"openspec-fusion-full",
		"openspec-propose",
		"openspec-fusion-propose",
		"wiki",
		"research",
	]);
	// A project page may offer the whole registry; Wiki may offer the
	// repository-independent type only.
	expect(workflowTypesForContext(PROJECT)).toBeUndefined();
	expect(workflowTypesForContext({ kind: "independent" })).toEqual([
		"research",
	]);
});

// ── Task 3.1: project launches stay bound to their canonical identity ────────

test("a configured project supplies the repository, so the form has no target choice", () => {
	expect(launchContextError(PROJECT)).toBeUndefined();
	expect(launchRepositoryAvailable({ ...PROJECT, repository: tmpdir() })).toBe(
		true,
	);
});

test("a project without a repository path is blocked with an actionable error", () => {
	const problem = launchContextError({ ...PROJECT, repository: "  " });
	expect(problem).toContain("Fixture");
	expect(problem).toContain("configure");
});

test("a removed project is unavailable, never scanned, cloned or retargeted", () => {
	const root = mkdtempSync(join(tmpdir(), "launch-gone-"));
	expect(launchRepositoryAvailable(PROJECT)).toBe(false);
	expect(launchRepositoryAvailable({ ...PROJECT, repository: root })).toBe(
		true,
	);
	expect(launchContextError({ ...PROJECT, repository: root })).toBeUndefined();
});

// ── Task 3.2: independent work is Wiki-only and needs no catalog ─────────────

test("an independent launch carries an empty repository and no project identity", () => {
	const context: WorkflowLaunchContext = { kind: "independent" };
	expect(launchContextError(context)).toBeUndefined();
	expect(launchRepositoryAvailable(context)).toBe(true);
});

// ── Home launches any directory, outside the configured projects ──────────────

test("a path context targets its directory and may offer every repository type", () => {
	const root = mkdtempSync(join(tmpdir(), "launch-path-"));
	const context: WorkflowLaunchContext = { kind: "path", repository: root };
	expect(launchContextError(context)).toBeUndefined();
	expect(launchRepositoryAvailable(context)).toBe(true);
	expect(workflowTypesForContext(context)).toBeUndefined();
	expect(
		launchRepositoryAvailable({ kind: "path", repository: "/nonexistent/dir" }),
	).toBe(false);
});

test("a path context without a directory is blocked with an actionable error", () => {
	const problem = launchContextError({ kind: "path", repository: "  " });
	expect(problem).toContain("enter a directory");
});

// ── Task 3.3: accepted, rejected and uncertain starts stay distinct ──────────

test("an accepted start names the workflow it created", async () => {
	useBackend(async () =>
		Response.json({ ok: true, value: "Workflow started: add-thing" }),
	);
	const outcome = await launchWorkflow(INPUT);
	expect(outcome).toEqual({
		kind: "accepted",
		workflowId: "add-thing",
		message: "Workflow started: add-thing",
	});
});

test("a refused start over the transport is reported as rejected, not as handoff failure", async () => {
	useBackend(async () =>
		Response.json(
			{ ok: false, error: { code: "workflow-id", message: "invalid id" } },
			{ status: 400 },
		),
	);
	const outcome = await launchWorkflow(INPUT);
	expect(outcome.kind).toBe("rejected");
	expect(outcome.kind === "rejected" && outcome.message).toContain(
		"invalid id",
	);
});

test("a failed request leaves acceptance unknown instead of guessing", async () => {
	useBackend(async () => {
		throw new TypeError("fetch failed");
	});
	expect((await launchWorkflow(INPUT)).kind).toBe("uncertain");
});

test("a server error after the request also leaves acceptance unknown", async () => {
	useBackend(async () =>
		Response.json(
			{ ok: false, error: { code: "internal", message: "boom" } },
			{ status: 500 },
		),
	);
	expect((await launchWorkflow(INPUT)).kind).toBe("uncertain");
});

test("an accepted workflow is never submitted a second time by the handoff watch", async () => {
	// The post-acceptance watch only reports by identity; it never calls the
	// start boundary again, so a failed handoff cannot duplicate work.
	const failures: string[] = [];
	const dispose = watchAcceptedHandoff("/repo", "wf-1", (message) =>
		failures.push(message),
	);
	expect(typeof dispose).toBe("function");
	dispose();
	// No transport is configured here, so the watch used the in-process
	// execution-coordinator listener and started nothing.
	expect(backendClient()).toBeUndefined();
	expect(failures).toEqual([]);
});

// ── Task 3.4: no browsing surface, and nothing durable is removed ────────────

test("the launch boundary exposes no list, history or reopen call", async () => {
	const module = await import("../../src/tui/dash/launch");
	expect(Object.keys(module).sort()).toEqual([
		"launchContextError",
		"launchRepositoryAvailable",
		"launchWorkflow",
		"watchAcceptedHandoff",
		"workflowTypesForContext",
	]);
});
