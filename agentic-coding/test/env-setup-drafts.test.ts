// The env-setup drafts directory (`add-environment-setup-workflow`): the
// per-file diff of the drafts against the live configuration, and the write
// guard's fingerprint and violation decision.
import { describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
	fingerprintCheckout,
	fingerprintDirectory,
	listDraftEntries,
	listDraftFiles,
	setupBackupDir,
	setupDraftChanges,
	setupDraftsDir,
	setupGuardViolations,
	unifiedDiff,
} from "../src/server/environment/setup-drafts.ts";

function tempDir(prefix: string): string {
	return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function writeFile(filePath: string, text: string): void {
	fs.mkdirSync(path.dirname(filePath), { recursive: true });
	fs.writeFileSync(filePath, text);
}

function runGit(cwd: string, args: string[]): void {
	const result = Bun.spawnSync(["git", ...args], {
		cwd,
		stdout: "ignore",
		stderr: "ignore",
		env: {
			...process.env,
			GIT_AUTHOR_NAME: "test",
			GIT_AUTHOR_EMAIL: "test@example.test",
			GIT_COMMITTER_NAME: "test",
			GIT_COMMITTER_EMAIL: "test@example.test",
		},
	});
	if (result.exitCode !== 0) throw new Error(`git ${args.join(" ")} failed`);
}

describe("draft layout and diff", () => {
	test("the drafts and backups directories are derived from the workflow id", () => {
		expect(setupDraftsDir("/config", "wf-1")).toBe(
			path.join("/config", ".drafts", "env-setup", "wf-1"),
		);
		expect(setupBackupDir("/config", "wf-1")).toBe(
			path.join("/config", ".backups", "env-setup-wf-1"),
		);
	});

	test("every drafted file is reported with its diff, status and shared-infra flag", () => {
		const configDir = tempDir("env-setup-changes-");
		// The drafts directory is the one the workflow's pin resolves: the module
		// refuses a directory outside the configuration's drafts root.
		const draftsDir = setupDraftsDir(configDir, "wf-1");
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
		expect(listDraftFiles(draftsDir)).toEqual([
			"apps/compose/shop-compose.yml",
			"apps/run/shop-worker.sh",
			"infrastructure/definitions/postgres.json",
		]);
		const changes = setupDraftChanges(configDir, draftsDir);
		const compose = changes.find(
			(change) => change.path === "apps/compose/shop-compose.yml",
		);
		expect(compose?.status).toBe("modified");
		expect(compose?.sharedInfrastructure).toBe(false);
		expect(compose?.diff).toContain("-    image: live");
		expect(compose?.diff).toContain("+    image: draft");
		expect(compose?.linesAdded).toBe(1);
		expect(compose?.linesDeleted).toBe(1);
		const postgres = changes.find(
			(change) => change.path === "infrastructure/definitions/postgres.json",
		);
		expect(postgres?.status).toBe("modified");
		expect(postgres?.sharedInfrastructure).toBe(true);
		const worker = changes.find(
			(change) => change.path === "apps/run/shop-worker.sh",
		);
		expect(worker?.status).toBe("added");
		expect(worker?.sharedInfrastructure).toBe(false);
		expect(worker?.diff).toContain("+echo worker");
	});

	test("an unchanged draft produces no diff", () => {
		expect(unifiedDiff("a.yml", "same\n", "same\n")).toBe("");
	});
});

describe("write guard", () => {
	/** This workflow's own state, as the guard effect passes it in. */
	const ownState = (configDir: string) => ({
		draftsDir: setupDraftsDir(configDir, "wf-1"),
		backupDir: setupBackupDir(configDir, "wf-1"),
		lockPath: path.join(configDir, ".backups", "env-setup-promote.lock"),
	});

	test("the fingerprint ignores exactly this workflow's own state", () => {
		const configDir = tempDir("env-setup-guard-");
		writeFile(
			path.join(configDir, "apps", "compose", "shop-compose.yml"),
			"a\n",
		);
		const exclusion = ownState(configDir);
		const before = fingerprintDirectory(configDir, exclusion);
		writeFile(path.join(exclusion.draftsDir, "apps", "run", "x.sh"), "draft\n");
		writeFile(
			path.join(exclusion.backupDir, "apps", "run", "x.sh"),
			"backup\n",
		);
		writeFile(exclusion.lockPath, "{}\n");
		expect(fingerprintDirectory(configDir, exclusion)).toBe(before);
		writeFile(
			path.join(configDir, "apps", "compose", "shop-compose.yml"),
			"b\n",
		);
		expect(fingerprintDirectory(configDir, exclusion)).not.toBe(before);
	});

	test("the exclusion is by path, never by name", () => {
		const configDir = tempDir("env-setup-guard-");
		const exclusion = ownState(configDir);
		const before = fingerprintDirectory(configDir, exclusion);
		// A live file whose name merely looks like the workflow's own state is a
		// change to the live configuration.
		writeFile(path.join(configDir, "env-setup-notes.json"), "{}\n");
		expect(fingerprintDirectory(configDir, exclusion)).not.toBe(before);
		const withNotes = fingerprintDirectory(configDir, exclusion);
		writeFile(
			path.join(configDir, "apps", "compose", "env-setup-tools-compose.yml"),
			"services: {}\n",
		);
		expect(fingerprintDirectory(configDir, exclusion)).not.toBe(withNotes);
		// Another workflow's drafts directory is not this workflow's own state.
		const withTools = fingerprintDirectory(configDir, exclusion);
		writeFile(
			path.join(
				configDir,
				".drafts",
				"env-setup",
				"wf-other",
				"apps",
				"run",
				"x.sh",
			),
			"other\n",
		);
		expect(fingerprintDirectory(configDir, exclusion)).not.toBe(withTools);
	});

	test("a large file is fingerprinted by content, never by mtime", () => {
		const configDir = tempDir("env-setup-guard-");
		const large = path.join(configDir, "infrastructure", "compose", "big.yml");
		const filler = "x".repeat(70 * 1024);
		const body = (image: string) =>
			`services:\n  db:\n    image: ${image}\n${filler}\n`;
		writeFile(large, body("postgres"));
		const before = fingerprintDirectory(configDir);
		// A byte-identical rewrite (the promotion's own rollback) with a new mtime.
		fs.writeFileSync(large, body("postgres"));
		fs.utimesSync(large, new Date(), new Date(Date.now() + 5_000));
		expect(fingerprintDirectory(configDir)).toBe(before);
		fs.writeFileSync(large, body("postgres:16"));
		expect(fingerprintDirectory(configDir)).not.toBe(before);
	});

	test("a live-configuration write is a violation and a drafts-only change is not", () => {
		const configDir = tempDir("env-setup-guard-");
		const checkout = tempDir("env-setup-guard-checkout-");
		const exclusion = ownState(configDir);
		writeFile(
			path.join(configDir, "apps", "compose", "shop-compose.yml"),
			"a\n",
		);
		const baseline = {
			configDir,
			checkoutDir: checkout,
			configFingerprint: fingerprintDirectory(configDir, exclusion),
			checkoutFingerprint: fingerprintCheckout(checkout),
		};
		writeFile(path.join(exclusion.draftsDir, "apps", "run", "x.sh"), "draft\n");
		expect(
			setupGuardViolations(baseline, {
				...baseline,
				configFingerprint: fingerprintDirectory(configDir, exclusion),
			}),
		).toEqual([]);
		writeFile(
			path.join(configDir, "apps", "compose", "shop-compose.yml"),
			"b\n",
		);
		const violations = setupGuardViolations(baseline, {
			...baseline,
			configFingerprint: fingerprintDirectory(configDir, exclusion),
		});
		expect(violations).toHaveLength(1);
		expect(violations[0]).toContain("live configuration changed");
	});

	test("a checkout change is a violation", () => {
		const configDir = tempDir("env-setup-guard-");
		const checkout = tempDir("env-setup-guard-checkout-");
		runGit(checkout, ["init"]);
		writeFile(path.join(checkout, "readme.md"), "one\n");
		runGit(checkout, ["add", "readme.md"]);
		runGit(checkout, ["commit", "-m", "init"]);
		const baseline = {
			configDir,
			checkoutDir: checkout,
			configFingerprint: fingerprintDirectory(configDir),
			checkoutFingerprint: fingerprintCheckout(checkout),
		};
		writeFile(path.join(checkout, "readme.md"), "two\n");
		const violations = setupGuardViolations(baseline, {
			...baseline,
			checkoutFingerprint: fingerprintCheckout(checkout),
		});
		expect(violations).toHaveLength(1);
		expect(violations[0]).toContain("repository checkout changed");
	});
});

describe("guard fingerprint content and coverage", () => {
	test("restoring identical bytes leaves the fingerprint unchanged", () => {
		const configDir = tempDir("env-setup-guard-");
		const live = path.join(configDir, "apps", "compose", "shop-compose.yml");
		writeFile(live, "same\n");
		const before = fingerprintDirectory(configDir);
		// A byte-identical rewrite (the promotion's own rollback, a `touch`) must
		// not read as an unapproved change: the guard decides on content.
		fs.writeFileSync(live, "same\n");
		fs.utimesSync(live, new Date(), new Date(Date.now() + 5_000));
		expect(fingerprintDirectory(configDir)).toBe(before);
		// A content edit still does.
		writeFile(live, "changed\n");
		expect(fingerprintDirectory(configDir)).not.toBe(before);
	});

	test("state outside the promotion's own directories is still watched", () => {
		const configDir = tempDir("env-setup-guard-");
		const exclusion = {
			draftsDir: setupDraftsDir(configDir, "wf-1"),
			backupDir: setupBackupDir(configDir, "wf-1"),
			lockPath: path.join(configDir, ".backups", "env-setup-promote.lock"),
		};
		writeFile(
			path.join(configDir, "apps", "compose", "shop-compose.yml"),
			"a\n",
		);
		const before = fingerprintDirectory(configDir, exclusion);
		// `.backups` holds the promotion's state, but its own creation and
		// anything else under it belong to the configuration the guard watches.
		expect(fingerprintDirectory(configDir, exclusion)).toBe(before);
		writeFile(
			path.join(configDir, ".backups", "guard", "wf-other.json"),
			"{}\n",
		);
		expect(fingerprintDirectory(configDir, exclusion)).not.toBe(before);
		// The promotion's own directories remain invisible.
		const afterGuardFile = fingerprintDirectory(configDir, exclusion);
		writeFile(
			path.join(configDir, ".backups", "env-setup-wf-1", "apps", "run", "x.sh"),
			"backup\n",
		);
		writeFile(
			path.join(
				configDir,
				".drafts",
				"env-setup",
				"wf-1",
				"apps",
				"run",
				"y.sh",
			),
			"draft\n",
		);
		expect(fingerprintDirectory(configDir, exclusion)).toBe(afterGuardFile);
	});

	test("a symbolic link in the drafts tree is reported, not silently skipped", () => {
		const configDir = tempDir("env-setup-guard-");
		const draftsDir = setupDraftsDir(configDir, "wf-1");
		const outside = path.join(tempDir("env-setup-outside-"), "payload.sh");
		writeFile(outside, "echo payload\n");
		writeFile(
			path.join(draftsDir, "apps", "run", "shop-plain.sh"),
			"echo plain\n",
		);
		fs.symlinkSync(
			outside,
			path.join(draftsDir, "apps", "run", "shop-linked.sh"),
		);
		expect(listDraftFiles(draftsDir)).toEqual(["apps/run/shop-plain.sh"]);
		expect(listDraftEntries(draftsDir)).toEqual([
			{ relative: "apps/run/shop-linked.sh", kind: "symlink" },
			{ relative: "apps/run/shop-plain.sh", kind: "file" },
		]);
	});
});
