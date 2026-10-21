// The legacy snapshot-mode removal gate (`improve-browser-agent-loop`, tasks
// 8.7/8.8). AI is the only snapshot contract, so the one-release rollback must
// stay deleted: this scans the browser sources, the browser settings and the
// docs for every legacy symbol, so a reintroduced walker, `data-ac-ref` parser or
// mode switch fails CI instead of quietly shipping a second ref grammar.
import { describe, expect, test } from "bun:test";
import fs from "node:fs";
import path from "node:path";

const ROOT = path.join(import.meta.dir, "..");

/** Every source surface the removed legacy mode lived on. */
const SOURCE_ROOTS = [
	"src/server/browser",
	"src/server/app.ts",
	"src/contracts/browser.ts",
	"src/workflow/effects.ts",
	"src/tui/settings",
];

/** Symbols that only ever existed for the rollback. `legacy` alone is not
 * scanned: other domains use the word for their own older payload shapes. */
const REMOVED_SYMBOLS = [
	"SNAPSHOT_SCRIPT",
	"SNAPSHOT_REF_ATTRIBUTE",
	"captureLegacySnapshot",
	"refSelector",
	"SnapshotMode",
	"BrowserSnapshotMode",
	"resolvedSnapshotMode",
	"snapshotMode",
	"snapshot_mode",
	"snapshot-mode-legacy",
	"data-ac-ref",
];

function sourceFiles(): { file: string; text: string }[] {
	const files: { file: string; text: string }[] = [];
	const collect = (target: string) => {
		const full = path.join(ROOT, target);
		const stats = fs.statSync(full);
		if (stats.isFile()) {
			files.push({ file: target, text: fs.readFileSync(full, "utf8") });
			return;
		}
		for (const entry of fs.readdirSync(full, { recursive: true })) {
			const relative = path.join(target, String(entry));
			if (!fs.statSync(path.join(ROOT, relative)).isFile()) continue;
			if (!/\.(ts|tsx)$/.test(relative)) continue;
			files.push({
				file: relative,
				text: fs.readFileSync(path.join(ROOT, relative), "utf8"),
			});
		}
	};
	for (const root of SOURCE_ROOTS) collect(root);
	return files;
}

describe("legacy snapshot-mode removal gate", () => {
	test("no browser source names a removed legacy symbol", () => {
		const offenders: string[] = [];
		for (const { file, text } of sourceFiles()) {
			for (const symbol of REMOVED_SYMBOLS) {
				if (text.includes(symbol)) offenders.push(`${file}: ${symbol}`);
			}
		}
		expect(offenders).toEqual([]);
	});

	test("the browser settings no longer expose a snapshot mode", async () => {
		const { resolvedBrowserSettings, DEFAULT_CONFIG } = await import(
			"../src/workflow/effects.ts"
		);
		const resolved = resolvedBrowserSettings(DEFAULT_CONFIG);
		expect(Object.keys(resolved)).not.toContain("snapshotMode");
		expect(Object.keys(DEFAULT_CONFIG.browser ?? {})).not.toContain(
			"snapshot_mode",
		);
	});

	test("a configuration that still names the removed setting has no effect", async () => {
		const { resolvedBrowserSettings } = await import(
			"../src/workflow/effects.ts"
		);
		const stale = resolvedBrowserSettings({
			browser: {
				max_sessions: 2,
				// The removed rollback value: it must be ignored, not restore a
				// second snapshot contract.
				snapshot_mode: "legacy",
			},
		} as unknown as Parameters<typeof resolvedBrowserSettings>[0]);
		expect(stale.maxSessions).toBe(2);
		expect(Object.keys(stale)).not.toContain("snapshotMode");
	});

	test("the browser contract no longer carries a mode status field", () => {
		const contract = fs.readFileSync(
			path.join(ROOT, "src/contracts/browser.ts"),
			"utf8",
		);
		expect(contract).not.toContain('"ai", "legacy"');
		expect(contract).not.toContain("mode:");
	});

	test("the rollback documentation is gone", () => {
		const docs = fs.readFileSync(
			path.join(ROOT, "docs/browser-observation-loop.md"),
			"utf8",
		);
		expect(docs).not.toContain("Legacy rollback");
		expect(docs).not.toContain("one-release rollback only");
	});
});
