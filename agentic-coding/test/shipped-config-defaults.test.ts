import { expect, test } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import { DEFAULT_CONFIG } from "../src/workflow/effects.ts";

/** The config stow copies for a fresh install defaults session content capture
 * on, matching `DEFAULT_CONFIG` in `src/workflow/effects.ts` and
 * `docs/agent-session-telemetry.md`: captured prompts, tool arguments, and tool
 * results reach the span detail unless the user opts out. */
test("shipped config enables session content capture by default", () => {
	const template = JSON.parse(
		fs.readFileSync(
			path.resolve(import.meta.dir, "..", "..", "pi", "herdr-workflow.json"),
			"utf8",
		),
	) as { telemetry?: { capture_content?: unknown } };
	expect(template.telemetry?.capture_content).toBe(true);
	// The built-in fallback (no config file anywhere) must agree with the
	// shipped template, so neither can silently disable capture.
	expect(DEFAULT_CONFIG.telemetry.capture_content).toBe(true);
});
