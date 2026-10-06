// Orchestrator launch counting across workflow targets
// (cap-orchestrator-launches, task 2.1): the bounded read behind the server's
// launch ceiling. A real multi-target fixture — one store per repository, the
// shared wiki/research store, a migration-required store and a broken store —
// pins what is counted, what is skipped, and that operator work and terminal
// workflows never spend the orchestrator's budget.

import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { StartedBy } from "../src/contracts/workflow.ts";
import {
	definitionVersionForPolicy,
	registerBuiltins,
} from "../src/workflow/definitions.ts";
import {
	countOrchestratorLaunches,
	orchestratorLaunchTargets,
} from "../src/workflow/runtime/orchestrator-launches.ts";
import {
	canonicalStorePath,
	recordWorkflowTarget,
	researchWorkflowTarget,
	WorkflowEngine,
	wikiWorkflowTarget,
} from "../src/workflow/runtime.ts";
import {
	autoRemoveRepoFixtures,
	createRepoFixture,
} from "./support/git-fixture.ts";

// Sweep the repositories this file created, at the end of this file only.
autoRemoveRepoFixtures();

const NOW = new Date("2026-10-06T12:00:00.000Z");
const OLD = new Date("2026-10-04T12:00:00.000Z");

/** The minimal routing a `no-openspec` start needs; the profile is never
 * launched, only recorded. */
function routing() {
	return {
		defaultProfile: "test",
		routes: [
			{
				stepId: "core.implementation",
				role: "worker",
				profile: {
					name: "test",
					runtime: "pi-durable" as const,
					executable: "sh",
					tools: [],
					extensions: [],
					readOnly: false,
					capabilities: ["prompt", "run-environment", "observe"] as const,
					digest: "profile",
				},
			},
		],
		diversity: [],
	};
}

/** The read-only researcher routing a `research` start requires. */
function researchRouting() {
	return {
		defaultProfile: "researcher",
		routes: [
			{
				stepId: "core.research",
				role: "researcher",
				profile: {
					name: "researcher",
					runtime: "pi-durable" as const,
					executable: "sh",
					tools: ["read"],
					extensions: [],
					readOnly: true,
					capabilities: [
						"interactive",
						"prompt",
						"persistent-session",
						"run-environment",
						"observe",
						"read-only",
					] as const,
					digest: "profile",
				},
			},
		],
		diversity: [],
	};
}

function start(
	engine: WorkflowEngine,
	repo: string,
	workflowId: string,
	startedBy: StartedBy,
): void {
	engine.start({
		repo,
		workflowId,
		definitionId: "no-openspec",
		metadata: {
			branch: "main",
			baseBranch: "main",
			baseCommit: "base",
			task: "count me",
			startedBy,
		},
		routing: routing(),
	});
}

/** Start a repository-independent research workflow in the shared store. */
function startResearch(
	engine: WorkflowEngine,
	workflowId: string,
	startedBy: StartedBy,
): void {
	engine.start({
		repo: researchWorkflowTarget(),
		workflowId,
		definitionId: "research",
		// The standalone research lifecycle has no legacy version 1.
		definitionVersion: definitionVersionForPolicy(6),
		metadata: {
			branch: "",
			baseBranch: "",
			baseCommit: "",
			task: "count me",
			startedBy,
		},
		routing: researchRouting(),
	});
}

/** Start a repository-independent wiki-comments workflow in the same shared
 * store as research: the two targets resolve to one file. */
function startWikiComments(
	engine: WorkflowEngine,
	workflowId: string,
	startedBy: StartedBy,
): void {
	engine.start({
		repo: wikiWorkflowTarget(),
		workflowId,
		definitionId: "wiki-comments",
		definitionVersion: definitionVersionForPolicy(6),
		metadata: {
			branch: "",
			baseBranch: "",
			baseCommit: "",
			task: "count me",
			startedBy,
		},
		routing: {
			defaultProfile: "test",
			routes: [
				{
					stepId: "core.wiki",
					role: "wiki",
					profile: routing().routes[0].profile,
				},
			],
			diversity: [],
		},
	});
}

function setRow(
	repo: string,
	workflowId: string,
	patch: { status?: string; createdAt?: Date },
): void {
	const db = new Database(canonicalStorePath(repo));
	try {
		if (patch.status)
			db.query("UPDATE workflow_instances SET status=? WHERE id=?").run(
				patch.status,
				workflowId,
			);
		if (patch.createdAt)
			db.query("UPDATE workflow_instances SET created_at=? WHERE id=?").run(
				patch.createdAt.toISOString(),
				workflowId,
			);
	} finally {
		db.close();
	}
}

function userVersion(repo: string): number {
	const db = new Database(canonicalStorePath(repo));
	try {
		return (db.query("PRAGMA user_version").get() as { user_version: number })
			.user_version;
	} finally {
		db.close();
	}
}

/** One isolated workflow data root so the target registry and the wiki/research
 * stores belong to this test only. */
function withDataRoot(run: (root: string) => void): void {
	const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "orchestrator-launches-"));
	const previous = process.env.HERDR_WIKI_DIR;
	process.env.HERDR_WIKI_DIR = path.join(tmp, "wiki");
	try {
		run(tmp);
	} finally {
		if (previous === undefined) delete process.env.HERDR_WIKI_DIR;
		else process.env.HERDR_WIKI_DIR = previous;
		fs.rmSync(tmp, { recursive: true, force: true });
	}
}

describe("orchestrator launch counting", () => {
	test("counts active and trailing-24 h orchestrator work across targets", () => {
		withDataRoot((tmp) => {
			const repoA = createRepoFixture(path.join(tmp, "repo-a"), {
				excludeWorkflowState: true,
			});
			const repoB = createRepoFixture(path.join(tmp, "repo-b"), {
				excludeWorkflowState: true,
			});
			const engine = new WorkflowEngine(registerBuiltins(), () => NOW);
			start(engine, repoA, "a-active", "orchestrator");
			start(engine, repoA, "a-old", "orchestrator");
			start(engine, repoA, "a-developer", "developer");
			start(engine, repoB, "b-active", "orchestrator");
			start(engine, repoB, "b-done", "orchestrator");
			// A workflow older than 24 h stays active (it is not terminal) but does
			// not count against the daily start budget; a completed one is the
			// reverse.
			setRow(repoA, "a-old", { createdAt: OLD });
			setRow(repoB, "b-done", { status: "completed" });

			// Both repositories are registered, plus the always-read wiki/research
			// targets the registry deliberately never records.
			expect(orchestratorLaunchTargets()).toEqual(
				expect.arrayContaining([
					fs.realpathSync(repoA),
					fs.realpathSync(repoB),
					"wiki://centralized",
					"research://standalone",
				]),
			);

			const counts = countOrchestratorLaunches(NOW);
			expect(counts.active.map((launch) => launch.workflowId).sort()).toEqual([
				"a-active",
				"a-old",
				"b-active",
			]);
			expect(counts.recent.map((launch) => launch.workflowId).sort()).toEqual([
				"a-active",
				"b-active",
				"b-done",
			]);
			// The developer's own start is neither counted nor limited.
			expect(
				[...counts.active, ...counts.recent].some(
					(launch) => launch.workflowId === "a-developer",
				),
			).toBe(false);
			// Absent wiki/research stores contribute nothing and are not "skipped".
			expect(counts.skipped).toEqual([]);
		});
	});

	test("the shared wiki/research store is counted once, not once per alias", () => {
		withDataRoot(() => {
			const engine = new WorkflowEngine(registerBuiltins(), () => NOW);
			startResearch(engine, "research-one", "orchestrator");
			startWikiComments(engine, "wiki-one", "orchestrator");

			const counts = countOrchestratorLaunches(NOW);
			// `wiki://centralized` and `research://standalone` resolve to one store
			// file: each row must appear exactly once, under its real target rather
			// than the alias that happened to read the shared file first.
			expect(counts.active).toEqual(
				expect.arrayContaining([
					{
						workflowId: "research-one",
						repository: researchWorkflowTarget(),
						createdAt: NOW.toISOString(),
					},
					{
						workflowId: "wiki-one",
						repository: wikiWorkflowTarget(),
						createdAt: NOW.toISOString(),
					},
				]),
			);
			expect(counts.active).toHaveLength(2);
			expect(counts.recent.map((launch) => launch.workflowId).sort()).toEqual([
				"research-one",
				"wiki-one",
			]);
		});
	});

	test("a migration-required store is skipped and left untouched", () => {
		withDataRoot((tmp) => {
			const repo = createRepoFixture(path.join(tmp, "migrating"), {
				excludeWorkflowState: true,
			});
			const engine = new WorkflowEngine(registerBuiltins(), () => NOW);
			start(engine, repo, "not-counted", "orchestrator");
			// Pin the store behind the current schema, the way an interrupted
			// migration or an older build leaves it.
			const db = new Database(canonicalStorePath(repo));
			db.exec("PRAGMA user_version=3");
			db.close();

			const counts = countOrchestratorLaunches(NOW);
			expect(counts.active).toEqual([]);
			expect(counts.recent).toEqual([]);
			// The registry records the canonical target the engine started in.
			expect(counts.skipped).toEqual([fs.realpathSync(repo)]);
			// The read is observational: counting neither counted nor migrated it.
			expect(userVersion(repo)).toBe(3);
		});
	});

	test("an unreadable store is skipped with a diagnostic, never failing the count", () => {
		withDataRoot((tmp) => {
			const good = createRepoFixture(path.join(tmp, "good"), {
				excludeWorkflowState: true,
			});
			const engine = new WorkflowEngine(registerBuiltins(), () => NOW);
			start(engine, good, "kept", "orchestrator");

			// A recorded target whose store file is not a database: the read must
			// skip it rather than throw, and say so.
			const broken = createRepoFixture(path.join(tmp, "broken"), {
				excludeWorkflowState: true,
			});
			recordWorkflowTarget(broken);
			fs.mkdirSync(path.join(broken, ".herdr-workflow"), { recursive: true });
			fs.writeFileSync(
				path.join(broken, ".herdr-workflow", "herdr.db"),
				"not a database",
			);

			const counts = countOrchestratorLaunches(NOW);
			expect(counts.active.map((launch) => launch.workflowId)).toEqual([
				"kept",
			]);
			// The recorded target is named, so the refusal can say which store was not
			// read instead of silently undercounting.
			expect(counts.skipped).toEqual([broken]);
		});
	});
});
