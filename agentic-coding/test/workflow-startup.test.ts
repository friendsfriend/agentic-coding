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
import { definitionVersionForStepRouting } from "../src/workflow/definitions/manifest-policy.ts";
import { effectRunnerTest } from "../src/workflow/effect-runner.ts";
import {
	executionSettings,
	loadConfigWithProvenance,
	saveAgentsSection,
	settingsFingerprint,
} from "../src/workflow/effects.ts";
import { parseAgentsConfig } from "../src/workflow/profiles.ts";
import { prepareWorkflowStart } from "../src/workflow/startup.ts";

function repository(): string {
	const repo = fs.mkdtempSync(path.join(os.tmpdir(), "workflow-startup-"));
	execFileSync("git", ["init", "-q", "-b", "main"], { cwd: repo });
	fs.writeFileSync(path.join(repo, "README.md"), "startup\n");
	execFileSync("git", ["add", "."], { cwd: repo });
	execFileSync(
		"git",
		[
			"-c",
			"user.email=test@example.com",
			"-c",
			"user.name=Test",
			"commit",
			"-qm",
			"startup",
		],
		{ cwd: repo },
	);
	return repo;
}

const config = `[workflow]
remote = "selected-remote"
pr_tool = "missing-pr-tool"

[agents]
default_profile = "p"

[agents.profiles.p]
runtime = "pi"
executable = "/bin/true"

[agents.presets.fixed]
default_profile = "p"

[[agents.presets.fixed.pools."core.wiki"]]
label = "only"
profile = "p"
default = true

[[agents.presets.fixed.pools."core.research"]]
label = "only"
profile = "p"
default = true
`;

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
			profiles: { p: { runtime: "pi", executable: "/bin/true" } },
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
	test("normalizes repository-backed startup and pins config provenance", () => {
		const repo = repository();
		const file = path.join(repo, "config.toml");
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

	test("loads the selected repository overlay and writes agents to that source", () => {
		const repo = fs.mkdtempSync(path.join(os.tmpdir(), "workflow-config-"));
		const project = path.join(repo, ".pi");
		fs.mkdirSync(project, { recursive: true });
		const file = path.join(project, "herdr-workflow.toml");
		fs.writeFileSync(file, '[workflow]\nremote = "project-remote"\n');
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

test("a new start resolves the per-step routing definition tier", () => {
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
		// Per-step routing is the tier a new start resolves, whichever family it
		// is: research included, whose tool policy that tier applies too.
		expect(
			prepareWorkflowStart({
				workflowId: "routed-tier",
				definitionId: "no-openspec",
				task: "routed tier",
				repo,
				preset: "fixed",
			}).input.definitionVersion,
		).toBe(definitionVersionForStepRouting(6));
		expect(
			prepareWorkflowStart({
				workflowId: "research-tier",
				definitionId: "research",
				task: "research tier",
				preset: "fixed",
			}).input.definitionVersion,
		).toBe(definitionVersionForStepRouting(6));
	} finally {
		if (previous === undefined) delete process.env.HERDR_WORKFLOW_CONFIG;
		else process.env.HERDR_WORKFLOW_CONFIG = previous;
		fs.rmSync(repo, { recursive: true, force: true });
	}
});
