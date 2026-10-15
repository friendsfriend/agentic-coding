// Every test process runs with an isolated application configuration root, so the
// developer's own `$CONFIG_ROOT/.env` and `[agents].classifier.provider` cannot
// decide what a test sees.
//
// Measured, not theoretical: with a configuration root that selects the local
// classifier, tests that resolve a classifier binding without pinning a provider
// reach `prepareProvider`, which starts the local sidecar — a 324 MB model load,
// concurrently, in up to three test processes. The full suite only went green once
// the sidecar was stopped, and before that the failures moved between files on
// every run (truncated output, all tests passing, process gone). An isolated root
// makes the fallback the built-in hosted provider, so the same resolution is
// deterministic on every machine.
//
// The full isolation contract — which locations a test process may write to, and
// which it must not — is written down in `docs/test-isolation.md`. In one line:
// every location below is a throwaway directory that this process removes when it
// ends, so nothing a test writes can outlive it.
//
//   AGENTIC_CODING_CONFIG_DIR  the configuration root (the sandbox itself)
//   HERDR_WIKI_DIR             the wiki bundle — and with it the workflow data
//                              root, which is the wiki root's *parent* directory
//                              plus `.agentic-coding-workflow`
//   HOME, XDG_*                the sandbox home, for the process and every child
//   TMPDIR                     the sandbox, so `mkdtempSync(os.tmpdir(), …)`
//                              inside a test or inside the code under test is
//                              swept with it
//
// One gap is named rather than papered over: Bun captures HOME when the process
// starts, so a later `process.env.HOME` is invisible to `os.homedir()`
// (measured). A bare `bun test <file>` therefore still *reads* the developer's
// own home for the few paths derived from it — `~/devenv`, `~/.config/otel-tui`,
// `~/.pi/agent`. Pointing the variable here covers every child process and every
// reader of the variable; `bun run test` (`scripts/test.ts`) additionally pins
// HOME per job, and the before/after check at the bottom fails the run when the
// real configuration directory was written to regardless.
//
// `AGENTIC_CODING_TEST_KEEP_TEMP=1` keeps the sandbox and prints its path. The
// sweep is what makes a leaked temporary directory invisible, so inspecting one
// has to be asked for explicitly.
//
// A test that needs a specific root still sets `AGENTIC_CODING_CONFIG_DIR` itself
// after this preload runs.
import { afterAll } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
	assertRealConfigUntouched,
	realConfigRoot,
	snapshotRealConfig,
} from "./real-config-guard.ts";

// The developer's own locations, captured before anything below repoints them.
// The suite runner exports AGENTIC_CODING_TEST_REAL_HOME because its jobs are
// already launched with an isolated HOME; a bare `bun test` still has the real
// home in HOME.
const realHome =
	process.env.AGENTIC_CODING_TEST_REAL_HOME ?? process.env.HOME ?? os.homedir();
// Published for the guard test (test/config-isolation.test.ts) and for the
// children a test spawns: once HOME is repointed below, nothing else in this
// process can name the developer's home any more.
process.env.AGENTIC_CODING_TEST_REAL_HOME = realHome;
const realTemporaryDirectory = os.tmpdir();

// Counted before the sandbox exists and compared after the last test. Read-only,
// and skipped entirely when the developer has no configuration directory: the
// marker files the stale registry holds are the developer's to clean up, not this
// preload's to touch.
const realConfigBefore = snapshotRealConfig(realConfigRoot(realHome));

// Installed unconditionally, deliberately. Deciding based on the incoming value
// inverted this preload's own contract: a shell that already exports
// AGENTIC_CODING_CONFIG_DIR — the workflow runner exports exactly that to the
// agents it launches, and a CI job or developer shell may too — silently kept the
// ambient root and reinstated the 324 MB sidecar load this file exists to
// prevent, with no test failing. A test that needs a specific root still wins, by
// setting (or deleting) the variable itself after this preload has run, which is
// what test/config-diagnostics.test.ts, test/backend-lifecycle.test.ts and
// test/workflow-classifiers.test.ts already do.
const root = fs.mkdtempSync(
	path.join(realTemporaryDirectory, "agentic-coding-test-sandbox-"),
);
const temporaryDirectory = path.join(root, "tmp");
// A launcher that has already isolated the home directory (the suite runner does)
// wins: `os.homedir()` captured that value at process start, so repointing the
// variable here would leave `os.homedir()` and `process.env.HOME` naming two
// different homes inside one process.
const sandboxHome =
	process.env.AGENTIC_CODING_TEST_HOME ?? path.join(root, "home");
for (const directory of [
	temporaryDirectory,
	sandboxHome,
	path.join(sandboxHome, ".config"),
	path.join(sandboxHome, ".cache"),
	path.join(sandboxHome, ".local", "share"),
	path.join(sandboxHome, ".local", "state"),
])
	fs.mkdirSync(directory, { recursive: true });

// Scope note, measured rather than assumed: a hook registered by a *preload* is
// process-scoped (it printed after the last file), whereas the same hook
// registered by an ordinary imported module is FILE-scoped (it printed after the
// first file that imported it — which is why test/support/git-fixture.ts owns no
// hook at all). This file is a preload, so the sweep below runs once, at the end
// of the process, after every file's own teardown. The sandbox is unswept for one
// directory per test process (~136 per full run) in $TMPDIR, growing without
// bound across runs; `process.on("exit")` never runs under `bun test` (measured),
// so the sweep has to be a test hook.
afterAll(() => {
	// The leak check runs first and reports last, so a sandbox that cannot be
	// removed cannot hide the finding that matters.
	let failure: unknown;
	try {
		assertRealConfigUntouched(
			realConfigBefore,
			snapshotRealConfig(realConfigRoot(realHome)),
		);
	} catch (error) {
		failure = error;
	}
	if (process.env.AGENTIC_CODING_TEST_KEEP_TEMP) {
		process.stderr.write(`[test-isolation] kept sandbox ${root}\n`);
	} else {
		fs.rmSync(root, { recursive: true, force: true });
	}
	if (failure) throw failure;
});

process.env.AGENTIC_CODING_CONFIG_DIR = root;
// The wiki bundle pins the workflow data root too: `wikiWorkflowDataRoot()` is
// the wiki root's parent directory plus `.agentic-coding-workflow`, so this one
// variable also moves the shared store and the workflow target registry the
// dashboard reads.
process.env.HERDR_WIKI_DIR = path.join(root, "wiki");
// The home directory and the XDG directories under it. Production code still
// writes `~/devenv/logs`, `~/.config/otel-tui` and `~/.local/share/*`, and those
// write against the developer's real home unless the variable is repointed here
// (for this process's children and readers) or by the launcher (for
// `os.homedir()`, which cannot be repointed after start).
process.env.HOME = sandboxHome;
process.env.XDG_CONFIG_HOME = path.join(sandboxHome, ".config");
process.env.XDG_CACHE_HOME = path.join(sandboxHome, ".cache");
process.env.XDG_DATA_HOME = path.join(sandboxHome, ".local", "share");
process.env.XDG_STATE_HOME = path.join(sandboxHome, ".local", "state");
// Bun reads TMPDIR per call (measured, unlike HOME), so every
// `mkdtempSync(os.tmpdir(), …)` a test or the code under test performs lands in
// the sandbox and is removed with it. Measured without it: 510 directories —
// including 27 leaked `env-setup-observations-repo-*` repositories over a few
// runs — survived a full run of 208 jobs.
process.env.TMPDIR = temporaryDirectory;
// The repository-template store is the one thing deliberately kept out of the
// sandbox: it is machine-wide and published atomically so a fixture is built once
// instead of five or six Git children per file that needs one. Redirecting it
// into the sandbox would rebuild every template in every process.
if (!process.env.AGENTIC_CODING_TEST_TEMPLATE_ROOT)
	process.env.AGENTIC_CODING_TEST_TEMPLATE_ROOT = path.join(
		realTemporaryDirectory,
		"agentic-coding-repo-templates",
	);
// An explicit full-replacement configuration bypasses the isolated root entirely,
// and the deprecated alias selects the same root by a second name. Both are
// cleared unconditionally, for the reason above: an ambient value must not decide
// what a test sees. A test that needs either sets it itself after this preload.
delete process.env.HERDR_WORKFLOW_CONFIG;
delete process.env.DEVENV_CONFIG_DIR;

// The workflow runner also exports the authenticated server handoff to every
// managed child, so a test process started by a workflow inherits
// `AGENTIC_WORKFLOW_URL`/`AGENTIC_WORKFLOW_TOKEN` and would reach the *live*
// server through `backendClientFromEnv()`. Measured, not theoretical: the
// durable `environment.teardown` effect resolves exactly that client, so a
// test's `deleteWorkflow` posted to the running server and released a real app
// run (and answered `unknown route` against a server built from other sources).
// The handoff is cleared unconditionally, like the configuration root above; a
// test that needs a server of its own sets these itself (test/otel/
// workspaceSidebar.test.tsx does).
delete process.env.AGENTIC_WORKFLOW_URL;
delete process.env.AGENTIC_WORKFLOW_TOKEN;
