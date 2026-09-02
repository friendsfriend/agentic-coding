/** @jsxImportSource @opentui/solid */
import { afterEach, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { KeyEvent } from "@opentui/core";
import { testRender } from "@opentui/solid";
import { ChangedFilesBrowser } from "../../src/tui/dash/ui/ChangedFilesBrowser";
import { registerBuiltins } from "../../src/workflow/definitions";
import { WorkflowEngine } from "../../src/workflow/runtime";

function key(name: string, extra: { sequence?: string } = {}): KeyEvent {
	return new KeyEvent({
		name,
		ctrl: false,
		meta: false,
		shift: false,
		option: false,
		sequence: extra.sequence ?? name,
		number: false,
		raw: extra.sequence ?? name,
		eventType: "press",
		source: "raw",
	});
}

const roots: string[] = [];
const runGit = (repo: string, ...args: string[]) =>
	execFileSync("git", args, { cwd: repo, stdio: "pipe" }).toString().trim();

function fixture() {
	const repo = mkdtempSync(join(tmpdir(), "agent-dash-browser-"));
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
		workflowId: change,
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
}

afterEach(() => {
	for (const root of roots.splice(0))
		rmSync(root, { recursive: true, force: true });
});

test("changed-files browser lists files, opens diffs, and Escape returns then closes", async () => {
	const repo = fixture();
	writeState(repo);
	writeFileSync(join(repo, "tracked.ts"), "const value = 2;\n");
	let closed = false;
	let handler: ((event: KeyEvent) => boolean) | undefined;
	const t = await testRender(
		() => (
			<ChangedFilesBrowser
				title="Changed files · review"
				repo={repo}
				change="review"
				onKeyReady={(h) => {
					handler = h;
				}}
				onClose={() => {
					closed = true;
				}}
			/>
		),
		{ width: 110, height: 30 },
	);
	await t.flush();
	const listFrame = t.captureCharFrame();
	expect(listFrame).toContain("Changed Files");
	expect(listFrame).toContain("tracked.ts");

	handler?.(key("enter")); // open diff for tracked.ts
	await t.flush();
	expect(t.captureCharFrame()).toContain("- const value = 1;");

	handler?.(key("escape")); // back to the file list, selection preserved
	await t.flush();
	expect(t.captureCharFrame()).toContain("tracked.ts");

	handler?.(key("escape")); // close the browser
	await t.flush();
	expect(closed).toBe(true);
	t.renderer.destroy();
});

test("changed-files browser keeps search and empty state working", async () => {
	const repo = fixture();
	writeState(repo);
	writeFileSync(join(repo, "tracked.ts"), "const value = 2;\n");
	writeFileSync(join(repo, "other.ts"), "export {};\n");
	let handler: ((event: KeyEvent) => boolean) | undefined;
	const t = await testRender(
		() => (
			<ChangedFilesBrowser
				title="Changed files · review"
				repo={repo}
				change="review"
				onKeyReady={(h) => {
					handler = h;
				}}
				onClose={() => {}}
			/>
		),
		{ width: 110, height: 30 },
	);
	await t.flush();

	handler?.(key("/", { sequence: "/" })); // enter search mode
	for (const character of "other")
		handler?.(key(character, { sequence: character }));
	await t.flush();
	const filtered = t.captureCharFrame();
	expect(filtered).toContain("other.ts");
	expect(filtered).not.toContain("tracked.ts");

	handler?.(key("escape"));
	await t.flush();
	expect(t.captureCharFrame()).toContain("tracked.ts"); // filter cleared
	t.renderer.destroy();
});

test("changed-files browser shows the existing empty state for clean worktrees", async () => {
	const repo = fixture();
	writeState(repo);
	let handler: ((event: KeyEvent) => boolean) | undefined;
	const t = await testRender(
		() => (
			<ChangedFilesBrowser
				title="Changed files · review"
				repo={repo}
				change="review"
				onKeyReady={(h) => {
					handler = h;
				}}
				onClose={() => {}}
			/>
		),
		{ width: 110, height: 30 },
	);
	await t.flush();
	expect(t.captureCharFrame()).toContain("No changed files");
	handler?.(key("escape")); // still closable when there is nothing to show
	await t.flush();
	t.renderer.destroy();
});
