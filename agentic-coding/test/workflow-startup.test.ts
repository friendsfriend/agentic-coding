import { describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { WorkflowExecutionSettings } from "../src/workflow/contracts.ts";
import {
	executionSettings,
	loadConfigWithProvenance,
	saveAgentsSection,
	settingsFingerprint,
} from "../src/workflow/effects.ts";
import {
	parseFusionProfiles,
	prepareWorkflowStart,
} from "../src/workflow/startup.ts";

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
`;

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
				}),
			).toThrow(/research workflow requires non-empty task/);
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
		const envFile = path.join(repo, "selected-config.toml");
		fs.writeFileSync(envFile, "[agents]\n");
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

	test("keeps explicit fusion profile order and records unavailable PR tooling", () => {
		expect(parseFusionProfiles(" one, two ")).toEqual(["one", "two"]);
		expect(() => parseFusionProfiles(undefined)).toThrow(/fusion-profiles/);
		const pinned: WorkflowExecutionSettings = executionSettings(
			{
				workflow: {
					max_verification_rounds: 1,
					remote: "origin",
					branch_prefix: "feature/",
					base_branch: "origin/HEAD",
					pr_tool: "definitely-not-installed",
				},
				projects: { root: "~", max_depth: 1 },
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
