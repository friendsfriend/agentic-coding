// The env-setup drafts directory (`add-environment-setup-workflow`): the
// per-file diff of the drafts against the live configuration, and the write
// guard's fingerprint and violation decision.
import { describe, expect, test } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import {
	fingerprintCheckout,
	fingerprintDefinitions,
	isDefinitionPath,
	listDraftEntries,
	listDraftFiles,
	SETUP_DEFINITION_ROOTS,
	SETUP_DRAFT_PREFIXES,
	SETUP_GUARD_SCOPE,
	setupBackupDir,
	setupDraftChange,
	setupDraftChanges,
	setupDraftsDir,
	setupGuardViolations,
	unifiedDiff,
} from "../src/server/environment/setup-drafts.ts";
import { environmentDiscoveryFile } from "../src/server/environment-discovery.ts";
import { autoRemoveTempDirs, tempDir } from "./support/temp-dirs.ts";

// The checkout fixtures below are real Git repositories; the file-scoped sweep
// removes them when this file ends (test/support/temp-dirs.ts).
autoRemoveTempDirs();

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

	test("a draft replacing a live symlink says so in the approved diff", () => {
		const configDir = tempDir("env-setup-changes-");
		const draftsDir = setupDraftsDir(configDir, "wf-1");
		// The live definition is a symlink into the developer's own repository:
		// promoting this draft replaces the *link* with a regular file, and the
		// developer has to see that before approving it.
		const target = path.join(
			tempDir("env-setup-devenv-"),
			"devenv",
			"apps",
			"compose",
			"shop-compose.yml",
		);
		writeFile(target, "services:\n  shop:\n    image: live\n");
		const liveLink = path.join(
			configDir,
			"apps",
			"compose",
			"shop-compose.yml",
		);
		fs.mkdirSync(path.dirname(liveLink), { recursive: true });
		fs.symlinkSync(target, liveLink);
		writeFile(
			path.join(draftsDir, "apps", "compose", "shop-compose.yml"),
			"services:\n  shop:\n    image: draft\n",
		);
		const change = setupDraftChange(
			configDir,
			draftsDir,
			"apps/compose/shop-compose.yml",
		);
		expect(change?.status).toBe("modified");
		expect(change?.replacesSymlink).toBe(target);
		expect(change?.diff).toContain(
			`# replaces the symlink -> ${target} with a regular file`,
		);
		// The line counts stay the draft's own change: the notice is not a hunk.
		expect(change?.linesAdded).toBe(1);
		expect(change?.linesDeleted).toBe(1);
	});
});

describe("write guard: the definition trees it fingerprints", () => {
	/** The armed baseline the guard effect stores, taken with the current
	 * algorithm. */
	const baselineOf = (configDir: string, checkoutDir: string) => {
		const scan = fingerprintDefinitions(configDir);
		return {
			configDir,
			checkoutDir,
			configFingerprint: scan.digest,
			checkoutFingerprint: fingerprintCheckout(checkoutDir),
			scope: SETUP_GUARD_SCOPE,
			truncated: scan.truncated,
			entries: scan.entries,
		};
	};

	/** The same baseline, re-scanned: what the check phase compares. */
	const currentOf = (
		configDir: string,
		baseline: ReturnType<typeof baselineOf>,
	) => {
		const scan = fingerprintDefinitions(configDir);
		return {
			...baseline,
			configFingerprint: scan.digest,
			truncated: scan.truncated,
			entries: scan.entries,
		};
	};

	/** A live default application definition every fixture starts from. */
	const liveDefinition = (configDir: string) => {
		writeFile(
			path.join(configDir, "apps", "compose", "shop-compose.yml"),
			"services:\n  shop:\n    image: shop:live\n",
		);
	};

	test("the guard watches every tree a draft may publish into", () => {
		// The scope is not a second list to keep in sync: every prefix the
		// promotion and the validation gate accept is inside a scanned tree.
		for (const prefix of SETUP_DRAFT_PREFIXES)
			expect(isDefinitionPath(`${prefix}example.yml`)).toBe(true);
		expect(SETUP_DEFINITION_ROOTS.length).toBeGreaterThan(0);
		// The configuration's library definitions are a definition tree too, even
		// though no draft may name them.
		expect(isDefinitionPath("libraries/definitions/lib.json")).toBe(true);
		// A draft may never name a path outside its own prefixes.
		expect(isDefinitionPath("providers/anthropic.json")).toBe(false);
		expect(isDefinitionPath(".drafts/env-setup/wf-1/root/apps/run/x.sh")).toBe(
			false,
		);
	});

	test("a deep tree the server owns (a browser install) neither truncates nor trips the guard", () => {
		const configDir = tempDir("env-setup-guard-");
		const checkout = tempDir("env-setup-guard-checkout-");
		liveDefinition(configDir);
		const baseline = baselineOf(configDir, checkout);
		expect(baseline.truncated).toBe(false);
		// The product's own browser install: depth 19, well over a thousand
		// entries. The walk's bound applies to the definition trees only, so this
		// cannot exhaust it (`browsers/` is outside every scanned tree).
		const install = path.join(configDir, "browsers", "chromium-1248");
		for (let index = 0; index < 1_600; index++)
			writeFile(
				path.join(
					install,
					`chrome-mac-arm64/deep/level-${index % 19}/entry-${index}`,
				),
				"binary\n",
			);
		const current = currentOf(configDir, baseline);
		expect(current.truncated).toBe(false);
		expect(setupGuardViolations(baseline, current)).toEqual([]);
		// A browser install added *after* the baseline is equally invisible — and
		// the definition trees are still complete, not merely "unchanged so far".
		expect(fingerprintDefinitions(configDir).entries.length).toBeLessThan(50);
	});

	test("server-owned runtime state changed during the run is not a violation", () => {
		const configDir = tempDir("env-setup-guard-");
		const checkout = tempDir("env-setup-guard-checkout-");
		liveDefinition(configDir);
		const baseline = baselineOf(configDir, checkout);
		// Exactly the app state the live run mutated while the author worked: the
		// agent host's database and log, the orchestrator's subscriptions, the
		// client's preferences, the workflow's own data root, the wiki, the
		// classifier's model state and the browser install.
		for (const relative of [
			"orchestrator/agent-host/harness.sqlite",
			"orchestrator/agent-host/harness.sqlite-wal",
			"orchestrator/agent-host/host.log",
			"orchestrator/event-subscriptions.json",
			"tui.json",
			".agentic-coding-workflow/.herdr-workflow/agent-host/harness.sqlite-shm",
			"wiki/index.md",
			"classifier/laya/state.json",
			"classifier-maintenance.json",
			"browsers/chromium-1248/chrome/cache.bin",
			"telemetry/session.json",
			"snapshots/workflow.json",
		])
			writeFile(path.join(configDir, relative), "{}\n");
		const violations = setupGuardViolations(
			baseline,
			currentOf(configDir, baseline),
		);
		expect(violations).toEqual([]);
	});

	test("a real edit to a live definition file is a violation that names the path", () => {
		const configDir = tempDir("env-setup-guard-");
		const checkout = tempDir("env-setup-guard-checkout-");
		liveDefinition(configDir);
		writeFile(
			path.join(configDir, "infrastructure", "definitions", "postgres.json"),
			'{"ident":"postgres"}\n',
		);
		writeFile(
			path.join(configDir, "libraries", "definitions", "lib-starter.json"),
			'{"ident":"lib-starter"}\n',
		);
		const baseline = baselineOf(configDir, checkout);
		// A byte-identical rewrite with a new mtime is not a change: the guard
		// decides on content.
		fs.utimesSync(
			path.join(configDir, "apps", "compose", "shop-compose.yml"),
			new Date(),
			new Date(Date.now() + 5_000),
		);
		expect(
			setupGuardViolations(baseline, currentOf(configDir, baseline)),
		).toEqual([]);
		writeFile(
			path.join(configDir, "apps", "compose", "shop-compose.yml"),
			"services:\n  shop:\n    image: shop:edited\n",
		);
		writeFile(
			path.join(configDir, "libraries", "definitions", "lib-starter.json"),
			'{"ident":"lib-starter","changed":true}\n',
		);
		const violations = setupGuardViolations(
			baseline,
			currentOf(configDir, baseline),
		);
		expect(violations).toHaveLength(1);
		expect(violations[0]).toContain("live configuration changed");
		expect(violations[0]).toContain("apps/compose/shop-compose.yml");
		expect(violations[0]).toContain("libraries/definitions/lib-starter.json");
		// The clause about an incomplete read belongs to a real truncation, not to
		// every mismatch: it pointed the reader at a bound the cause never hit.
		expect(violations[0]).not.toContain("could not be read completely");
		// The untouched definition is not named.
		expect(violations[0]).not.toContain(
			"infrastructure/definitions/postgres.json",
		);
	});

	test("the changed paths a violation names are bounded and counted", () => {
		const configDir = tempDir("env-setup-guard-");
		const checkout = tempDir("env-setup-guard-checkout-");
		liveDefinition(configDir);
		// The directory exists before the baseline, so the change set is exactly the
		// files written below.
		writeFile(
			path.join(configDir, "apps", "run", "existing.sh"),
			"#!/bin/sh\ntrue\n",
		);
		const baseline = baselineOf(configDir, checkout);
		for (let index = 0; index < 14; index++)
			writeFile(
				path.join(configDir, "apps", "run", `worker-${index}.sh`),
				"#!/bin/sh\ntrue\n",
			);
		const violations = setupGuardViolations(
			baseline,
			currentOf(configDir, baseline),
		);
		expect(violations).toHaveLength(1);
		const named = violations[0]?.match(/apps\/run\/worker-\d+\.sh/g) ?? [];
		expect(named).toHaveLength(10);
		expect(violations[0]).toContain("14 definitions changed");
		expect(violations[0]).toContain("(+4 more)");
	});

	test("a write through a staged symlink into a target outside the configuration is a violation naming the path and target", () => {
		const configDir = tempDir("env-setup-guard-");
		const checkout = tempDir("env-setup-guard-checkout-");
		// A stand-in for the developer's own repository the live compose file is a
		// symlink into (`~/devenv-config` in the motivating run).
		const devenv = tempDir("env-setup-guard-devenv-");
		const target = path.join(
			devenv,
			"devenv",
			"apps",
			"compose",
			"shop-compose.yml",
		);
		writeFile(target, "services:\n  shop:\n    image: shop:live\n");
		const liveLink = path.join(
			configDir,
			"apps",
			"compose",
			"shop-compose.yml",
		);
		fs.mkdirSync(path.dirname(liveLink), { recursive: true });
		fs.symlinkSync(target, liveLink);
		const baseline = baselineOf(configDir, checkout);
		// An untouched symlink is the live configuration, not a draft: it does not
		// read as a change on its own.
		expect(
			setupGuardViolations(baseline, currentOf(configDir, baseline)),
		).toEqual([]);
		// The staged root preserves the live symlink as an absolute symlink to the
		// same target (production's behaviour, deliberately). A write *through*
		// that staged path lands in the developer's repository and leaves the live
		// path itself untouched — which is exactly the hole the guard has to see.
		const staged = path.join(
			configDir,
			".drafts",
			"env-setup",
			"wf-1",
			"root",
			"apps",
			"compose",
			"shop-compose.yml",
		);
		fs.mkdirSync(path.dirname(staged), { recursive: true });
		fs.symlinkSync(target, staged);
		fs.writeFileSync(
			staged,
			"services:\n  shop:\n    image: shop:written-through\n",
		);
		expect(fs.readFileSync(target, "utf8")).toContain("written-through");
		const violations = setupGuardViolations(
			baseline,
			currentOf(configDir, baseline),
		);
		expect(violations).toHaveLength(1);
		expect(violations[0]).toContain("apps/compose/shop-compose.yml");
		expect(violations[0]).toContain(`-> ${target}`);
		// Breaking the link is a change too: the target is gone, so what the link
		// reads no longer exists.
		const brokenBaseline = currentOf(configDir, baseline);
		fs.rmSync(target);
		expect(
			setupGuardViolations(
				brokenBaseline,
				currentOf(configDir, brokenBaseline),
			),
		).toHaveLength(1);
	});

	test("the drafts directory and the workflow's own state are outside every scanned tree", () => {
		const configDir = tempDir("env-setup-guard-");
		const checkout = tempDir("env-setup-guard-checkout-");
		liveDefinition(configDir);
		const baseline = baselineOf(configDir, checkout);
		// The state directory the author is allowed to write, the promotion's
		// backups and lock, another workflow's staged root and the running server's
		// discovery record all live outside the definition trees, so none of them
		// needs an exclusion list that could drift.
		writeFile(
			path.join(
				configDir,
				".drafts",
				"env-setup",
				"wf-1",
				"root",
				"apps",
				"run",
				"x.sh",
			),
			"draft\n",
		);
		writeFile(
			path.join(
				configDir,
				".drafts",
				"env-setup",
				"wf-other",
				"root",
				"apps",
				"run",
				"y.sh",
			),
			"other\n",
		);
		writeFile(
			path.join(configDir, ".backups", "env-setup-wf-1", "apps", "run", "x.sh"),
			"backup\n",
		);
		writeFile(
			path.join(configDir, ".backups", "env-setup-promote.lock"),
			"{}\n",
		);
		writeFile(
			environmentDiscoveryFile(configDir),
			'{"url":"http://127.0.0.1:4051"}\n',
		);
		expect(
			setupGuardViolations(baseline, currentOf(configDir, baseline)),
		).toEqual([]);
	});

	test("a large definition file is fingerprinted by content, never by mtime", () => {
		const configDir = tempDir("env-setup-guard-");
		const large = path.join(configDir, "infrastructure", "compose", "big.yml");
		const filler = "x".repeat(70 * 1024);
		const body = (image: string) =>
			`services:\n  db:\n    image: ${image}\n${filler}\n`;
		writeFile(large, body("postgres"));
		const before = fingerprintDefinitions(configDir).digest;
		// A byte-identical rewrite (the promotion's own rollback) with a new mtime.
		fs.writeFileSync(large, body("postgres"));
		fs.utimesSync(large, new Date(), new Date(Date.now() + 5_000));
		expect(fingerprintDefinitions(configDir).digest).toBe(before);
		fs.writeFileSync(large, body("postgres:16"));
		expect(fingerprintDefinitions(configDir).digest).not.toBe(before);
	});

	test("a baseline armed by the older algorithm is one actionable violation", () => {
		const configDir = tempDir("env-setup-guard-");
		const checkout = tempDir("env-setup-guard-checkout-");
		liveDefinition(configDir);
		const current = baselineOf(configDir, checkout);
		// The previous algorithm's baseline: whole-directory fingerprint, no scope
		// marker, no entries.
		const older = {
			configDir,
			checkoutDir: checkout,
			configFingerprint: "b".repeat(64),
			checkoutFingerprint: current.checkoutFingerprint,
		};
		const violations = setupGuardViolations(older, current);
		expect(violations).toHaveLength(1);
		expect(violations[0]).toContain("armed by an older version");
		expect(violations[0]).toContain("restart the workflow");
	});

	test("a drafts-only turn is accepted, and a truncated scan is reported", () => {
		const configDir = tempDir("env-setup-guard-");
		const checkout = tempDir("env-setup-guard-checkout-");
		liveDefinition(configDir);
		const baseline = baselineOf(configDir, checkout);
		writeFile(
			path.join(
				configDir,
				".drafts",
				"env-setup",
				"wf-1",
				"root",
				"apps",
				"compose",
				"shop-compose.yml",
			),
			"services:\n  shop:\n    image: shop:draft\n",
		);
		expect(
			setupGuardViolations(baseline, currentOf(configDir, baseline)),
		).toEqual([]);
		// A scan that could not read a definition tree completely is a violation of
		// its own, and it says so: the fingerprint covers a prefix and proves
		// nothing.
		const truncated = fingerprintDefinitions(configDir, { maxEntries: 1 });
		expect(truncated.truncated).toBe(true);
		const violations = setupGuardViolations(
			{ ...baseline, truncated: true, entries: truncated.entries },
			currentOf(configDir, baseline),
		);
		expect(violations).toHaveLength(1);
		expect(violations[0]).toContain("could not be read completely");
	});

	test("a moved configuration root and a checkout change are violations of their own", () => {
		const configDir = tempDir("env-setup-guard-");
		const checkout = tempDir("env-setup-guard-checkout-");
		runGit(checkout, ["init"]);
		writeFile(path.join(checkout, "readme.md"), "one\n");
		runGit(checkout, ["add", "readme.md"]);
		runGit(checkout, ["commit", "-m", "init"]);
		liveDefinition(configDir);
		const baseline = baselineOf(configDir, checkout);
		const moved = setupGuardViolations(baseline, {
			...baseline,
			configDir: tempDir("env-setup-guard-other-"),
		});
		expect(moved).toHaveLength(1);
		expect(moved[0]).toContain("configuration root moved");
		writeFile(path.join(checkout, "readme.md"), "two\n");
		const changed = setupGuardViolations(baseline, {
			...baseline,
			checkoutFingerprint: fingerprintCheckout(checkout),
		});
		expect(changed).toHaveLength(1);
		expect(changed[0]).toContain("repository checkout changed");
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
