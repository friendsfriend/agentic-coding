// Sidebar mode persistence (workspace sidebar): the expand/permanent toggle
// writes `ui.sidebar_mode` back to the winning user configuration, preserving
// every other key, and refuses a legacy TOML target instead of converting it.
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

test("saveSidebarMode refuses a legacy TOML target and leaves it untouched", () => {
	withConfigFile("config.toml", 'ui = { theme = "catppuccin" }\n', (file) => {
		const before = fs.readFileSync(file, "utf8");
		expect(() => saveSidebarMode("permanent")).toThrow(/legacy TOML/);
		expect(fs.readFileSync(file, "utf8")).toBe(before);
	});
});
