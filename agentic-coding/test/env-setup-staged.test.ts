// The `env-setup` staged configuration root and the stricter gate
// (`staged-env-setup-config-root`).
//
// The motivating evidence: a drafted compose file resolved its `include:` and
// its relative mounts inside the partial drafts tree, and a live
// `apps/build/*.Dockerfile` that is a symlink escaping the build context failed
// `docker build -f`. These tests pin the fix without a docker daemon, maven or
// network: the container tool is a stub on `PATH` that records its argv and
// fails exactly the way BuildKit did.
import { describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { OSCommandRunner } from "../src/server/actions/command.ts";
import { discoverActionTargets } from "../src/server/actions/discovery.ts";
import {
	compileContainerTargetsWithTools,
	resolveBuildSourcePath,
} from "../src/server/actions/target-compile.ts";
import type { ToolSet } from "../src/server/actions/targets.ts";
import {
	listSetupDraftEntries,
	listSetupDraftFiles,
	reviewedDigest,
	setupBackupDir,
	setupDraftsDir,
	setupPromotedDraftsDir,
	setupReviewDrift,
	stagedChangeSet,
	stagedFileDigest,
	stagedRootOf,
} from "../src/server/environment/setup-drafts.ts";
import {
	promoteSetupDrafts,
	rollbackPromotion,
} from "../src/server/environment/setup-promote.ts";
import {
	materializeStagedRoot,
	removeSetupStagedState,
	sweepStaleSetupState,
} from "../src/server/environment/setup-staged.ts";
import { validateSetupDrafts } from "../src/server/environment/setup-validate.ts";
import { ENVIRONMENT_DISCOVERY_FILE } from "../src/server/environment-discovery.ts";

const PROMOTION_SECRET = "secret";

/** The reviewed digests the validation gate records, as the promotion reads
 * them: the content of every drafted file at the moment the developer approved
 * it. */
function reviewedFor(draftsDir: string): Record<string, string> {
	const reviewed: Record<string, string> = {};
	for (const relative of listSetupDraftFiles(draftsDir)) {
		const file = path.join(stagedRootOf(draftsDir), ...relative.split("/"));
		reviewed[relative] = reviewedDigest(fs.readFileSync(file, "utf8"));
	}
	return reviewed;
}

const ALL_TOOLS: ToolSet = {
	docker: true,
	podman: true,
	dockerCompose: true,
	podmanCompose: true,
	tmux: true,
	kind: true,
	kubectl: true,
	helm: true,
};

function tempDir(prefix: string): string {
	return fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), prefix)));
}

function writeFile(filePath: string, text: string): void {
	fs.mkdirSync(path.dirname(filePath), { recursive: true });
	fs.writeFileSync(filePath, text);
}

/** The compiled step whose id ends with the given name (`<target>/step/<name>`):
 * the definition nests its steps under `root.children`. */
function findStep(
	definitions: ReadonlyArray<unknown>,
	suffix: string,
): { id: string; configuration?: unknown } | undefined {
	const visit = (
		value: unknown,
	): { id: string; configuration?: unknown } | undefined => {
		if (Array.isArray(value)) {
			for (const child of value) {
				const found = visit(child);
				if (found) return found;
			}
			return undefined;
		}
		if (typeof value !== "object" || value === null) return undefined;
		const record = value as {
			id?: unknown;
			configuration?: unknown;
			children?: unknown;
			root?: unknown;
		};
		if (typeof record.id === "string" && record.id.endsWith(suffix))
			return { id: record.id, configuration: record.configuration };
		return visit(record.children) ?? visit(record.root);
	};
	return visit(definitions as unknown[]);
}

const COMPOSE_WITH_OTEL = [
	"services:",
	"  shop:",
	"    image: shop:latest",
	"    ports:",
	'      - "8090:8080"',
	"    environment:",
	// biome-ignore lint/suspicious/noTemplateCurlyInString: compose interpolates the injected OTel variable
	"      OTEL_EXPORTER_OTLP_ENDPOINT: ${AC_OTEL_ENDPOINT}",
	"",
].join("\n");

/** A live configuration with the parts the staged root has to treat specially:
 * a symlinked Dockerfile that escapes the tree, a symlinked compose file, the
 * secrets, and the directories that must not be copied. */
function liveConfig(prefix: string): {
	configDir: string;
	linkTarget: string;
	dockerfileLink: string;
	composeLink: string;
} {
	const configDir = tempDir(prefix);
	const outside = tempDir(`${prefix}outside-`);
	const linkTarget = path.join(outside, "shared-build.Dockerfile");
	writeFile(linkTarget, "FROM scratch\n");
	writeFile(
		path.join(configDir, "apps", "build", "shop-build.sh"),
		"#!/bin/sh\ntrue\n",
	);
	writeFile(
		path.join(configDir, "apps", "compose", "shop-compose.yml"),
		COMPOSE_WITH_OTEL,
	);
	writeFile(
		path.join(configDir, "infrastructure", "compose", "network.yml"),
		"services: {}\n",
	);
	writeFile(path.join(configDir, ".env"), "SECRET_TOKEN=hunter2\n");
	writeFile(
		path.join(configDir, "providers", "secrets.json"),
		'{"key":"hunter2"}\n',
	);
	writeFile(path.join(configDir, "wiki", "index.md"), "# wiki\n");
	writeFile(path.join(configDir, "telemetry", "trace.json"), "{}\n");
	// The running server's discovery record hands off a URL and a bearer token:
	// it must never be copied into the staged root (`environment-setup-workflow`).
	writeFile(
		path.join(configDir, ENVIRONMENT_DISCOVERY_FILE),
		'{"url":"http://127.0.0.1:1","token":"live-bearer-token"}\n',
	);
	const dockerfileLink = path.join(
		configDir,
		"apps",
		"build",
		"shop-build.Dockerfile",
	);
	fs.symlinkSync(linkTarget, dockerfileLink);
	const composeLink = path.join(
		configDir,
		"infrastructure",
		"compose",
		"linked-compose.yml",
	);
	fs.symlinkSync(
		path.join(configDir, "infrastructure", "compose", "network.yml"),
		composeLink,
	);
	return { configDir, linkTarget, dockerfileLink, composeLink };
}

describe("the staged configuration root", () => {
	test("copies the live layout, drops the irrelevant, and copies the secrets read-only", async () => {
		const { configDir, dockerfileLink, composeLink } =
			liveConfig("env-setup-staged-");
		const draftsDir = setupDraftsDir(configDir, "wf-1");
		const result = await materializeStagedRoot({
			configDir,
			draftsDir,
			secret: "secret",
		});
		expect(result.ok).toBe(true);
		expect(result.alreadyStaged).toBe(false);
		const root = stagedRootOf(draftsDir);
		// The live layout is copied at its own relative paths.
		expect(
			fs.existsSync(path.join(root, "apps", "compose", "shop-compose.yml")),
		).toBe(true);
		expect(
			fs.existsSync(
				path.join(root, "infrastructure", "compose", "network.yml"),
			),
		).toBe(true);
		// Live symlinks are preserved as absolute symlinks to the same target, so
		// production's symlink behaviour is exercised rather than papered over.
		expect(
			fs
				.lstatSync(path.join(root, "apps", "build", "shop-build.Dockerfile"))
				.isSymbolicLink(),
		).toBe(true);
		expect(
			fs.realpathSync(
				path.join(root, "apps", "build", "shop-build.Dockerfile"),
			),
		).toBe(fs.realpathSync(dockerfileLink));
		expect(
			fs.readlinkSync(
				path.join(root, "infrastructure", "compose", "linked-compose.yml"),
			),
		).toBe(path.join(configDir, "infrastructure", "compose", "network.yml"));
		expect(fs.existsSync(composeLink)).toBe(true);
		// `.env`/`providers` are exposed as private read-only *copies*, never
		// symlinks: a symlink would be write-through, so a stray write from a
		// drafted script would rewrite the developer's live `.env` before approval.
		for (const name of [".env", "providers"]) {
			const staged = path.join(root, name);
			expect(fs.lstatSync(staged).isSymbolicLink()).toBe(false);
		}
		// The credential *files* are read-only; an exposed directory is a private
		// 0o700 shell around them.
		expect(fs.statSync(path.join(root, ".env")).mode & 0o777).toBe(0o400);
		expect(
			fs.statSync(path.join(root, "providers", "secrets.json")).mode & 0o777,
		).toBe(0o400);
		expect(
			fs.readFileSync(path.join(root, "providers", "secrets.json"), "utf8"),
		).toBe('{"key":"hunter2"}\n');
		// The server's discovery record hands off a live bearer token: it is never
		// copied into a state directory (`environment-setup-workflow`).
		expect(fs.existsSync(path.join(root, ENVIRONMENT_DISCOVERY_FILE))).toBe(
			false,
		);
		// Large or irrelevant directories are dropped.
		for (const name of ["wiki", "telemetry", ".drafts", ".backups"]) {
			expect(fs.existsSync(path.join(root, name))).toBe(false);
		}
	});

	test("server state and caches are not copied into the staged root", async () => {
		const { configDir } = liveConfig("env-setup-staged-state-");
		// The live state the server owns and mutates while the workflow runs: a
		// classifier install (342 MB in the motivating configuration), the agent
		// host's database and log, the orchestrator's subscriptions, this
		// workflow's own data root and the product's browser install.
		writeFile(
			path.join(configDir, "classifier", "laya", "model.bin"),
			"x".repeat(4096),
		);
		writeFile(path.join(configDir, "classifier-maintenance.json"), "{}\n");
		writeFile(
			path.join(configDir, "orchestrator", "agent-host", "harness.sqlite"),
			"sqlite\n",
		);
		writeFile(
			path.join(configDir, "orchestrator", "agent-host", "host.log"),
			"log\n",
		);
		writeFile(
			path.join(
				configDir,
				".agentic-coding-workflow",
				".herdr-workflow",
				"harness.sqlite",
			),
			"sqlite\n",
		);
		writeFile(
			path.join(configDir, "browsers", "chromium-1248", "chrome", "binary"),
			"binary\n",
		);
		writeFile(path.join(configDir, "tui.json"), "{}\n");
		const draftsDir = setupDraftsDir(configDir, "wf-1");
		const result = await materializeStagedRoot({ configDir, draftsDir });
		// `tui.json` is a small client preference file, not definition state, and
		// copying it is harmless: what must never be copied is the state above.
		expect(result.ok).toBe(true);
		const root = stagedRootOf(draftsDir);
		for (const name of [
			"classifier",
			"classifier-maintenance.json",
			"orchestrator",
			".agentic-coding-workflow",
			"browsers",
		])
			expect(fs.existsSync(path.join(root, name))).toBe(false);
		// The definitions beside them are copied as usual.
		expect(
			fs.existsSync(path.join(root, "apps", "compose", "shop-compose.yml")),
		).toBe(true);
		expect(
			fs.existsSync(
				path.join(root, "infrastructure", "compose", "network.yml"),
			),
		).toBe(true);
		// The change set is unaffected: the dropped state is outside every prefix
		// a draft may publish into, so a fresh staged root still holds no drafts.
		expect(listSetupDraftFiles(draftsDir)).toEqual([]);
	});
});

describe("the base snapshot and the changed files", () => {
	test("unchanged symlinks are not drafts, and only real edits are", async () => {
		const { configDir } = liveConfig("env-setup-staged-");
		const draftsDir = setupDraftsDir(configDir, "wf-1");
		expect(
			(await materializeStagedRoot({ configDir, draftsDir, secret: "secret" }))
				.ok,
		).toBe(true);
		// A fresh staged root has no drafts at all: the 78 live symlinks of the
		// motivating case are unchanged entries.
		expect(listSetupDraftFiles(draftsDir)).toEqual([]);
		const root = stagedRootOf(draftsDir);
		// A modified live file (mirrored relative path) is a draft.
		writeFile(
			path.join(root, "apps", "compose", "shop-compose.yml"),
			`${COMPOSE_WITH_OTEL}# edited\n`,
		);
		// An added file is a draft.
		writeFile(
			path.join(root, "apps", "run", "shop-run.sh"),
			"#!/bin/sh\ntrue\n",
		);
		expect(listSetupDraftFiles(draftsDir)).toEqual([
			"apps/compose/shop-compose.yml",
			"apps/run/shop-run.sh",
		]);
		// The base snapshot holds digests, never secret content.
		const base = JSON.parse(
			fs.readFileSync(path.join(draftsDir, "base.json"), "utf8"),
		) as { entries: Record<string, { kind: string; digest?: string }> };
		expect(
			fs.readFileSync(path.join(draftsDir, "base.json"), "utf8"),
		).not.toContain("hunter2");
		// The base records the *copy* the staged root holds (the change-set
		// baseline) and the *live* digest the promotion's conflict check compares
		// against — two different facts, never secret content.
		expect(base.entries[".env"]?.kind).toBe("file");
		expect(base.entries[".env"]?.digest).toBe(
			stagedFileDigest(path.join(root, ".env")),
		);
		expect(
			(base.entries[".env"] as { liveDigest?: string } | undefined)?.liveDigest,
		).toBe(stagedFileDigest(path.join(configDir, ".env")));
		expect(base.entries.providers?.kind).toBe("dir");
		expect(base.entries["apps/build/shop-build.sh"]?.digest).toBe(
			stagedFileDigest(path.join(configDir, "apps", "build", "shop-build.sh")),
		);
	});

	test("a changed symlink and a deleted path are findings, not drafts", async () => {
		const { configDir } = liveConfig("env-setup-staged-");
		const draftsDir = setupDraftsDir(configDir, "wf-1");
		expect((await materializeStagedRoot({ configDir, draftsDir })).ok).toBe(
			true,
		);
		const root = stagedRootOf(draftsDir);
		// A replaced symlink inside an allowed prefix is a non-regular finding.
		const linkedDraft = path.join(root, "apps", "run", "shop-linked.sh");
		fs.mkdirSync(path.dirname(linkedDraft), { recursive: true });
		fs.symlinkSync("/bin/true", linkedDraft);
		// A live configuration path the author removed is a deletion finding.
		fs.rmSync(path.join(root, "apps", "compose", "shop-compose.yml"));
		const changed = stagedChangeSet(draftsDir);
		expect(changed.entries.map((entry) => entry.relative)).toEqual([
			"apps/run/shop-linked.sh",
		]);
		expect(changed.deletions).toEqual(["apps/compose/shop-compose.yml"]);
		expect(changed.findings.join("\n")).toContain("plain files");
		expect(changed.findings.join("\n")).toContain(
			"deletions are not published",
		);
		expect(listSetupDraftFiles(draftsDir)).toEqual([]);
		expect(listSetupDraftEntries(draftsDir).map((entry) => entry.kind)).toEqual(
			["symlink"],
		);
	});
});

describe("staged state lifecycle", () => {
	test("materialization is idempotent and never clobbers the author's edits", async () => {
		const { configDir } = liveConfig("env-setup-staged-");
		const draftsDir = setupDraftsDir(configDir, "wf-1");
		await materializeStagedRoot({ configDir, draftsDir });
		writeFile(
			path.join(stagedRootOf(draftsDir), "apps", "run", "shop-run.sh"),
			"#!/bin/sh\ntrue\n",
		);
		const second = await materializeStagedRoot({ configDir, draftsDir });
		expect(second.alreadyStaged).toBe(true);
		expect(listSetupDraftFiles(draftsDir)).toEqual(["apps/run/shop-run.sh"]);
	});

	test("teardown removes the staged root but keeps the rollback backup", async () => {
		const { configDir } = liveConfig("env-setup-staged-");
		const draftsDir = setupDraftsDir(configDir, "wf-1");
		await materializeStagedRoot({ configDir, draftsDir });
		fs.mkdirSync(setupBackupDir(configDir, "wf-1"), { recursive: true });
		fs.mkdirSync(setupPromotedDraftsDir(configDir, "wf-1"), {
			recursive: true,
		});
		const removed = await removeSetupStagedState({
			configDir,
			workflowId: "wf-1",
		});
		expect(removed).toContain(stagedRootOf(draftsDir));
		expect(fs.existsSync(setupBackupDir(configDir, "wf-1"))).toBe(true);
		expect(fs.existsSync(setupPromotedDraftsDir(configDir, "wf-1"))).toBe(
			false,
		);
	});

	test("a stale staged root of a deleted workflow is swept, a live one is kept", async () => {
		const { configDir } = liveConfig("env-setup-staged-");
		const stale = setupDraftsDir(configDir, "wf-stale");
		const live = setupDraftsDir(configDir, "wf-live");
		await materializeStagedRoot({ configDir, draftsDir: stale });
		await materializeStagedRoot({ configDir, draftsDir: live });
		const result = await sweepStaleSetupState({
			configDir,
			isKnownWorkflow: (id) => id === "wf-live",
		});
		expect(result.removed).toEqual([stale]);
		expect(fs.existsSync(stagedRootOf(stale))).toBe(false);
		expect(fs.existsSync(stagedRootOf(live))).toBe(true);
	});

	test("another workflow's staged root is never read through a foreign id", async () => {
		const { configDir } = liveConfig("env-setup-staged-");
		const mine = setupDraftsDir(configDir, "wf-a");
		const other = setupDraftsDir(configDir, "wf-b");
		await materializeStagedRoot({ configDir, draftsDir: mine });
		writeFile(path.join(stagedRootOf(mine), "apps", "run", "a.sh"), "a\n");
		await materializeStagedRoot({ configDir, draftsDir: other });
		expect(listSetupDraftFiles(other)).toEqual([]);
		expect(listSetupDraftFiles(mine)).toEqual(["apps/run/a.sh"]);
	});
});

describe("the promotion's conflict check and rollback", () => {
	test("a live file the developer changed after staging is refused, not overwritten", async () => {
		const { configDir } = liveConfig("env-setup-staged-");
		const draftsDir = setupDraftsDir(configDir, "wf-1");
		await materializeStagedRoot({
			configDir,
			draftsDir,
			secret: PROMOTION_SECRET,
		});
		writeFile(
			path.join(stagedRootOf(draftsDir), "apps", "compose", "shop-compose.yml"),
			`${COMPOSE_WITH_OTEL}# drafted\n`,
		);
		// The developer edits the live file while the draft awaits approval.
		writeFile(
			path.join(configDir, "apps", "compose", "shop-compose.yml"),
			"services: {}\n",
		);
		const result = await promoteSetupDrafts({
			configDir,
			draftsDir,
			backupDir: setupBackupDir(configDir, "wf-1"),
			workflowId: "wf-1",
			runId: "run-1",
			secret: PROMOTION_SECRET,
			reviewed: reviewedFor(draftsDir),
		});
		expect(result.ok).toBe(false);
		expect(result.conflicts).toEqual(["apps/compose/shop-compose.yml"]);
		expect(
			fs.readFileSync(
				path.join(configDir, "apps", "compose", "shop-compose.yml"),
				"utf8",
			),
		).toBe("services: {}\n");
	});

	test("a successful promotion can be rolled back to the previous files", async () => {
		const { configDir } = liveConfig("env-setup-staged-");
		const draftsDir = setupDraftsDir(configDir, "wf-1");
		await materializeStagedRoot({
			configDir,
			draftsDir,
			secret: PROMOTION_SECRET,
		});
		const liveCompose = path.join(
			configDir,
			"apps",
			"compose",
			"shop-compose.yml",
		);
		const before = fs.readFileSync(liveCompose, "utf8");
		const beforeMode = fs.statSync(liveCompose).mode & 0o777;
		writeFile(
			path.join(stagedRootOf(draftsDir), "apps", "compose", "shop-compose.yml"),
			`${COMPOSE_WITH_OTEL}# drafted\n`,
		);
		writeFile(
			path.join(stagedRootOf(draftsDir), "apps", "run", "added.sh"),
			"x\n",
		);
		const promoted = await promoteSetupDrafts({
			configDir,
			draftsDir,
			backupDir: setupBackupDir(configDir, "wf-1"),
			workflowId: "wf-1",
			runId: "run-1",
			secret: PROMOTION_SECRET,
			reviewed: reviewedFor(draftsDir),
		});
		expect(promoted.ok).toBe(true);
		expect(fs.readFileSync(liveCompose, "utf8")).toContain("# drafted");
		const rolledBack = await rollbackPromotion({
			configDir,
			draftsDir,
			backupDir: setupBackupDir(configDir, "wf-1"),
			workflowId: "wf-1",
			runId: "run-1",
			secret: PROMOTION_SECRET,
		});
		expect(rolledBack.ok).toBe(true);
		expect(rolledBack.stagedRestored).toBe(true);
		expect(fs.readFileSync(liveCompose, "utf8")).toBe(before);
		// A rollback restores the previous file exactly: content *and* mode. The
		// backup itself is private (0o600), so the mode is journaled beside it.
		expect(fs.statSync(liveCompose).mode & 0o777).toBe(beforeMode);
		expect(fs.existsSync(path.join(configDir, "apps", "run", "added.sh"))).toBe(
			false,
		);
		expect(fs.existsSync(stagedRootOf(draftsDir))).toBe(true);
	});

	test("a drafted replacement of a live symlink publishes a regular file, never the target", async () => {
		const { configDir, linkTarget, dockerfileLink } = liveConfig(
			"env-setup-staged-symlink-",
		);
		const draftsDir = setupDraftsDir(configDir, "wf-1");
		await materializeStagedRoot({
			configDir,
			draftsDir,
			secret: PROMOTION_SECRET,
		});
		// The staged root preserved the live symlink (production's behaviour), so
		// the path the author writes is a link into the developer's own
		// repository. The documented hygiene is to delete the staged link and
		// write a regular file — never to write through it.
		const stagedLink = path.join(
			stagedRootOf(draftsDir),
			"apps",
			"build",
			"shop-build.Dockerfile",
		);
		expect(fs.lstatSync(stagedLink).isSymbolicLink()).toBe(true);
		const targetBefore = fs.readFileSync(linkTarget, "utf8");
		fs.rmSync(stagedLink);
		writeFile(stagedLink, "FROM alpine\n");
		const promoted = await promoteSetupDrafts({
			configDir,
			draftsDir,
			backupDir: setupBackupDir(configDir, "wf-1"),
			workflowId: "wf-1",
			runId: "run-1",
			secret: PROMOTION_SECRET,
			reviewed: reviewedFor(draftsDir),
		});
		expect(promoted.ok).toBe(true);
		expect(promoted.files).toEqual([
			expect.objectContaining({
				path: "apps/build/shop-build.Dockerfile",
				status: "replaced",
				replacesSymlink: linkTarget,
			}),
		]);
		// The live path is the drafted regular file, and the developer's own file
		// behind the link is byte-unchanged.
		expect(fs.lstatSync(dockerfileLink).isSymbolicLink()).toBe(false);
		expect(fs.readFileSync(dockerfileLink, "utf8")).toBe("FROM alpine\n");
		expect(fs.readFileSync(linkTarget, "utf8")).toBe(targetBefore);
		// A rollback puts the symlink back exactly, and the target is untouched
		// throughout.
		const rolledBack = await rollbackPromotion({
			configDir,
			draftsDir,
			backupDir: setupBackupDir(configDir, "wf-1"),
			workflowId: "wf-1",
			runId: "run-1",
			secret: PROMOTION_SECRET,
		});
		expect(rolledBack.ok).toBe(true);
		expect(fs.lstatSync(dockerfileLink).isSymbolicLink()).toBe(true);
		expect(fs.readlinkSync(dockerfileLink)).toBe(linkTarget);
		expect(fs.readFileSync(linkTarget, "utf8")).toBe(targetBefore);
	});
});

describe("a symlinked Dockerfile builds", () => {
	test("the compiled build step passes the real path, and the stub docker accepts it", async () => {
		const { configDir, linkTarget, dockerfileLink } =
			liveConfig("env-setup-symlink-");
		expect(fs.lstatSync(dockerfileLink).isSymbolicLink()).toBe(true);
		const checkout = tempDir("env-setup-symlink-checkout-");
		const targets = discoverActionTargets({
			appIdent: "shop",
			localDir: checkout,
			action: "build",
			configDir,
			platform: "linux",
		}).filter((target) => target.runtime === "docker");
		expect(targets).toHaveLength(1);
		const target = targets[0];
		if (!target) throw new Error("no docker build target");
		const definitions = compileContainerTargetsWithTools(
			"shop",
			target,
			undefined,
			ALL_TOOLS,
			{
				checkoutDir: checkout,
				configDir,
				tempDir: path.join(checkout, "tmp"),
			},
		);
		const buildStep = findStep(definitions, "/step/build-image");
		const configuration = buildStep?.configuration as {
			command?: string;
			args?: Array<string | { value?: string }>;
		};
		const args = (configuration.args ?? []).map((value) =>
			typeof value === "string" ? value : String(value.value ?? ""),
		);
		const sourceArg = args[args.indexOf("-f") + 1] ?? "";
		// The real path, not the symlink that escapes the build context.
		expect(sourceArg).toBe(fs.realpathSync(linkTarget));
		expect(fs.realpathSync(sourceArg)).toBe(fs.realpathSync(linkTarget));

		// The stub container tool fails exactly the way BuildKit did when `-f`
		// names a symlink escaping the context, so the test proves the fix rather
		// than restating it. No daemon, no network.
		const binDir = tempDir("env-setup-symlink-bin-");
		const record = path.join(binDir, "argv.txt");
		writeFile(
			path.join(binDir, "docker"),
			[
				"#!/bin/sh",
				`echo "$@" >> ${record}`,
				'previous=""',
				'for argument in "$@"; do',
				'  if [ "$previous" = "-f" ]; then',
				'    if [ -L "$argument" ]; then',
				'      echo "failed to read dockerfile: open $(basename "$argument"): no such file or directory" >&2',
				"      exit 1",
				"    fi",
				"  fi",
				'  previous="$argument"',
				"done",
				"exit 0",
				"",
			].join("\n"),
		);
		fs.chmodSync(path.join(binDir, "docker"), 0o755);
		const run = Bun.spawnSync([configuration.command ?? "docker", ...args], {
			cwd: checkout,
			env: { ...process.env, PATH: `${binDir}:${process.env.PATH ?? ""}` },
			stdout: "pipe",
			stderr: "pipe",
		});
		expect(run.stderr.toString()).toBe("");
		expect(run.exitCode).toBe(0);
		expect(fs.readFileSync(record, "utf8")).toContain(sourceArg);
		// And the link itself would have failed: the fix is what makes it work.
		expect(fs.lstatSync(sourceArg).isSymbolicLink()).toBe(false);
	});

	test("a configuration without templates gets no build-context step at all", () => {
		const { configDir } = liveConfig("env-setup-templates-");
		const checkout = tempDir("env-setup-templates-checkout-");
		const tempDirPath = path.join(checkout, "missing-tmp");
		const target = discoverActionTargets({
			appIdent: "shop",
			localDir: checkout,
			action: "build",
			configDir,
			platform: "linux",
		}).find((candidate) => candidate.runtime === "docker");
		if (!target) throw new Error("no docker build target");
		const definitions = compileContainerTargetsWithTools(
			"shop",
			target,
			undefined,
			ALL_TOOLS,
			{ checkoutDir: checkout, configDir, tempDir: tempDirPath },
		);
		// The overlay exists for a build context that uses `templates/`; a
		// configuration that has none gets neither the copy nor the cleanup, so
		// nothing is written into the checkout and nothing can complain about a
		// directory that does not exist (`fix-default-target-after-promotion`).
		expect(
			findStep(definitions, "/step/prepare-build-context"),
		).toBeUndefined();
		expect(
			findStep(definitions, "/step/cleanup-build-context"),
		).toBeUndefined();
		expect(fs.readdirSync(checkout)).toEqual([]);
	});

	test("the templates overlay copies them into the build context and cleans exactly them up", async () => {
		const { configDir } = liveConfig("env-setup-templates-");
		writeFile(
			path.join(configDir, "templates", ".dockerignore"),
			"node_modules\n",
		);
		writeFile(path.join(configDir, "templates", "sub", "keep.txt"), "keep\n");
		const checkout = tempDir("env-setup-templates-checkout-");
		// A pre-existing file of the developer's own checkout: the cleanup removes
		// what the overlay copied, never what was already there.
		writeFile(path.join(checkout, "src.txt"), "mine\n");
		const target = discoverActionTargets({
			appIdent: "shop",
			localDir: checkout,
			action: "build",
			configDir,
			platform: "linux",
		}).find((candidate) => candidate.runtime === "docker");
		if (!target) throw new Error("no docker build target");
		const definitions = compileContainerTargetsWithTools(
			"shop",
			target,
			undefined,
			ALL_TOOLS,
			{ checkoutDir: checkout, configDir, tempDir: path.join(checkout, "tmp") },
		);
		const prepare = findStep(definitions, "/step/prepare-build-context");
		const cleanup = findStep(definitions, "/step/cleanup-build-context");
		const prepareConfiguration = prepare?.configuration as {
			command?: string;
			args?: string[];
		};
		const cleanupConfiguration = cleanup?.configuration as {
			command?: string;
			args?: string[];
		};
		// No `2>/dev/null; true`: a copy that fails must fail the step.
		expect(prepareConfiguration.args?.join("\n")).not.toContain("2>/dev/null");
		expect(prepareConfiguration.args?.join("\n")).not.toContain("; true");
		const run = (configuration: { command?: string; args?: string[] }) =>
			new OSCommandRunner().run({
				name: configuration.command ?? "sh",
				args: configuration.args ?? [],
				dir: checkout,
			});
		const prepared = await run(prepareConfiguration);
		expect(prepared.error).toBeUndefined();
		expect(prepared.exitCode).toBe(0);
		// The Dockerfile's own COPY can now see them.
		expect(fs.readFileSync(path.join(checkout, ".dockerignore"), "utf8")).toBe(
			"node_modules\n",
		);
		expect(
			fs.readFileSync(path.join(checkout, "sub", "keep.txt"), "utf8"),
		).toBe("keep\n");
		const cleaned = await run(cleanupConfiguration);
		expect(cleaned.exitCode).toBe(0);
		expect(fs.existsSync(path.join(checkout, ".dockerignore"))).toBe(false);
		expect(fs.existsSync(path.join(checkout, "sub"))).toBe(false);
		expect(fs.readFileSync(path.join(checkout, "src.txt"), "utf8")).toBe(
			"mine\n",
		);
	});

	test("a templates copy that cannot run fails instead of reporting success", async () => {
		const { configDir } = liveConfig("env-setup-templates-");
		writeFile(path.join(configDir, "templates", ".dockerignore"), "x\n");
		const checkout = tempDir("env-setup-templates-checkout-");
		const target = discoverActionTargets({
			appIdent: "shop",
			localDir: checkout,
			action: "build",
			configDir,
			platform: "linux",
		}).find((candidate) => candidate.runtime === "docker");
		if (!target) throw new Error("no docker build target");
		const definitions = compileContainerTargetsWithTools(
			"shop",
			target,
			undefined,
			ALL_TOOLS,
			{ checkoutDir: checkout, configDir, tempDir: path.join(checkout, "tmp") },
		);
		const configuration = findStep(definitions, "/step/prepare-build-context")
			?.configuration as { command?: string; args?: string[] };
		// The templates directory disappears between compilation and the build: the
		// step must say so, not exit 0 having copied nothing.
		fs.rmSync(path.join(configDir, "templates"), {
			recursive: true,
			force: true,
		});
		const failed = await new OSCommandRunner().run({
			name: configuration.command ?? "sh",
			args: configuration.args ?? [],
			dir: checkout,
		});
		expect(failed.exitCode).not.toBe(0);
		expect(failed.error).toBeDefined();
	});

	test("an unresolvable link falls back to its lexical path so the tool names it", async () => {
		const missing = path.join(tempDir("env-setup-missing-"), "gone.Dockerfile");
		expect(resolveBuildSourcePath(missing)).toBe(path.resolve(missing));
	});
});

describe("the stricter gate", () => {
	function gateContext(options: {
		configDir: string;
		draftsDir: string;
		checkoutDir: string;
		buildTarget?: (target: { id: string }) => Promise<{
			ok: boolean;
			skipped?: boolean;
			logTail?: string;
			detail?: string;
		}>;
		testTarget?: (target: { id: string }) => Promise<{
			ok: boolean;
			skipped?: boolean;
			logTail?: string;
			detail?: string;
		}>;
		startTarget?: (target: { id: string }) => Promise<{
			ready: boolean;
			detail?: string;
		}>;
	}) {
		return {
			configDir: options.configDir,
			draftsDir: options.draftsDir,
			appIdent: "shop",
			checkoutDir: options.checkoutDir,
			startTarget:
				options.startTarget ?? (async () => ({ ready: true as const })),
			compileTarget: async () => {},
			otherAppPorts: () => new Map<number, string>(),
			envFileVariables: () =>
				new Map([["AC_OTEL_ENDPOINT", "http://127.0.0.1:4318"]]),
			processEnv: {},
			...(options.buildTarget ? { buildTarget: options.buildTarget } : {}),
			...(options.testTarget ? { testTarget: options.testTarget } : {}),
		};
	}

	function draftedCompose(configDir: string, draftsDir: string): void {
		writeFile(
			path.join(draftsDir, "apps", "compose", "shop-compose.yml"),
			COMPOSE_WITH_OTEL,
		);
		void configDir;
	}

	test("the report names every step and the default target per action", async () => {
		const configDir = tempDir("env-setup-gate-");
		const draftsDir = setupDraftsDir(configDir, "wf-1");
		const checkout = tempDir("env-setup-gate-checkout-");
		draftedCompose(configDir, draftsDir);
		writeFile(
			path.join(draftsDir, "apps", "build", "shop-build.Dockerfile"),
			"FROM scratch\n",
		);
		writeFile(
			path.join(draftsDir, "apps", "build", "shop-build.sh"),
			"#!/bin/sh\ntrue\n",
		);
		const report = await validateSetupDrafts(
			gateContext({ configDir, draftsDir, checkoutDir: checkout }),
		);
		// Two build targets share the default profile: that is ambiguous, and the
		// gate says so instead of silently picking one.
		expect(
			report.findings.some((finding) => finding.check === "no-default-target"),
		).toBe(true);
		expect(report.ok).toBe(false);
		const discoverStep = report.steps.find(
			(step) => step.step === "discover" && step.action === "build",
		);
		expect(discoverStep?.targetsSeen?.length).toBe(2);
	});

	test("a failing default build is a finding the author is sent back with", async () => {
		const configDir = tempDir("env-setup-gate-");
		const draftsDir = setupDraftsDir(configDir, "wf-1");
		const checkout = tempDir("env-setup-gate-checkout-");
		draftedCompose(configDir, draftsDir);
		writeFile(
			path.join(draftsDir, "apps", "build", "shop-build.Dockerfile"),
			"FROM scratch\n",
		);
		const report = await validateSetupDrafts(
			gateContext({
				configDir,
				draftsDir,
				checkoutDir: checkout,
				buildTarget: async () => ({
					ok: false,
					logTail: "docker: failed to read dockerfile",
					detail: "the build failed",
				}),
			}),
		);
		expect(report.ok).toBe(false);
		const step = report.steps.find((entry) => entry.step === "build");
		expect(step?.status).toBe("failed");
		expect(step?.logTail).toBe("docker: failed to read dockerfile");
		expect(report.findings.some((finding) => finding.check === "build")).toBe(
			true,
		);
		// The default target is named, so the author knows what ran.
		expect(report.defaults.some((entry) => entry.action === "build")).toBe(
			true,
		);
	});

	test("a skipped step is visible and never a pass", async () => {
		const configDir = tempDir("env-setup-gate-");
		const draftsDir = setupDraftsDir(configDir, "wf-1");
		const checkout = tempDir("env-setup-gate-checkout-");
		draftedCompose(configDir, draftsDir);
		writeFile(
			path.join(draftsDir, "apps", "build", "shop-build.Dockerfile"),
			"FROM scratch\n",
		);
		const report = await validateSetupDrafts(
			gateContext({
				configDir,
				draftsDir,
				checkoutDir: checkout,
				buildTarget: async () => ({
					ok: false,
					skipped: true,
					detail: "the docker daemon is not running",
				}),
			}),
		);
		expect(report.ok).toBe(false);
		expect(report.steps.find((step) => step.step === "build")?.status).toBe(
			"skipped",
		);
		const skipped = report.findings.find(
			(finding) => finding.check === "skipped",
		);
		expect(skipped?.message).toContain("the docker daemon is not running");
	});

	test("a failing default test fails the gate, and a missing test target is stated", async () => {
		const configDir = tempDir("env-setup-gate-");
		const draftsDir = setupDraftsDir(configDir, "wf-1");
		const checkout = tempDir("env-setup-gate-checkout-");
		draftedCompose(configDir, draftsDir);
		writeFile(
			path.join(draftsDir, "apps", "build", "shop-test.sh"),
			"#!/bin/sh\ntrue\n",
		);
		const failed = await validateSetupDrafts(
			gateContext({
				configDir,
				draftsDir,
				checkoutDir: checkout,
				testTarget: async () => ({ ok: false, detail: "2 tests failed" }),
			}),
		);
		expect(failed.ok).toBe(false);
		expect(failed.steps.find((step) => step.step === "test")?.status).toBe(
			"failed",
		);
		expect(failed.findings.some((finding) => finding.check === "test")).toBe(
			true,
		);

		const noTestConfig = tempDir("env-setup-gate-notest-");
		const noTestDrafts = setupDraftsDir(noTestConfig, "wf-1");
		draftedCompose(noTestConfig, noTestDrafts);
		const withoutTest = await validateSetupDrafts(
			gateContext({
				configDir: noTestConfig,
				draftsDir: noTestDrafts,
				checkoutDir: checkout,
			}),
		);
		const stated = withoutTest.findings.find(
			(finding) => finding.check === "no-test-target",
		);
		expect(stated?.blocking).toBe(false);
		expect(withoutTest.steps.find((step) => step.step === "test")?.status).toBe(
			"skipped",
		);
	});

	test("a build fails before the app is started", async () => {
		const configDir = tempDir("env-setup-gate-");
		const draftsDir = setupDraftsDir(configDir, "wf-1");
		const checkout = tempDir("env-setup-gate-checkout-");
		draftedCompose(configDir, draftsDir);
		writeFile(
			path.join(draftsDir, "apps", "build", "shop-build.Dockerfile"),
			"FROM scratch\n",
		);
		const order: string[] = [];
		const report = await validateSetupDrafts(
			gateContext({
				configDir,
				draftsDir,
				checkoutDir: checkout,
				buildTarget: async () => {
					order.push("build");
					return { ok: false, detail: "nope" };
				},
				startTarget: async () => {
					order.push("start");
					return { ready: true as const };
				},
			}),
		);
		expect(order).toEqual(["build", "start"]);
		expect(report.ok).toBe(false);
	});
});

function stagedGateContext(options: {
	configDir: string;
	draftsDir: string;
	checkoutDir: string;
	buildTarget?: (target: { id: string }) => Promise<{
		ok: boolean;
		skipped?: boolean;
		exitCode?: number | null;
		logTail?: string;
		detail?: string;
	}>;
	testTarget?: (target: { id: string }) => Promise<{
		ok: boolean;
		skipped?: boolean;
		detail?: string;
	}>;
}) {
	return {
		configDir: options.configDir,
		draftsDir: options.draftsDir,
		appIdent: "shop",
		checkoutDir: options.checkoutDir,
		secret: PROMOTION_SECRET,
		startTarget: async () => ({ ready: true as const }),
		compileTarget: async () => {},
		otherAppPorts: () => new Map<number, string>(),
		envFileVariables: () =>
			new Map([["AC_OTEL_ENDPOINT", "http://127.0.0.1:4318"]]),
		processEnv: {},
		buildTarget: options.buildTarget ?? (async () => ({ ok: true })),
		testTarget: options.testTarget ?? (async () => ({ ok: true })),
	};
}

describe("the gate runs the real path over the staged root", () => {
	test("derives its drafts from the staged root, not the live configuration's own files", async () => {
		const { configDir } = liveConfig("env-setup-gate-staged-");
		const draftsDir = setupDraftsDir(configDir, "wf-1");
		await materializeStagedRoot({
			configDir,
			draftsDir,
			secret: PROMOTION_SECRET,
		});
		const root = stagedRootOf(draftsDir);
		// The author edits one copied file, replaces a copied symlink with a
		// non-regular draft, and removes a live path.
		writeFile(
			path.join(root, "apps", "compose", "shop-compose.yml"),
			`${COMPOSE_WITH_OTEL}# edited\n`,
		);
		const linked = path.join(root, "apps", "run", "shop-linked.sh");
		fs.mkdirSync(path.dirname(linked), { recursive: true });
		fs.symlinkSync("/bin/true", linked);
		fs.rmSync(path.join(root, "infrastructure", "compose", "network.yml"));
		const checkout = tempDir("env-setup-gate-staged-checkout-");
		const report = await validateSetupDrafts(
			stagedGateContext({ configDir, draftsDir, checkoutDir: checkout }),
		);
		// The live configuration's own symlinks (and every other copied file) are
		// not drafts; only the edit is.
		expect(report.drafts).toEqual(["apps/compose/shop-compose.yml"]);
		const checks = report.findings.map((finding) => finding.check);
		expect(checks).toContain("non-regular-file");
		expect(checks).toContain("staged-deletion");
		// The target under test resolved from the staged root, and the reviewed
		// digest the promotion will hold it to is recorded for every draft.
		const target = report.targets[0];
		expect(target?.sourcePath.startsWith(`${root}${path.sep}`)).toBe(true);
		expect(report.reviewed["apps/compose/shop-compose.yml"]).toBe(
			reviewedDigest(
				fs.readFileSync(`${root}/apps/compose/shop-compose.yml`, "utf8"),
			),
		);
		expect(report.ok).toBe(false);
	});

	test("reports each step's exit status and bounded output instead of skipping it", async () => {
		const configDir = tempDir("env-setup-gate-steps-");
		const draftsDir = setupDraftsDir(configDir, "wf-1");
		// One build target only, so the default is unambiguous: the step under test
		// is the runner's result, not an ambiguity finding.
		writeFile(
			path.join(draftsDir, "apps", "build", "shop-build.sh"),
			"#!/bin/sh\ntrue\n",
		);
		writeFile(
			path.join(draftsDir, "apps", "compose", "shop-compose.yml"),
			COMPOSE_WITH_OTEL,
		);
		const checkout = tempDir("env-setup-gate-steps-checkout-");
		const requested: string[] = [];
		const longTail = Array.from(
			{ length: 400 },
			(_, index) => `line ${index}`,
		).join("\n");
		const report = await validateSetupDrafts(
			stagedGateContext({
				configDir,
				draftsDir,
				checkoutDir: checkout,
				buildTarget: async (target) => {
					requested.push(target.id);
					return { ok: false, exitCode: 2, logTail: longTail };
				},
			}),
		);
		const build = report.steps.find((step) => step.step === "build");
		expect(build?.status).toBe("failed");
		expect(build?.exitCode).toBe(2);
		// The bounded tail: the last 40 lines, never the whole log.
		expect((build?.logTail ?? "").split("\n")).toHaveLength(40);
		// The default build target is named, and it is the one that was requested.
		const defaultBuild = report.defaults.find(
			(entry) => entry.action === "build",
		);
		expect(defaultBuild?.targetId).toBe(requested[0]);
		expect(
			report.findings.some(
				(finding) =>
					finding.check === "build" && finding.subject === requested[0],
			),
		).toBe(true);
		expect(report.ok).toBe(false);
	});
});

describe("a drafted compose that includes live-only infrastructure", () => {
	test("resolves from the staged root and a stub container tool accepts it", async () => {
		const { configDir } = liveConfig("env-setup-include-");
		const draftsDir = setupDraftsDir(configDir, "wf-1");
		await materializeStagedRoot({
			configDir,
			draftsDir,
			secret: PROMOTION_SECRET,
		});
		const root = stagedRootOf(draftsDir);
		const draftedCompose = [
			"include:",
			"  - ../../infrastructure/compose/network.yml",
			"services:",
			"  shop:",
			"    image: shop:latest",
			"    ports:",
			'      - "8090:8080"',
			"    environment:",
			// biome-ignore lint/suspicious/noTemplateCurlyInString: compose interpolates the injected OTel variable
			"      OTEL_EXPORTER_OTLP_ENDPOINT: ${AC_OTEL_ENDPOINT}",
			"",
		].join("\n");
		writeFile(
			path.join(root, "apps", "compose", "shop-compose.yml"),
			draftedCompose,
		);
		const checkout = tempDir("env-setup-include-checkout-");
		const targets = discoverActionTargets({
			appIdent: "shop",
			localDir: checkout,
			action: "run",
			configDir,
			configOverlay: root,
		});
		const target = targets.find((candidate) =>
			candidate.sourcePath.endsWith("apps/compose/shop-compose.yml"),
		);
		if (!target) throw new Error("no staged run target");
		expect(target.sourcePath).toBe(
			path.join(root, "apps", "compose", "shop-compose.yml"),
		);
		// This is the failure of the first real run: inside the partial drafts tree
		// the include resolved nowhere, so the author rewrote the file. From the
		// staged root it resolves inside the copy that mirrors the live layout.
		const included = path.resolve(
			path.dirname(target.sourcePath),
			"../../infrastructure/compose/network.yml",
		);
		expect(included).toBe(
			path.join(root, "infrastructure", "compose", "network.yml"),
		);
		expect(fs.existsSync(included)).toBe(true);

		// A stub container tool that refuses a compose file outside the staged
		// root and any include this run cannot resolve: the recorded command must
		// satisfy both. No daemon, no network.
		const binDir = tempDir("env-setup-include-bin-");
		const record = path.join(binDir, "argv.txt");
		writeFile(
			path.join(binDir, "docker"),
			[
				"#!/bin/sh",
				`echo "$@" >> ${record}`,
				`staged=${root}`,
				'previous=""',
				'for argument in "$@"; do',
				'  if [ "$previous" = "-f" ]; then',
				'    case "$argument" in',
				'      "$staged"/*) ;;',
				'      *) echo "refusing $argument outside the staged root" >&2; exit 1 ;;',
				"    esac",
				'    directory=$(dirname "$argument")',
				'    grep -E "^\\s+- \\.\\." "$argument" | sed "s/^[[:space:]]*- //" | while read -r include; do',
				'      if [ ! -f "$directory/$include" ]; then',
				'        echo "include $include does not resolve from $directory" >&2',
				"        exit 1",
				"      fi",
				"    done || exit 1",
				"  fi",
				'  previous="$argument"',
				"done",
				"exit 0",
				"",
			].join("\n"),
		);
		fs.chmodSync(path.join(binDir, "docker"), 0o755);
		// The command under test is the one the *engine* compiles for this run
		// target, not one the test writes: the compose invocation the gate and the
		// smoke check execute is what must resolve the include from the staged root.
		const compiled = compileContainerTargetsWithTools(
			"shop",
			target,
			undefined,
			ALL_TOOLS,
			{ checkoutDir: checkout, configDir, tempDir: path.join(checkout, "tmp") },
		);
		const upStep = ((): { command?: string; args?: unknown[] } | undefined => {
			const visit = (
				value: unknown,
			): { command?: string; args?: unknown[] } | undefined => {
				if (Array.isArray(value)) {
					for (const child of value) {
						const found = visit(child);
						if (found) return found;
					}
					return undefined;
				}
				if (typeof value !== "object" || value === null) return undefined;
				const record = value as {
					configuration?: { command?: string; args?: unknown[] };
					children?: unknown;
					root?: unknown;
				};
				const args = record.configuration?.args ?? [];
				if (args.some((argument) => argument === "up"))
					return record.configuration as { command?: string; args?: unknown[] };
				return visit(record.children) ?? visit(record.root);
			};
			return visit(compiled as unknown[]);
		})();
		if (!upStep) throw new Error("no compiled compose start step");
		const runArgs = (upStep.args ?? []).map((argument) =>
			typeof argument === "string"
				? argument
				: String((argument as { value?: unknown }).value ?? ""),
		);
		expect(runArgs).toContain(target.sourcePath);
		// The compiler resolves the runtime to an absolute path, which no stub on
		// PATH can intercept; the *arguments* are the production ones, and the
		// executable is re-resolved through PATH so the stub sees them. Every
		// property under test — the `-f` path, `up -d`, the include resolution — is
		// what the engine compiles.
		const run = Bun.spawnSync(["docker", ...runArgs], {
			cwd: checkout,
			env: { ...process.env, PATH: `${binDir}:${process.env.PATH ?? ""}` },
			stdout: "pipe",
			stderr: "pipe",
		});
		expect(run.stderr.toString()).toBe("");
		expect(run.exitCode).toBe(0);
		expect(fs.readFileSync(record, "utf8")).toContain(target.sourcePath);
	});
});

describe("the gate's deadlines and the infrastructure parse", () => {
	test("a step that exceeds its deadline is stopped, reported and fails the gate", async () => {
		const configDir = tempDir("env-setup-deadline-");
		const draftsDir = setupDraftsDir(configDir, "wf-1");
		writeFile(
			path.join(draftsDir, "apps", "build", "shop-build.sh"),
			"#!/bin/sh\ntrue\n",
		);
		writeFile(
			path.join(draftsDir, "apps", "compose", "shop-compose.yml"),
			COMPOSE_WITH_OTEL,
		);
		const checkout = tempDir("env-setup-deadline-checkout-");
		const report = await validateSetupDrafts({
			...stagedGateContext({ configDir, draftsDir, checkoutDir: checkout }),
			timeouts: { buildMs: 5 },
			buildTarget: () => new Promise(() => {}),
		} as never);
		const build = report.steps.find((step) => step.step === "build");
		expect(build?.status).toBe("skipped");
		expect(build?.detail).toContain("deadline");
		expect(report.findings.some((finding) => finding.check === "skipped")).toBe(
			true,
		);
		expect(report.ok).toBe(false);
	});

	test("a spent wall-clock budget names the step it prevented", async () => {
		const configDir = tempDir("env-setup-budget-");
		const draftsDir = setupDraftsDir(configDir, "wf-1");
		writeFile(
			path.join(draftsDir, "apps", "build", "shop-build.sh"),
			"#!/bin/sh\ntrue\n",
		);
		writeFile(
			path.join(draftsDir, "apps", "compose", "shop-compose.yml"),
			COMPOSE_WITH_OTEL,
		);
		const checkout = tempDir("env-setup-budget-checkout-");
		const report = await validateSetupDrafts({
			...stagedGateContext({ configDir, draftsDir, checkoutDir: checkout }),
			timeouts: { budgetMs: 0 },
		} as never);
		expect(
			report.findings.some((finding) =>
				(finding.message ?? "").includes("wall-clock budget"),
			),
		).toBe(true);
		expect(
			report.steps.some((step) =>
				(step.detail ?? "").includes("wall-clock budget"),
			),
		).toBe(true);
		expect(report.ok).toBe(false);
	});

	test("a modified infrastructure definition is parsed, and its three outcomes reach the report", async () => {
		const infraDraft = "services:\n  net:\n    image: alpine\n";
		const run = async (
			parseInfrastructure?: (relative: string) => Promise<{
				ok: boolean;
				skipped?: boolean;
				exitCode?: number | null;
				detail?: string;
				logTail?: string;
			}>,
		) => {
			const configDir = tempDir("env-setup-infra-");
			const draftsDir = setupDraftsDir(configDir, "wf-1");
			writeFile(
				path.join(draftsDir, "apps", "compose", "shop-compose.yml"),
				COMPOSE_WITH_OTEL,
			);
			writeFile(
				path.join(draftsDir, "infrastructure", "compose", "network.yml"),
				infraDraft,
			);
			const checkout = tempDir("env-setup-infra-checkout-");
			const context = stagedGateContext({
				configDir,
				draftsDir,
				checkoutDir: checkout,
			});
			return validateSetupDrafts({
				...context,
				...(parseInfrastructure ? { parseInfrastructure } : {}),
			} as never);
		};

		const ok = await run(async () => ({ ok: true, exitCode: 0 }));
		const okStep = ok.steps.find((step) => step.step === "infra");
		expect(okStep?.status).toBe("ok");
		expect(ok.findings.some((finding) => finding.check === "infra")).toBe(
			false,
		);

		const failed = await run(async () => ({
			ok: false,
			exitCode: 1,
			logTail: "network.yml: unknown top-level key",
		}));
		const failedStep = failed.steps.find((step) => step.step === "infra");
		expect(failedStep?.status).toBe("failed");
		expect(failedStep?.exitCode).toBe(1);
		expect(
			failed.findings.some(
				(finding) =>
					finding.check === "infra" &&
					finding.subject === "infrastructure/compose/network.yml",
			),
		).toBe(true);

		const skipped = await run(async () => ({
			ok: false,
			skipped: true,
			detail: "the docker CLI is not available",
		}));
		expect(skipped.steps.find((step) => step.step === "infra")?.status).toBe(
			"skipped",
		);
		expect(
			skipped.findings.some(
				(finding) =>
					finding.check === "skipped" &&
					(finding.message ?? "").includes("docker CLI"),
			),
		).toBe(true);

		// No parser at all (a gate with no container CLI): a visible skip, never a
		// silent pass.
		const absent = await run(undefined);
		expect(absent.steps.find((step) => step.step === "infra")?.status).toBe(
			"skipped",
		);
		expect(absent.ok).toBe(false);
	});
});

describe("the materializer's bounds", () => {
	test("an entry or byte bound refuses the copy and leaves nothing behind", async () => {
		for (const options of [{ maxEntries: 1 }, { maxBytes: 1 }]) {
			const { configDir } = liveConfig("env-setup-bound-");
			const draftsDir = setupDraftsDir(configDir, "wf-1");
			const result = await materializeStagedRoot({
				configDir,
				draftsDir,
				secret: PROMOTION_SECRET,
				...options,
			});
			expect(result.ok).toBe(false);
			expect(result.staged).toBe(false);
			expect(result.error ?? "").toMatch(/more than 1 entries|larger than/);
			expect(fs.existsSync(stagedRootOf(draftsDir))).toBe(false);
			expect(fs.existsSync(path.join(draftsDir, "base.json"))).toBe(false);
			// The private staging directory of the failed attempt is reaped too.
			expect(
				fs
					.readdirSync(draftsDir)
					.filter((name) => name.startsWith(".staging-")),
			).toEqual([]);
		}
	});
});

describe("a drafted target supersedes the live one it replaces", () => {
	test("the drafted build target is the default and the live one is named as superseded", async () => {
		const configDir = tempDir("env-setup-supersede-");
		const draftsDir = setupDraftsDir(configDir, "wf-1");
		// The live configuration declares a Dockerfile build target; the draft adds
		// the script target that actually works (the motivating case).
		writeFile(
			path.join(configDir, "apps", "build", "shop-build.Dockerfile"),
			"FROM scratch\n",
		);
		writeFile(
			path.join(draftsDir, "apps", "build", "shop-build.sh"),
			"#!/bin/sh\ntrue\n",
		);
		writeFile(
			path.join(draftsDir, "apps", "compose", "shop-compose.yml"),
			COMPOSE_WITH_OTEL,
		);
		const checkout = tempDir("env-setup-supersede-checkout-");
		const report = await validateSetupDrafts(
			stagedGateContext({ configDir, draftsDir, checkoutDir: checkout }),
		);
		// No ambiguity: a draft cannot delete a live definition, so the drafted
		// target of the same action and profile is the successor.
		expect(
			report.findings.some((finding) => finding.check === "no-default-target"),
		).toBe(false);
		const build = report.defaults.find((entry) => entry.action === "build");
		expect(build?.targetId).toContain("/shell");
		expect(build?.superseded?.some((id) => id.includes("docker"))).toBe(true);
	});
});

describe("acceptance: stage, gate, promote and prove the promoted bytes", () => {
	test("the whole path runs end to end without a daemon, maven or network", async () => {
		// A configuration with exactly one build target and one test target, so the
		// gate's default choice is unambiguous; the shared infrastructure the draft
		// includes lives only here.
		const configDir = tempDir("env-setup-acceptance-");
		writeFile(
			path.join(configDir, "apps", "build", "shop-build.sh"),
			"#!/bin/sh\ntrue\n",
		);
		writeFile(
			path.join(configDir, "apps", "build", "shop-test.sh"),
			"#!/bin/sh\ntrue\n",
		);
		writeFile(
			path.join(configDir, "infrastructure", "compose", "network.yml"),
			"services: {}\n",
		);
		writeFile(path.join(configDir, ".env"), "SECRET_TOKEN=hunter2\n");
		const draftsDir = setupDraftsDir(configDir, "wf-1");
		// The staged root mirrors the live configuration, which holds the shared
		// infrastructure the draft will `include:` — the thing the partial drafts
		// tree could not resolve (`staged-env-setup-config-root`).
		expect(
			(
				await materializeStagedRoot({
					configDir,
					draftsDir,
					secret: PROMOTION_SECRET,
				})
			).ok,
		).toBe(true);
		const root = stagedRootOf(draftsDir);
		writeFile(
			path.join(root, "apps", "compose", "shop-compose.yml"),
			[
				"include:",
				"  - ../../infrastructure/compose/network.yml",
				"services:",
				"  shop:",
				"    image: shop:latest",
				"    ports:",
				'      - "8090:8080"',
				"    environment:",
				// biome-ignore lint/suspicious/noTemplateCurlyInString: compose interpolates the injected OTel variable
				"      OTEL_EXPORTER_OTLP_ENDPOINT: ${AC_OTEL_ENDPOINT}",
				"",
			].join("\n"),
		);
		const checkout = tempDir("env-setup-acceptance-checkout-");

		// 1. The gate runs discover -> compile -> the default build -> start ->
		// the default test against the staged root, and records the reviewed
		// digests the promotion will hold it to.
		const ran: string[] = [];
		const report = await validateSetupDrafts(
			stagedGateContext({
				configDir,
				draftsDir,
				checkoutDir: checkout,
				buildTarget: async () => {
					ran.push("build");
					return { ok: true, exitCode: 0 };
				},
				testTarget: async () => {
					ran.push("test");
					return { ok: true, exitCode: 0 };
				},
			}),
		);
		expect(ran).toEqual(["build", "test"]);
		expect(report.steps.find((step) => step.step === "start")?.status).toBe(
			"ok",
		);
		expect(report.targets[0]?.sourcePath.startsWith(`${root}${path.sep}`)).toBe(
			true,
		);
		expect(
			path.resolve(
				path.dirname(report.targets[0]?.sourcePath ?? ""),
				"../../infrastructure/compose/network.yml",
			),
		).toBe(path.join(root, "infrastructure", "compose", "network.yml"));

		// 2. The developer approves exactly what the gate reviewed, and the
		// promotion publishes it into the live configuration.
		const promoted = await promoteSetupDrafts({
			configDir,
			draftsDir,
			backupDir: setupBackupDir(configDir, "wf-1"),
			workflowId: "wf-1",
			runId: "run-1",
			secret: PROMOTION_SECRET,
			reviewed: report.reviewed,
		});
		expect(promoted.ok).toBe(true);
		const live = path.join(configDir, "apps", "compose", "shop-compose.yml");
		expect(fs.readFileSync(live, "utf8")).toContain("include:");

		// 3. The smoke check's proof: every promoted file still holds the digest
		// the gate recorded, so `build: skipped (proven identical by the gate)`.
		const diverged = Object.entries(report.reviewed).filter(
			([relative, digest]) =>
				reviewedDigest(
					fs.readFileSync(path.join(configDir, ...relative.split("/")), "utf8"),
				) !== digest,
		);
		expect(diverged).toEqual([]);

		// 4. And the failure half of the scenario: a live file the developer
		// changed after the review is refused instead of overwritten.
		writeFile(
			path.join(configDir, "apps", "compose", "shop-compose.yml"),
			"services: {}\n",
		);
		const replayed = await promoteSetupDrafts({
			configDir,
			draftsDir: `${draftsDir}.promoted`,
			backupDir: setupBackupDir(configDir, "wf-1"),
			workflowId: "wf-1",
			runId: "run-1",
			secret: PROMOTION_SECRET,
			reviewed: report.reviewed,
		});
		expect(replayed.ok).toBe(false);
		expect(
			fs.readFileSync(
				path.join(configDir, "apps", "compose", "shop-compose.yml"),
				"utf8",
			),
		).toBe("services: {}\n");
	});
});

describe("the promotion's non-regular and unreviewed refusals", () => {
	test("a staged symlink draft is refused, the live file is untouched and no backup is taken", async () => {
		const { configDir } = liveConfig("env-setup-promote-symlink-");
		const draftsDir = setupDraftsDir(configDir, "wf-1");
		await materializeStagedRoot({
			configDir,
			draftsDir,
			secret: PROMOTION_SECRET,
		});
		const root = stagedRootOf(draftsDir);
		writeFile(
			path.join(root, "apps", "compose", "shop-compose.yml"),
			`${COMPOSE_WITH_OTEL}# edited\n`,
		);
		// The author replaces a drafted file with a symlink: only plain files may be
		// published, and a staged symlink now *resolves* as a target, so this refusal
		// is the last line of defence.
		const drafted = path.join(root, "apps", "run", "shop-run.sh");
		fs.mkdirSync(path.dirname(drafted), { recursive: true });
		fs.symlinkSync("/bin/true", drafted);
		const result = await promoteSetupDrafts({
			configDir,
			draftsDir,
			backupDir: setupBackupDir(configDir, "wf-1"),
			workflowId: "wf-1",
			runId: "run-1",
			secret: PROMOTION_SECRET,
			reviewed: reviewedFor(draftsDir),
		});
		expect(result.ok).toBe(false);
		expect(result.error ?? "").toContain("drafts must be plain files");
		expect(result.error ?? "").toContain("apps/run/shop-run.sh");
		expect(
			fs.readFileSync(
				path.join(configDir, "apps", "compose", "shop-compose.yml"),
				"utf8",
			),
		).toBe(COMPOSE_WITH_OTEL);
		expect(fs.existsSync(setupBackupDir(configDir, "wf-1"))).toBe(false);
	});

	test("a staged root without a review record is refused", async () => {
		const { configDir } = liveConfig("env-setup-promote-unreviewed-");
		const draftsDir = setupDraftsDir(configDir, "wf-1");
		await materializeStagedRoot({
			configDir,
			draftsDir,
			secret: PROMOTION_SECRET,
		});
		writeFile(
			path.join(stagedRootOf(draftsDir), "apps", "compose", "shop-compose.yml"),
			`${COMPOSE_WITH_OTEL}# edited\n`,
		);
		const result = await promoteSetupDrafts({
			configDir,
			draftsDir,
			backupDir: setupBackupDir(configDir, "wf-1"),
			workflowId: "wf-1",
			runId: "run-1",
			secret: PROMOTION_SECRET,
		});
		expect(result.ok).toBe(false);
		expect(result.error ?? "").toContain("not reviewed by the validation gate");
		expect(
			fs.readFileSync(
				path.join(configDir, "apps", "compose", "shop-compose.yml"),
				"utf8",
			),
		).toBe(COMPOSE_WITH_OTEL);
	});
});

describe("the review the approval view is served from", () => {
	test("a file changed after the gate is reported as drift, not rendered as the review", async () => {
		const { configDir } = liveConfig("env-setup-drift-");
		const draftsDir = setupDraftsDir(configDir, "wf-1");
		await materializeStagedRoot({
			configDir,
			draftsDir,
			secret: PROMOTION_SECRET,
		});
		const drafted = path.join(
			stagedRootOf(draftsDir),
			"apps",
			"compose",
			"shop-compose.yml",
		);
		writeFile(drafted, `${COMPOSE_WITH_OTEL}# reviewed\n`);
		const reviewed = reviewedFor(draftsDir);
		expect(setupReviewDrift(draftsDir, reviewed)).toEqual([]);
		// The author swaps the reviewed content for something else while the
		// developer reads the modal.
		writeFile(drafted, `${COMPOSE_WITH_OTEL}# swapped\n`);
		expect(setupReviewDrift(draftsDir, reviewed)).toEqual([
			"apps/compose/shop-compose.yml",
		]);
		// A workflow with no recorded review has nothing to compare against.
		expect(setupReviewDrift(draftsDir, undefined)).toEqual([]);
	});
});
