// Sidebar mode persistence (workspace sidebar): the expand/permanent toggle
// writes `ui.sidebar_mode` back to the canonical user configuration, preserving
// every other key. An obsolete configuration file is never a write target.
import { expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { loadConfig, saveSidebarMode } from "../src/workflow/effects.ts";

function withConfigFile<T>(
	name: string,
	contents: string,
	run: (file: string) => T,
): T {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "sidebar-mode-"));
	const file = path.join(dir, name);
	fs.writeFileSync(file, contents);
	const previous = process.env.HERDR_WORKFLOW_CONFIG;
	process.env.HERDR_WORKFLOW_CONFIG = file;
	try {
		return run(file);
	} finally {
		if (previous === undefined) delete process.env.HERDR_WORKFLOW_CONFIG;
		else process.env.HERDR_WORKFLOW_CONFIG = previous;
		fs.rmSync(dir, { recursive: true, force: true });
	}
}

test("saveSidebarMode writes ui.sidebar_mode and preserves every other key", () => {
	withConfigFile(
		"config.json",
		`${JSON.stringify({
			workflow: { remote: "origin" },
			ui: { theme: "catppuccin" },
			telemetry: { capture_content: true },
		})}\n`,
		(file) => {
			saveSidebarMode("permanent");
			const document = JSON.parse(fs.readFileSync(file, "utf8")) as {
				ui: Record<string, unknown>;
				workflow: Record<string, unknown>;
				telemetry: Record<string, unknown>;
			};
			expect(document.ui.sidebar_mode).toBe("permanent");
			expect(document.ui.theme).toBe("catppuccin");
			expect(document.workflow.remote).toBe("origin");
			expect(document.telemetry.capture_content).toBe(true);
			// The engine reads the persisted value back.
			expect(loadConfig().ui.sidebar_mode).toBe("permanent");

			saveSidebarMode("expanding");
			expect(loadConfig().ui.sidebar_mode).toBe("expanding");
		},
	);
});

test("an obsolete configuration file is never the write target", () => {
	// Only an obsolete file exists: the explicit replacement file is absent, so
	// the canonical JSON config under the resolved root is written instead and
	// the obsolete file is left byte-identical.
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "sidebar-mode-"));
	const root = path.join(dir, "agentic-coding");
	fs.mkdirSync(root, { recursive: true });
	const obsolete = path.join(root, "config.toml");
	fs.writeFileSync(obsolete, 'ui = { theme = "catppuccin" }\n');
	const previous = process.env.AGENTIC_CODING_CONFIG_DIR;
	const previousConfig = process.env.HERDR_WORKFLOW_CONFIG;
	process.env.AGENTIC_CODING_CONFIG_DIR = root;
	delete process.env.HERDR_WORKFLOW_CONFIG;
	try {
		saveSidebarMode("permanent");
		expect(fs.readFileSync(obsolete, "utf8")).toBe(
			'ui = { theme = "catppuccin" }\n',
		);
		expect(
			JSON.parse(fs.readFileSync(path.join(root, "config.json"), "utf8")),
		).toEqual({ ui: { sidebar_mode: "permanent" } });
	} finally {
		if (previous === undefined) delete process.env.AGENTIC_CODING_CONFIG_DIR;
		else process.env.AGENTIC_CODING_CONFIG_DIR = previous;
		if (previousConfig === undefined) delete process.env.HERDR_WORKFLOW_CONFIG;
		else process.env.HERDR_WORKFLOW_CONFIG = previousConfig;
		fs.rmSync(dir, { recursive: true, force: true });
	}
});
