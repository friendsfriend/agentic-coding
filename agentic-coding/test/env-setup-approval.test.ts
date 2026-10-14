// The env-setup approval surface's data path
// (`add-environment-setup-workflow`, task 3.3): the draft file list, the
// per-file diff the dashboard's environment-review popup renders, the
// shared-infrastructure flag it shows on a row, and the boundary that refuses a
// drafts directory or a draft path the request must not reach.
import { describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
	assertSetupDraftsDir,
	draftPathWithin,
	isAllowedDraftPath,
	listDraftFiles,
	setupDraftChange,
	setupDraftChanges,
	setupDraftsDir,
} from "../src/server/environment/setup-drafts.ts";
import {
	loadSetupDraftChanges,
	loadSetupDraftDiff,
	setupDraftRows,
} from "../src/server/operations/observations.ts";
import { sharedInfrastructureChange } from "../src/tui/dash/review.ts";
import { definitionVersionForFamilyTraits } from "../src/workflow/definitions/manifest-policy.ts";
import { registerBuiltins } from "../src/workflow/definitions.ts";
import { WorkflowEngine } from "../src/workflow/runtime.ts";

function tempDir(prefix: string): string {
	return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function writeFile(filePath: string, text: string): void {
	fs.mkdirSync(path.dirname(filePath), { recursive: true });
	fs.writeFileSync(filePath, text);
}

function fixture() {
	const configDir = tempDir("env-setup-approval-");
	const workflowId = "wf-env-approval";
	const draftsDir = setupDraftsDir(configDir, workflowId);
	writeFile(
		path.join(configDir, "apps", "compose", "shop-compose.yml"),
		"services:\n  shop:\n    image: live\n",
	);
	writeFile(
		path.join(configDir, "infrastructure", "definitions", "postgres.json"),
		'{"ident":"postgres","port":5432}\n',
	);
	writeFile(
		path.join(draftsDir, "apps", "compose", "shop-compose.yml"),
		"services:\n  shop:\n    image: draft\n",
	);
	writeFile(
		path.join(draftsDir, "infrastructure", "definitions", "postgres.json"),
		'{"ident":"postgres","port":5433}\n',
	);
	writeFile(
		path.join(draftsDir, "apps", "run", "shop-worker.sh"),
		"echo worker\n",
	);
	return { configDir, draftDir: draftsDir, workflowId };
}

describe("env-setup approval data", () => {
	test("the drafts are listed as rows and one draft's diff is served", () => {
		const { configDir, draftDir } = fixture();
		expect(listDraftFiles(draftDir)).toEqual([
			"apps/compose/shop-compose.yml",
			"apps/run/shop-worker.sh",
			"infrastructure/definitions/postgres.json",
		]);
		const changes = setupDraftChanges(configDir, draftDir);
		const compose = changes.find(
			(change) => change.path === "apps/compose/shop-compose.yml",
		);
		expect(compose?.status).toBe("modified");
		expect(compose?.linesAdded).toBe(1);
		expect(compose?.diff).toContain("+    image: draft");
		const worker = changes.find(
			(change) => change.path === "apps/run/shop-worker.sh",
		);
		expect(worker?.status).toBe("added");
		// One file's diff is answered from that file alone: the single-path read
		// the diff popup goes through (`PERF-001`).
		expect(
			setupDraftChange(configDir, draftDir, "apps/compose/shop-compose.yml")
				?.diff,
		).toContain("+    image: draft");
		expect(
			setupDraftChange(configDir, draftDir, "apps/run/missing.sh"),
		).toBeUndefined();
	});

	test("a replaced shared service definition is flagged for every app", () => {
		const { configDir, draftDir } = fixture();
		const changes = setupDraftChanges(configDir, draftDir);
		const postgres = changes.find(
			(change) => change.path === "infrastructure/definitions/postgres.json",
		);
		expect(postgres?.sharedInfrastructure).toBe(true);
		expect(
			sharedInfrastructureChange({
				newPath: postgres?.path ?? "",
				newFile: false,
			}),
		).toBe(true);
		expect(
			sharedInfrastructureChange({
				newPath: "infrastructure/definitions/new-service.json",
				newFile: true,
			}),
		).toBe(false);
		expect(
			sharedInfrastructureChange({
				newPath: "apps/compose/shop-compose.yml",
				newFile: false,
			}),
		).toBe(false);
	});

	test("a workflow id or draft path that leaves the drafts root is refused", () => {
		const configDir = tempDir("env-setup-approval-");
		for (const id of ["../../etc", "/etc", "..", "wf/../../etc", "WF"]) {
			expect(() => setupDraftsDir(configDir, id)).toThrow();
		}
		// The refusal is not a matter of the id being unknown: a well-formed id
		// resolves, and only a directory under the drafts root is accepted.
		const draftsDir = setupDraftsDir(configDir, "wf-plain");
		expect(
			draftsDir.startsWith(path.join(configDir, ".drafts", "env-setup")),
		).toBe(true);
		expect(() =>
			assertSetupDraftsDir(configDir, tempDir("elsewhere-")),
		).toThrow("outside");
		expect(() => draftPathWithin(draftsDir, "../../../etc/passwd")).toThrow(
			"outside the drafts directory",
		);
		expect(() => draftPathWithin(draftsDir, "/etc/passwd")).toThrow(
			"outside the drafts directory",
		);
		expect(draftPathWithin(draftsDir, "apps/run/a.sh")).toBe(
			path.join(draftsDir, "apps", "run", "a.sh"),
		);
	});

	test("only the documented configuration paths are promotable", () => {
		expect(isAllowedDraftPath("apps/compose/shop-compose.yml")).toBe(true);
		expect(isAllowedDraftPath("apps/kubernetes/shop-prod.k8s.json")).toBe(true);
		expect(isAllowedDraftPath("infrastructure/definitions/postgres.json")).toBe(
			true,
		);
		expect(isAllowedDraftPath(".env")).toBe(false);
		expect(isAllowedDraftPath("providers/anthropic.json")).toBe(false);
		expect(isAllowedDraftPath("apps/compose/../../.env")).toBe(false);
	});

	test("an observation for a workflow the store does not know is refused", () => {
		const repo = tempDir("env-setup-approval-repo-");
		execFileSync("git", ["init", "-q", "-b", "main"], { cwd: repo });
		expect(() => loadSetupDraftChanges(repo, "wf-unknown")).toThrow();
	});
});

describe("env-setup approval row mapping", () => {
	test("a draft change becomes the row the popup renders", () => {
		const rows = setupDraftRows([
			{
				path: "apps/compose/shop-compose.yml",
				status: "modified",
				sharedInfrastructure: false,
				linesAdded: 2,
				linesDeleted: 1,
				diff: "…",
			},
			{
				path: "infrastructure/definitions/postgres.json",
				status: "added",
				sharedInfrastructure: false,
				linesAdded: 4,
				linesDeleted: 0,
				diff: "…",
			},
		]);
		expect(rows).toEqual([
			{
				newPath: "apps/compose/shop-compose.yml",
				oldPath: "apps/compose/shop-compose.yml",
				linesAdded: 2,
				linesDeleted: 1,
				newFile: false,
				deletedFile: false,
				renamedFile: false,
			},
			{
				newPath: "infrastructure/definitions/postgres.json",
				oldPath: "infrastructure/definitions/postgres.json",
				linesAdded: 4,
				linesDeleted: 0,
				newFile: true,
				deletedFile: false,
				renamedFile: false,
			},
		]);
	});
});

// TQ-201: the loaders themselves, over a repository that records the workflow
// (the authorization path the popup goes through), not only their helpers.
describe("env-setup observation loaders", () => {
	const start = (
		repo: string,
		workflowId: string,
		setupDraftsDir?: string,
	): void => {
		const engine = new WorkflowEngine(registerBuiltins());
		engine.start({
			repo,
			workflowId,
			definitionId: "env-setup",
			definitionVersion: definitionVersionForFamilyTraits(6),
			mode: "checkout",
			metadata: {
				branch: "main",
				baseBranch: "main",
				baseCommit: "base",
				app: "shop",
				...(setupDraftsDir ? { setupDraftsDir } : {}),
			},
			routing: {
				defaultProfile: "test",
				routes: [
					{
						stepId: "setup.author",
						role: "env-setup",
						profile: {
							name: "test",
							runtime: "pi-durable" as const,
							executable: "sh",
							tools: [],
							extensions: [],
							readOnly: false,
							capabilities: [
								"prompt",
								"run-environment",
								"observe",
								"shell",
								"edit",
							] as const,
							digest: "profile",
						},
					},
				],
				diversity: [],
			},
		} as never);
	};

	const liveRepo = (): string => {
		const repo = tempDir("env-setup-observations-repo-");
		execFileSync("git", ["init", "-q", "-b", "main"], { cwd: repo });
		fs.writeFileSync(path.join(repo, "README.md"), "# repo\n");
		execFileSync("git", ["add", "."], { cwd: repo });
		execFileSync(
			"git",
			[
				"-c",
				"user.email=t@example.com",
				"-c",
				"user.name=t",
				"commit",
				"-qm",
				"init",
			],
			{ cwd: repo },
		);
		return repo;
	};

	test("a pinned workflow's drafts are listed and diffed, not its live files", () => {
		const configDir = tempDir("env-setup-observations-config-");
		const repo = liveRepo();
		const workflowId = "wf-observations";
		const draftsDir = setupDraftsDir(configDir, workflowId);
		const previousRoot = process.env.AGENTIC_CODING_CONFIG_DIR;
		process.env.AGENTIC_CODING_CONFIG_DIR = configDir;
		try {
			writeFile(
				path.join(configDir, "apps", "compose", "shop-compose.yml"),
				"services:\n  shop:\n    image: live\n",
			);
			writeFile(
				path.join(draftsDir, "apps", "compose", "shop-compose.yml"),
				"services:\n  shop:\n    image: draft\n",
			);
			writeFile(
				path.join(draftsDir, "apps", "run", "shop-worker.sh"),
				"echo worker\n",
			);
			start(repo, workflowId, draftsDir);
			const rows = loadSetupDraftChanges(repo, workflowId);
			expect(rows.map((row) => row.newPath)).toEqual([
				"apps/compose/shop-compose.yml",
				"apps/run/shop-worker.sh",
			]);
			expect(rows[0]?.newFile).toBe(false);
			expect(rows[1]?.newFile).toBe(true);
			expect(rows[1]?.linesAdded).toBe(1);
			// The diff is the draft's, and an unknown path is refused.
			expect(
				loadSetupDraftDiff(repo, workflowId, "apps/compose/shop-compose.yml"),
			).toContain("+    image: draft");
			expect(() =>
				loadSetupDraftDiff(repo, workflowId, "apps/run/missing.sh"),
			).toThrow("no draft named");
			// The rows come from the drafts: changing the live file changes nothing.
			writeFile(
				path.join(configDir, "apps", "compose", "shop-compose.yml"),
				"services:\n  shop:\n    image: live-edited\n",
			);
			expect(loadSetupDraftChanges(repo, workflowId)).toEqual(rows);
		} finally {
			if (previousRoot === undefined)
				delete process.env.AGENTIC_CODING_CONFIG_DIR;
			else process.env.AGENTIC_CODING_CONFIG_DIR = previousRoot;
		}
	});

	test("a workflow whose snapshot predates the pin resolves the derived root", () => {
		const configDir = tempDir("env-setup-observations-config-");
		const repo = liveRepo();
		const workflowId = "wf-observations-fallback";
		const previousRoot = process.env.AGENTIC_CODING_CONFIG_DIR;
		process.env.AGENTIC_CODING_CONFIG_DIR = configDir;
		try {
			writeFile(
				path.join(
					setupDraftsDir(configDir, workflowId),
					"apps",
					"run",
					"shop-worker.sh",
				),
				"echo worker\n",
			);
			start(repo, workflowId);
			expect(
				loadSetupDraftChanges(repo, workflowId).map((row) => row.newPath),
			).toEqual(["apps/run/shop-worker.sh"]);
		} finally {
			if (previousRoot === undefined)
				delete process.env.AGENTIC_CODING_CONFIG_DIR;
			else process.env.AGENTIC_CODING_CONFIG_DIR = previousRoot;
		}
	});

	test("the engine's own pin decides, not a value the caller names", () => {
		const configDir = tempDir("env-setup-observations-config-");
		const repo = liveRepo();
		const previousRoot = process.env.AGENTIC_CODING_CONFIG_DIR;
		process.env.AGENTIC_CODING_CONFIG_DIR = configDir;
		try {
			// A caller cannot point the workflow's drafts anywhere: the engine pins
			// the configuration's own drafts root at start, and that is what the
			// popup reads. (A store written by another build is refused on read —
			// `assertSetupDraftsDir` — which `test/env-setup-overlay.test.ts` covers
			// for the resolver.)
			const derived = setupDraftsDir(configDir, "wf-observations-foreign");
			writeFile(
				path.join(derived, "apps", "run", "shop-worker.sh"),
				"echo worker\n",
			);
			start(repo, "wf-observations-foreign", "/elsewhere/drafts");
			expect(
				loadSetupDraftChanges(repo, "wf-observations-foreign").map(
					(row) => row.newPath,
				),
			).toEqual(["apps/run/shop-worker.sh"]);
		} finally {
			if (previousRoot === undefined)
				delete process.env.AGENTIC_CODING_CONFIG_DIR;
			else process.env.AGENTIC_CODING_CONFIG_DIR = previousRoot;
		}
	});
});
