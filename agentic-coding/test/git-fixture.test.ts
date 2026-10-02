// The shared repository fixture is imported by 23 test files and, inside one
// `bun test` process, by several of them at once. That makes its lifecycle the
// thing worth testing rather than its output: an earlier version reclaimed its
// template root from a hook registered by this imported module, which is
// file-scoped (measured: it fires after the first file that imported it), so the
// second file in the same process found its template deleted and failed with
// ENOENT. `bun test test/workflow-migration.test.ts test/canonical-repository.test.ts`
// went from 22 pass to 4 pass / 18 fail.
//
// This file points the template store at a root of its own. It must not delete
// the machine-wide one: `scripts/test.ts` runs six processes concurrently, that
// root is shared, and removing it makes the copy fail inside whichever sibling
// is copying at that instant (measured: 10 failures across 4 unrelated files).
import { afterEach, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
	createRepoFixture,
	createTempRepoFixture,
	removeRepoFixture,
	repoPreset,
} from "./support/git-fixture.ts";

const ORIGINAL_TEMPLATE_ROOT = process.env.AGENTIC_CODING_TEST_TEMPLATE_ROOT;
const created: string[] = [];

/** Point the fixture at a private template root for the duration of one test. */
function withPrivateTemplateRoot(): string {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "fixture-templates-"));
	process.env.AGENTIC_CODING_TEST_TEMPLATE_ROOT = root;
	created.push(root);
	return root;
}

function repo(prefix: string, options = {}): string {
	const root = createTempRepoFixture(prefix, options);
	created.push(root);
	return root;
}

function isWorkingRepo(root: string): boolean {
	try {
		return (
			execFileSync("git", ["rev-parse", "--is-inside-work-tree"], {
				cwd: root,
				encoding: "utf8",
				stdio: ["ignore", "pipe", "pipe"],
			}).trim() === "true"
		);
	} catch {
		return false;
	}
}

afterEach(() => {
	if (ORIGINAL_TEMPLATE_ROOT === undefined)
		delete process.env.AGENTIC_CODING_TEST_TEMPLATE_ROOT;
	else process.env.AGENTIC_CODING_TEST_TEMPLATE_ROOT = ORIGINAL_TEMPLATE_ROOT;
	for (const root of created.splice(0)) removeRepoFixture(root);
});

test("materialises independent repositories in one process", () => {
	const first = repo("fixture-a-");
	const second = repo("fixture-b-", repoPreset.specDriven);
	expect(isWorkingRepo(first)).toBe(true);
	expect(isWorkingRepo(second)).toBe(true);
	expect(fs.existsSync(path.join(first, ".git"))).toBe(true);
	expect(fs.existsSync(path.join(second, "openspec", "config.yaml"))).toBe(
		true,
	);
});

test("rebuilds a template that was swept out from under it", () => {
	// The failure mode this guards: a template directory removed by something
	// other than this module (a temp reaper, a crashed sibling) must degrade to a
	// rebuild, not to ENOENT from the copy.
	const root = withPrivateTemplateRoot();
	repo("fixture-sweep-a-", repoPreset.specDriven);
	fs.rmSync(root, { recursive: true, force: true });
	const rebuilt = repo("fixture-sweep-b-", repoPreset.specDriven);
	expect(isWorkingRepo(rebuilt)).toBe(true);
	expect(fs.existsSync(path.join(rebuilt, "openspec", "config.yaml"))).toBe(
		true,
	);
});

test("republishes a template whose published content went stale", () => {
	// The store is persisted and machine-wide, so it outlives the revision that
	// wrote it. A published template altered by an older build (or a missed
	// version bump) must be detected and rebuilt, because almost no test asserts
	// a fixture's contents and the wrong content would otherwise be served
	// silently for as long as the temp directory keeps it.
	withPrivateTemplateRoot();
	const options = { files: { "README.md": "fresh\n" } };
	const first = repo("fixture-stale-a-", options);
	expect(fs.readFileSync(path.join(first, "README.md"), "utf8")).toBe(
		"fresh\n",
	);
	// Corrupt every published template for this request behind the module's back.
	const store = process.env.AGENTIC_CODING_TEST_TEMPLATE_ROOT ?? "";
	for (const entry of fs.readdirSync(store)) {
		const target = path.join(store, entry);
		if (!fs.statSync(target).isDirectory()) continue;
		fs.writeFileSync(path.join(target, "README.md"), "STALE\n");
	}
	const second = repo("fixture-stale-b-", options);
	expect(fs.readFileSync(path.join(second, "README.md"), "utf8")).toBe(
		"fresh\n",
	);
});

test("registers no process-wide teardown of its own", () => {
	// Observed rather than grepped: the defect was a hook that fired on another
	// file's schedule, so the property to hold is that materialising and
	// disposing a fixture leaves this process's listener set exactly as it was.
	const before = ["exit", "SIGINT", "SIGTERM", "beforeExit"].map((event) =>
		process.listenerCount(event),
	);
	const one = repo("fixture-listeners-");
	removeRepoFixture(one);
	const two = createRepoFixture(
		fs.mkdtempSync(path.join(os.tmpdir(), "fixture-listeners-b-")),
		repoPreset.readme,
	);
	removeRepoFixture(two);
	const after = ["exit", "SIGINT", "SIGTERM", "beforeExit"].map((event) =>
		process.listenerCount(event),
	);
	expect(after).toEqual(before);
});
