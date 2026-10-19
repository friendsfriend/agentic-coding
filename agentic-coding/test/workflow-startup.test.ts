import { describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type {
	WorkflowExecutionSettings,
	WorkflowSnapshot,
} from "../src/contracts/workflow.ts";
import { resolveClassifierBinding } from "../src/workflow/classifier-runner.ts";
import { definitionVersionForStagedRoot } from "../src/workflow/definitions/manifest-policy.ts";
import { effectRunnerTest } from "../src/workflow/effect-runner.ts";
import {
	executionSettings,
	loadConfigWithProvenance,
	saveAgentsSection,
	settingsFingerprint,
} from "../src/workflow/effects.ts";
import { parseAgentsConfig } from "../src/workflow/profiles.ts";
import {
	prepareWorkflowStart,
	taskReferenceSuffix,
} from "../src/workflow/startup.ts";
import {
	autoRemoveRepoFixtures,
	commitRepoFixture,
	createTempRepoFixture,
} from "./support/git-fixture.ts";

// Sweep the repositories this file created, at the end of this file only.
autoRemoveRepoFixtures();

function repository(): string {
	return createTempRepoFixture("workflow-startup-", {
		files: { "README.md": "startup\n" },
	});
}

const config = `${JSON.stringify({
	workflow: { remote: "selected-remote", pr_tool: "missing-pr-tool" },
	agents: {
		default_profile: "p",
		profiles: { p: { runtime: "pi-durable", executable: "/bin/true" } },
		presets: {
			fixed: {
				default_profile: "p",
				pools: {
					"core.wiki": [{ label: "only", profile: "p", default: true }],
					"core.research": [{ label: "only", profile: "p", default: true }],
				},
			},
		},
	},
})}\n`;

/** A coverage-validating preset over the keys the started definitions ask
 * about: every classifiable step needs a pool, so a family that never had one
 * before now fails a preset-less start with the step named. */
function fixedPools(stepIds: readonly string[]): Record<string, unknown[]> {
	return Object.fromEntries(
		stepIds.map((stepId) => [
			stepId,
			[{ label: "only", profile: "p", default: true }],
		]),
	);
}

function presetConfig(stepIds: readonly string[], provider?: string): string {
	return `${JSON.stringify({
		agents: {
			default_profile: "p",
			profiles: { p: { runtime: "pi-durable", executable: "/bin/true" } },
			presets: { fixed: { default_profile: "p", pools: fixedPools(stepIds) } },
			...(provider ? { classifier: { provider } } : {}),
		},
	})}\n`;
}

describe("classifier provider pinning", () => {
	test("the selected provider is pinned at start and survives a config edit", () => {
		const repo = repository();
		const file = path.join(repo, "config.json");
		const write = (provider: string) => {
			fs.writeFileSync(
				file,
				presetConfig(["core.wiki", "core.research"], provider),
			);
		};
		const previous = process.env.HERDR_WORKFLOW_CONFIG;
		process.env.HERDR_WORKFLOW_CONFIG = file;
		try {
			write("laya-local");
			const started = prepareWorkflowStart({
				repo,
				workflowId: "pin-local",
				definitionId: "wiki",
				task: "pin the local classifier",
				mode: "checkout",
				preset: "fixed",
			});
			expect(started.input.metadata.classifier).toBe("laya-local");
			// A mid-run edit to the config must not switch the running workflow's
			// endpoint. Resolve the binding the way the effect handler does — from the
			// stored pin plus the *current* config — so this cannot pass by re-reading
			// the materialized string.
			write("opencode-zen");
			const liveAgents = parseAgentsConfig(
				(
					JSON.parse(fs.readFileSync(file, "utf8")) as {
						agents: unknown;
					}
				).agents,
			);
			const pinned = effectRunnerTest.pinnedClassifierProvider({
				metadata: started.input.metadata,
			} as unknown as WorkflowSnapshot);
			expect(pinned).toBe("laya-local");
			expect(resolveClassifierBinding(liveAgents, pinned).provider).toBe(
				"laya-local",
			);
			const next = prepareWorkflowStart({
				repo,
				workflowId: "pin-hosted",
				definitionId: "wiki",
				task: "pin the hosted classifier",
				mode: "checkout",
				preset: "fixed",
			});
			expect(next.input.metadata.classifier).toBe("opencode-zen");
		} finally {
			if (previous === undefined) delete process.env.HERDR_WORKFLOW_CONFIG;
			else process.env.HERDR_WORKFLOW_CONFIG = previous;
			fs.rmSync(repo, { recursive: true, force: true });
		}
	});
});

describe("shared workflow startup", () => {
	test("a task reference becomes the task text before the start guard runs", () => {
		// A referenced change passes the same start guard, preset and branch rules
		// as an inline task: the reference is resolved into text first, so nothing
		// downstream can tell (or trust) the difference.
		const repo = repository();
		const change = path.join(repo, "openspec", "changes", "add-flag");
		fs.mkdirSync(change, { recursive: true });
		fs.writeFileSync(
			path.join(change, "proposal.md"),
			"# Add the flag\n\n## Why\n\nNo flag yet.\n",
		);
		fs.writeFileSync(
			path.join(change, "tasks.md"),
			"## 1. Work\n\n- [ ] 1.1 Add the flag\n",
		);
		commitRepoFixture(repo, "add the change");
		const file = path.join(os.tmpdir(), `startup-task-ref-${process.pid}.json`);
		fs.writeFileSync(file, presetConfig(["core.wiki", "core.research"]));
		const previous = process.env.HERDR_WORKFLOW_CONFIG;
		process.env.HERDR_WORKFLOW_CONFIG = file;
		try {
			const prepared = prepareWorkflowStart({
				repo,
				workflowId: "task-ref",
				definitionId: "wiki",
				taskRef: { change: "add-flag" },
				mode: "checkout",
				preset: "fixed",
			});
			expect(prepared.input.metadata.task).toContain("## Why");
			expect(prepared.input.metadata.task).toContain("- [ ] 1.1 Add the flag");
			expect(prepared.taskReference).toEqual({
				change: "add-flag",
				taskChars: (prepared.input.metadata.task ?? "").length,
			});
			// The answer names the resolved source, so a reference that resolved to
			// the wrong change is visible instead of silent.
			expect(taskReferenceSuffix(prepared)).toBe(
				` — task from change "add-flag", ${(prepared.input.metadata.task ?? "").length} task chars`,
			);
			// A reference resolves before the guard, so an unknown change is refused
			// with its candidates rather than starting a workflow with no task.
			expect(() =>
				prepareWorkflowStart({
					repo,
					workflowId: "task-ref-missing",
					definitionId: "wiki",
					taskRef: { change: "add-flaggs" },
					mode: "checkout",
					preset: "fixed",
				}),
			).toThrow(/matches no active OpenSpec change/);
		} finally {
			if (previous === undefined) delete process.env.HERDR_WORKFLOW_CONFIG;
			else process.env.HERDR_WORKFLOW_CONFIG = previous;
			fs.rmSync(file, { force: true });
			fs.rmSync(repo, { recursive: true, force: true });
		}
	});

	test("normalizes repository-backed startup and pins config provenance", () => {
		const repo = repository();
		const file = path.join(repo, "config.json");
		fs.writeFileSync(file, config);
		const previous = process.env.HERDR_WORKFLOW_CONFIG;
		process.env.HERDR_WORKFLOW_CONFIG = file;
		try {
			const prepared = prepareWorkflowStart({
				repo,
				workflowId: "startup-test",
				definitionId: "wiki",
				task: "document startup",
				mode: "checkout",
				preset: "fixed",
			});
			expect(prepared.input.repo).toBe(fs.realpathSync(repo));
			expect(prepared.input.metadata.executionSettings?.remote).toBe(
				"selected-remote",
			);
			expect(prepared.input.metadata.executionSettings?.prTool).toBeNull();
			expect(prepared.provenance.source).toBe("environment");
			expect(() =>
				prepareWorkflowStart({
					workflowId: "research-test",
					definitionId: "research",
					preset: "fixed",
				}),
			).toThrow(/research workflow requires non-empty task/);
			const research = prepareWorkflowStart({
				workflowId: "research-tools",
				definitionId: "research",
				task: "research with all runtime tools",
				preset: "fixed",
			});
			const researcher = research.input.routing.routes.find(
				(route) => route.role === "researcher",
			)?.profile;
			expect(research.input.definitionVersion).toBeGreaterThanOrEqual(701);
			expect(researcher?.readOnly).toBe(false);
			expect(researcher?.capabilities).toContain("shell");
			expect(researcher?.capabilities).toContain("edit");
		} finally {
			if (previous === undefined) delete process.env.HERDR_WORKFLOW_CONFIG;
			else process.env.HERDR_WORKFLOW_CONFIG = previous;
			fs.rmSync(repo, { recursive: true, force: true });
		}
	});

	test("pins who started the workflow, defaulting to the operator", () => {
		const repo = repository();
		const file = path.join(repo, "config.json");
		fs.writeFileSync(file, config);
		const previous = process.env.HERDR_WORKFLOW_CONFIG;
		process.env.HERDR_WORKFLOW_CONFIG = file;
		try {
			const operator = prepareWorkflowStart({
				repo,
				workflowId: "attribution-operator",
				definitionId: "wiki",
				task: "document startup",
				mode: "checkout",
				preset: "fixed",
			});
			// A caller that says nothing is the operator: the pin is written
			// explicitly instead of left absent for every reader to infer.
			expect(operator.input.metadata.startedBy).toBe("developer");
			const orchestrated = prepareWorkflowStart({
				repo,
				workflowId: "attribution-orchestrator",
				definitionId: "wiki",
				task: "document startup",
				mode: "checkout",
				preset: "fixed",
				startedBy: "orchestrator",
			});
			expect(orchestrated.input.metadata.startedBy).toBe("orchestrator");
		} finally {
			if (previous === undefined) delete process.env.HERDR_WORKFLOW_CONFIG;
			else process.env.HERDR_WORKFLOW_CONFIG = previous;
			fs.rmSync(repo, { recursive: true, force: true });
		}
	});

	test("loads the selected repository overlay and writes agents to that source", () => {
		const repo = fs.mkdtempSync(path.join(os.tmpdir(), "workflow-config-"));
		const project = path.join(repo, ".pi");
		fs.mkdirSync(project, { recursive: true });
		const file = path.join(project, "herdr-workflow.json");
		fs.writeFileSync(file, '{ "workflow": { "remote": "project-remote" } }\n');
		const envFile = path.join(repo, "selected-config.json");
		fs.writeFileSync(envFile, '{ "agents": {} }\n');
		const previous = process.env.HERDR_WORKFLOW_CONFIG;
		try {
			delete process.env.HERDR_WORKFLOW_CONFIG;
			const resolved = loadConfigWithProvenance(repo);
			expect(resolved.config.workflow.remote).toBe("project-remote");
			expect(resolved.provenance.source).toBe("project");
			process.env.HERDR_WORKFLOW_CONFIG = envFile;
			saveAgentsSection((agents) => {
				agents.default_profile = "selected";
			}, repo);
			expect(fs.readFileSync(envFile, "utf8")).toContain("default_profile");
		} finally {
			if (previous === undefined) delete process.env.HERDR_WORKFLOW_CONFIG;
			else process.env.HERDR_WORKFLOW_CONFIG = previous;
			fs.rmSync(repo, { recursive: true, force: true });
		}
	});

	test("records unavailable PR tooling in the pinned execution settings", () => {
		const pinned: WorkflowExecutionSettings = executionSettings(
			{
				workflow: {
					max_verification_rounds: 1,
					remote: "origin",
					branch_prefix: "feature/",
					base_branch: "origin/HEAD",
					pr_tool: "definitely-not-installed",
				},
				telemetry: { capture_content: false },
				ui: { theme: "x", selection_height: 1 },
			},
			{ source: "project", files: ["project.toml"] },
		);
		expect(pinned.prTool).toBeNull();
		expect(settingsFingerprint(pinned)).toHaveLength(64);
		expect(settingsFingerprint({ ...pinned, remote: "changed" })).not.toBe(
			settingsFingerprint(pinned),
		);
	});
});

test("a new start resolves the staged-configuration-root definition tier", () => {
	const repo = repository();
	execFileSync("git", ["remote", "add", "origin", repo], { cwd: repo });
	execFileSync("git", ["fetch", "-q", "origin"], { cwd: repo });
	execFileSync("git", ["remote", "set-head", "origin", "main"], { cwd: repo });
	const previous = process.env.HERDR_WORKFLOW_CONFIG;
	// Outside the repository: a config file inside the worktree would make the
	// start fail its clean-tree check.
	const file = path.join(
		fs.mkdtempSync(path.join(os.tmpdir(), "workflow-startup-cfg-")),
		"config.json",
	);
	process.env.HERDR_WORKFLOW_CONFIG = file;
	fs.writeFileSync(
		file,
		presetConfig([
			"core.implementation",
			"core.triage",
			"core.verification",
			"core.wiki",
			"core.research",
		]),
	);
	try {
		// The family-traits tier is the version a new start resolves, whichever
		// family it is: research included, whose tool policy that tier applies too.
		expect(
			prepareWorkflowStart({
				workflowId: "routed-tier",
				definitionId: "no-openspec",
				task: "routed tier",
				repo,
				preset: "fixed",
			}).input.definitionVersion,
		).toBe(definitionVersionForStagedRoot(6));
		expect(
			prepareWorkflowStart({
				workflowId: "research-tier",
				definitionId: "research",
				task: "research tier",
				preset: "fixed",
			}).input.definitionVersion,
		).toBe(definitionVersionForStagedRoot(6));
	} finally {
		if (previous === undefined) delete process.env.HERDR_WORKFLOW_CONFIG;
		else process.env.HERDR_WORKFLOW_CONFIG = previous;
		fs.rmSync(repo, { recursive: true, force: true });
	}
});

// The env-setup family's start boundary (`add-environment-setup-workflow`,
// task 2.3): the configured app is required and pinned, the launch is forced
// into checkout mode, and the engine seeds the drafts root with it.
describe("environment-setup startup", () => {
	test("requires --app, pins it, and refuses a worktree launch", async () => {
		const repo = repository();
		// The configuration lives outside the checkout: this family requires a
		// clean worktree, and a config file inside it would break that rule.
		const configDir = fs.mkdtempSync(
			path.join(os.tmpdir(), "env-setup-config-"),
		);
		const file = path.join(configDir, "config.json");
		fs.writeFileSync(file, config);
		const previous = process.env.HERDR_WORKFLOW_CONFIG;
		process.env.HERDR_WORKFLOW_CONFIG = file;
		try {
			expect(() =>
				prepareWorkflowStart({
					workflowId: "env-setup-no-app",
					definitionId: "env-setup",
					repo,
					mode: "checkout",
				}),
			).toThrow("requires --app");
			expect(() =>
				prepareWorkflowStart({
					workflowId: "env-setup-app-ident",
					definitionId: "env-setup",
					repo,
					mode: "checkout",
					app: "../../etc",
				}),
			).toThrow("app ident");
			// A family that writes outside the checkout never uses a worktree.
			expect(() =>
				prepareWorkflowStart({
					workflowId: "env-setup-worktree",
					definitionId: "env-setup",
					repo,
					mode: "worktree",
					app: "shop",
				}),
			).toThrow("checkout mode");
			// A workflow id whose predecessor was deleted leaves its drafts behind:
			// the new start refuses them instead of adopting them as its own work.
			const leftover = path.join(
				process.env.AGENTIC_CODING_CONFIG_DIR ?? "",
				".drafts",
				"env-setup",
				"env-setup-leftover",
			);
			fs.mkdirSync(leftover, { recursive: true });
			fs.writeFileSync(path.join(leftover, "notes.md"), "old drafts\n");
			expect(() =>
				prepareWorkflowStart({
					workflowId: "env-setup-leftover",
					definitionId: "env-setup",
					repo,
					mode: "checkout",
					app: "shop",
				}),
			).toThrow("earlier workflow");
			fs.rmSync(leftover, { recursive: true, force: true });

			// Stale state of a workflow no store knows is swept on the next start
			// (housekeeping runs off the start's path, so the removal is awaited
			// here with a bounded poll).
			const stale = path.join(
				process.env.AGENTIC_CODING_CONFIG_DIR ?? "",
				".drafts",
				"env-setup",
				"env-setup-deleted",
			);
			fs.mkdirSync(path.join(stale, "root", "apps"), { recursive: true });
			fs.writeFileSync(path.join(stale, "base.json"), "{}\n");
			prepareWorkflowStart({
				workflowId: "env-setup-sweep",
				definitionId: "env-setup",
				repo,
				mode: "checkout",
				app: "shop",
			});
			for (let attempt = 0; attempt < 100 && fs.existsSync(stale); attempt++)
				await Bun.sleep(20);
			expect(fs.existsSync(stale)).toBe(false);

			const started = prepareWorkflowStart({
				workflowId: "env-setup-pinned",
				definitionId: "env-setup",
				repo,
				mode: "checkout",
				app: " shop ",
			});
			expect(started.input.metadata.app).toBe("shop");
			expect(started.input.definitionVersion).toBe(
				definitionVersionForStagedRoot(6),
			);
			expect(started.target).toBe(fs.realpathSync(repo));
		} finally {
			if (previous === undefined) delete process.env.HERDR_WORKFLOW_CONFIG;
			else process.env.HERDR_WORKFLOW_CONFIG = previous;
			fs.rmSync(repo, { recursive: true, force: true });
			fs.rmSync(configDir, { recursive: true, force: true });
		}
	});
});

// The debug family's start boundary (`add-debug-workflow`, task 3.3): the
// selected branch is required and must exist, it is forwarded as the branch the
// detached worktree is created at, and the family runs in worktree mode.
describe("debug startup", () => {
	test("requires an existing branch, forwards it, and keeps worktree mode", () => {
		const repo = repository();
		const file = path.join(repo, "config.json");
		fs.writeFileSync(file, config);
		const current = Bun.spawnSync([
			"git",
			"-C",
			repo,
			"branch",
			"--show-current",
		])
			.stdout.toString()
			.trim();
		const previous = process.env.HERDR_WORKFLOW_CONFIG;
		process.env.HERDR_WORKFLOW_CONFIG = file;
		try {
			expect(() =>
				prepareWorkflowStart({
					repo,
					workflowId: "debug-no-branch",
					definitionId: "debug",
					task: "reproduce the bug",
					mode: "worktree",
					preset: "fixed",
				}),
			).toThrow(/debug workflow requires --branch/);
			expect(() =>
				prepareWorkflowStart({
					repo,
					workflowId: "debug-bad-branch",
					definitionId: "debug",
					task: "reproduce the bug",
					mode: "worktree",
					preset: "fixed",
					sourceBranch: "does-not-exist",
				}),
			).toThrow(/debug branch does not exist/);
			// A ref whose name begins with `-` would be read as a git option by the
			// detached worktree creation; it is refused before that.
			expect(() =>
				prepareWorkflowStart({
					repo,
					workflowId: "debug-option-branch",
					definitionId: "debug",
					task: "reproduce the bug",
					mode: "worktree",
					preset: "fixed",
					sourceBranch: "--force",
				}),
			).toThrow(/must not begin with '-'/);
			const started = prepareWorkflowStart({
				repo,
				workflowId: "debug-pinned",
				definitionId: "debug",
				task: "reproduce the bug",
				mode: "worktree",
				preset: "fixed",
				sourceBranch: current,
			});
			expect(started.input.definitionId).toBe("debug");
			expect(started.input.metadata.branch).toBe(current);
			expect(started.input.metadata.task).toBe("reproduce the bug");
			expect(started.input.mode).toBe("worktree");
			// No `sameCheckout`: the family owns a detached worktree, never the
			// repository checkout.
			expect(started.input.sameCheckout).toBe(false);
			// The routing falls back to the preset's default profile: the `fixed`
			// preset declares no `debug.investigate` pool.
			const route = started.input.routing.routes.find(
				(candidate) => candidate.stepId === "debug.investigate",
			);
			expect(route?.profile.name).toBe("p");
		} finally {
			if (previous === undefined) delete process.env.HERDR_WORKFLOW_CONFIG;
			else process.env.HERDR_WORKFLOW_CONFIG = previous;
			fs.rmSync(repo, { recursive: true, force: true });
		}
	});
});
