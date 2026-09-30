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
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const configured = process.env.AGENTIC_CODING_CONFIG_DIR;
if (!configured) {
	process.env.AGENTIC_CODING_CONFIG_DIR = fs.mkdtempSync(
		path.join(os.tmpdir(), "agentic-coding-test-config-"),
	);
}
