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
// A test that needs a specific root still sets `AGENTIC_CODING_CONFIG_DIR` itself
// after this preload runs.
import { afterAll } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// Installed unconditionally, deliberately. Deciding based on the incoming value
// inverted this preload's own contract: a shell that already exports
// AGENTIC_CODING_CONFIG_DIR — the workflow runner exports exactly that to the
// agents it launches, and a CI job or developer shell may too — silently kept the
// ambient root and reinstated the 324 MB sidecar load this file exists to
// prevent, with no test failing. A test that needs a specific root still wins, by
// setting (or deleting) the variable itself after this preload has run, which is
// what test/config-diagnostics.test.ts, test/backend-lifecycle.test.ts and
// test/workflow-classifiers.test.ts already do.
//
// Scope note, measured rather than assumed: a hook registered by a *preload* is
// process-scoped (it printed after the last file), whereas the same hook
// registered by an ordinary imported module is FILE-scoped (it printed after the
// first file that imported it — which is why test/support/git-fixture.ts owns no
// hook at all). This file is a preload, so the sweep below runs once, at the end
// of the process.
const root = fs.mkdtempSync(
	path.join(os.tmpdir(), "agentic-coding-test-config-"),
);
// Unswept, this leaves one directory per test process (~136 per full run) in
// $TMPDIR, growing without bound across runs. `process.on("exit")` never runs
// under `bun test` (measured), so the sweep has to be a test hook.
afterAll(() => {
	fs.rmSync(root, { recursive: true, force: true });
});
process.env.AGENTIC_CODING_CONFIG_DIR = root;

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
