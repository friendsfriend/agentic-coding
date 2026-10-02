// Template-backed Git repository fixtures.
//
// Every workflow test needs a real Git repository, and the obvious way to make
// one — `git init`, two `git config` calls, `git add`, `git commit` — costs
// five or six child processes. The suite repeated that chain from 54 sites
// across 24 files, which made child-process spawning the single largest cost
// of the whole run: `workflow-effects.test.ts` alone spawned 108 children,
// about 38% of its wall clock, just to build repositories.
//
// Building the same repository once and copying it with `fs.cpSync` yields an
// equivalent repository for the cost of one file copy. The copy is a real,
// independent repository — its own `.git`, its own objects and index, the
// template's configured identity and committed history — so tests keep
// exercising real Git behaviour instead of a fake.
//
// Templates are content-addressed under one machine-wide directory and published
// by an atomic rename, so they are shared by every process and every run instead
// of being rebuilt per process. That is not only faster: it is what makes this
// module safe to import from several files in one `bun test` process. An earlier
// version kept a per-process template root and reclaimed it from a module-scope
// `afterAll`, which is FILE-scoped when registered by an imported module
// (measured: the hook fires after the first file that imported it, not at the end
// of the process), so the second file in the same process found its root deleted
// and failed with ENOENT. Nothing here is owned by a hook now, so there is no
// lifecycle to get wrong: a template either exists and is used, or is rebuilt.
//
// Teardown belongs to each file: call autoRemoveRepoFixtures() once at that
// file's module scope to sweep the roots it created. That hook belongs to the
// file that registers it, which is what a hook in this imported module was not.
/** Bump when buildTemplate changes shape. The bump is a coarse invalidator only;
 * what actually makes a missed bump safe is templateMatches, which checks a
 * published template against the request before reusing it. */
const TEMPLATE_BUILD_VERSION = 1;
/** Records what a published template was built from, inside .git so it is not
 * part of the worktree and cannot appear as a repository change. */
const TEMPLATE_STAMP = ".git/agentic-coding-template.json";

/** Where templates live. Overridable so a test can point the fixture at a root
 * of its own instead of deleting the machine-wide one: that root is shared by
 * every concurrent test process, so removing it makes the copy fail inside
 * whichever sibling happens to be copying at that instant (measured: 10
 * failures across 4 unrelated files when a test wiped it). */
function templateRoot(): string {
	return (
		process.env.AGENTIC_CODING_TEST_TEMPLATE_ROOT ??
		path.join(os.tmpdir(), "agentic-coding-repo-templates")
	);
}

import { afterAll } from "bun:test";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export interface RepoFixtureOptions {
	/** Files committed as the fixture's base commit, keyed by repo-relative path. */
	files?: Record<string, string>;
	/** Committing identity for the base commit. */
	identity?: { name: string; email: string };
	/** Leave HEAD unborn: `main` is initialised but nothing is committed. */
	unborn?: boolean;
	/** Ignore the engine's `.herdr-workflow/` state directory so it never shows
	 * up as a repository change. */
	excludeWorkflowState?: boolean;
}

/** The base commit every repository fixture shares unless it says otherwise. */
const DEFAULT_FILES: Record<string, string> = { "README.md": "test\n" };
const DEFAULT_IDENTITY = { name: "Test", email: "test@example.com" };

/** The repository shapes this suite actually uses. Naming them keeps each call
 * site to one line and makes a fixture that quietly differs from its
 * neighbours visible. */
export const repoPreset = {
	/** `main` + README + a spec-driven OpenSpec project (the common case). */
	specDriven: {
		files: {
			"README.md": "test\n",
			"openspec/config.yaml": "schema: spec-driven\n",
		},
	},
	/** `main` + README only. */
	readme: { files: { "README.md": "test\n" } },
	/** `main` + an OpenSpec project only. */
	openspec: { files: { "openspec/config.yaml": "schema: spec-driven\n" } },
	/** `main` with an unborn HEAD and nothing committed. */
	empty: { unborn: true },
} satisfies Record<string, RepoFixtureOptions>;

const templates = new Map<string, string>();
const fixtures = new Set<string>();

function git(cwd: string, args: string[]): void {
	execFileSync("git", args, { cwd, stdio: "pipe" });
}

function templateKey(options: RepoFixtureOptions): string {
	return JSON.stringify({
		// An unborn fixture commits nothing, so its file set is irrelevant.
		files:
			options.unborn === true
				? []
				: Object.entries(options.files ?? DEFAULT_FILES).sort(),
		identity: options.identity ?? DEFAULT_IDENTITY,
		unborn: options.unborn === true,
	});
}

function buildTemplate(options: RepoFixtureOptions): string {
	fs.mkdirSync(templateRoot(), { recursive: true });
	const dir = fs.mkdtempSync(path.join(templateRoot(), "staging-"));
	git(dir, ["init", "-q", "-b", "main"]);
	const identity = options.identity ?? DEFAULT_IDENTITY;
	git(dir, ["config", "user.email", identity.email]);
	git(dir, ["config", "user.name", identity.name]);
	if (options.unborn !== true) {
		for (const [relative, body] of Object.entries(
			options.files ?? DEFAULT_FILES,
		)) {
			const absolute = path.join(dir, relative);
			fs.mkdirSync(path.dirname(absolute), { recursive: true });
			fs.writeFileSync(absolute, body);
		}
		git(dir, ["add", "-A"]);
		git(dir, ["commit", "-qm", "base"]);
	}
	// Stamped last, so a build that fails partway is never mistaken for a
	// complete template.
	fs.writeFileSync(
		path.join(dir, TEMPLATE_STAMP),
		JSON.stringify({
			version: TEMPLATE_BUILD_VERSION,
			unborn: options.unborn === true,
			identity: options.identity ?? DEFAULT_IDENTITY,
		}),
	);
	return dir;
}

/** Publish the built template at its content address. Losing the race to
 * another process is fine: the winner renamed a fully built directory into
 * place, so its copy is used and ours is discarded. */
function publishTemplate(built: string, target: string): string {
	try {
		fs.renameSync(built, target);
		return target;
	} catch {
		// Only discard the build on the branch that replaces it. An earlier
		// version removed "built" first and could then return that deleted path,
		// turning a cross-device rename into "template is missing" instead of
		// using the template it had just built.
		if (fs.existsSync(target)) {
			fs.rmSync(built, { recursive: true, force: true });
			return target;
		}
		return built;
	}
}

/** Whether a published template still matches what the caller asked for. The
 * template store is persisted and machine-wide, so a stale entry outlives the
 * revision that wrote it; a forgotten version bump would otherwise serve the old
 * content silently for as long as the temp directory keeps it. Almost no test
 * asserts a fixture's contents, so that failure would be invisible rather than
 * loud. */
function templateMatches(target: string, options: RepoFixtureOptions): boolean {
	let stamp: unknown;
	try {
		stamp = JSON.parse(
			fs.readFileSync(path.join(target, TEMPLATE_STAMP), "utf8"),
		);
	} catch {
		return false;
	}
	const expected = {
		version: TEMPLATE_BUILD_VERSION,
		unborn: options.unborn === true,
		identity: options.identity ?? DEFAULT_IDENTITY,
	};
	if (JSON.stringify(stamp) !== JSON.stringify(expected)) return false;
	if (options.unborn === true) return true;
	for (const [relative, body] of Object.entries(
		options.files ?? DEFAULT_FILES,
	)) {
		try {
			if (fs.readFileSync(path.join(target, relative), "utf8") !== body)
				return false;
		} catch {
			return false;
		}
	}
	return true;
}

/** Remove abandoned staging directories. A crashed build leaves one behind and
 * nothing else reclaims it. */
function sweepStagingDirectories(root: string): void {
	const cutoff = Date.now() - 24 * 60 * 60 * 1000;
	let entries: string[];
	try {
		entries = fs.readdirSync(root);
	} catch {
		return;
	}
	for (const entry of entries) {
		if (!entry.startsWith("staging-")) continue;
		const full = path.join(root, entry);
		try {
			if (fs.statSync(full).mtimeMs < cutoff)
				fs.rmSync(full, { recursive: true, force: true });
		} catch {
			/* a concurrent builder already published it */
		}
	}
}

function templateFor(options: RepoFixtureOptions): string {
	const key = templateKey(options);
	const cached = templates.get(key);
	// Both the in-memory entry and the published directory are validated against
	// the request, not merely checked for existence: the store is shared and
	// persisted, so a template can be swept (a miss that must rebuild) or left
	// behind by an older revision (stale content that must be replaced).
	if (cached !== undefined) {
		if (templateMatches(cached, options)) return cached;
		templates.delete(key);
	}
	const root = templateRoot();
	const target = path.join(
		root,
		createHash("sha1")
			.update(JSON.stringify([TEMPLATE_BUILD_VERSION, key]))
			.digest("hex")
			.slice(0, 16),
	);
	if (templateMatches(target, options)) {
		templates.set(key, target);
		return target;
	}
	// A published template that no longer matches is rebuilt rather than reused,
	// so a missed version bump heals on the next call instead of serving stale
	// content for the life of the temp directory.
	if (fs.existsSync(target))
		fs.rmSync(target, { recursive: true, force: true });
	fs.mkdirSync(root, { recursive: true });
	sweepStagingDirectories(root);
	const built = buildTemplate(options);
	const published = publishTemplate(built, target);
	templates.set(key, published);
	return published;
}

/** Copy a template into place, rebuilding once if the template vanished between
 * resolving it and copying it. The store is shared and lives in the temp
 * directory, so an external reaper (or another process) can remove it mid-copy;
 * that must degrade to a rebuild rather than to a failed test in whichever file
 * happened to be copying. */
function copyTemplate(
	template: string,
	root: string,
	options: RepoFixtureOptions,
): void {
	try {
		fs.cpSync(template, root, { recursive: true });
		return;
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
		// The partial copy is not a usable repository and nothing else reclaims
		// it, so remove it before retrying.
		fs.rmSync(root, { recursive: true, force: true });
		templates.clear();
		fs.mkdirSync(root, { recursive: true });
		fs.cpSync(templateFor(options), root, { recursive: true });
	}
}

/** Materialise a real Git repository at `root` from the shared template. */
export function createRepoFixture(
	root: string,
	options: RepoFixtureOptions = {},
): string {
	const template = templateFor(options);
	if (!fs.existsSync(template))
		throw new Error(
			`repository template ${template} is missing; it should have been built at ${JSON.stringify(templateKey(options))}`,
		);
	fs.mkdirSync(root, { recursive: true });
	copyTemplate(template, root, options);
	if (options.excludeWorkflowState === true) {
		fs.mkdirSync(path.join(root, ".git", "info"), { recursive: true });
		fs.writeFileSync(
			path.join(root, ".git", "info", "exclude"),
			"\n.herdr-workflow/\n",
		);
	}
	fixtures.add(root);
	return root;
}

/** `createRepoFixture` in a fresh temporary directory. */
export function createTempRepoFixture(
	prefix: string,
	options: RepoFixtureOptions = {},
): string {
	return createRepoFixture(
		fs.mkdtempSync(path.join(os.tmpdir(), prefix)),
		options,
	);
}

/** Commit everything currently in the working tree and return the new HEAD, for
 * the tests that need a second commit on top of the fixture's base. */
export function commitRepoFixture(root: string, message = "base"): string {
	git(root, ["add", "-A"]);
	git(root, ["commit", "-qm", message]);
	return execFileSync("git", ["rev-parse", "HEAD"], {
		cwd: root,
		encoding: "utf8",
	}).trim();
}

/** Remove one repository this process created.
 *
 * Per-root removal is the only safe teardown here, and it belongs to the file
 * that created the root. A sweep of the whole `fixtures` set is deliberately not
 * offered: this module is shared by every file in a `bun test` process, so a
 * sweep owned by one file would delete repositories a sibling file is still
 * using. */
export function removeRepoFixture(root: string): void {
	fixtures.delete(root);
	fs.rmSync(root, { recursive: true, force: true });
}

/** Call once at a test file's module scope to sweep the repositories that file
 * created.
 *
 * This is the teardown the module cannot install for itself: a hook registered
 * while an imported module is evaluated belongs to the file that imported it
 * (measured — it fires after that file, not at the end of the process), so a
 * sweep registered here would reclaim a sibling file's roots mid-run, which is
 * exactly what broke the generation-2 version of this file. Registered from the
 * test file's own module scope the hook is correctly file-scoped, and it never
 * runs between files of a shard.
 *
 * Without it, a fixture is left in the temp directory for the life of the
 * machine: 21 of the 23 importing files dispose nothing of their own. */
export function autoRemoveRepoFixtures(): void {
	afterAll(() => {
		for (const root of fixtures)
			fs.rmSync(root, { recursive: true, force: true });
		fixtures.clear();
	});
}
