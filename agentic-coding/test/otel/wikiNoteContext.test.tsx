/** @jsxImportSource @opentui/solid */
import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createDefaultOpenTuiKeymap } from "@opentui/keymap/opentui";
import { testRender, useRenderer } from "@opentui/solid";
import { onCleanup } from "solid-js";
import { App } from "../../src/tui/otel/app/App";
import { TraceDb } from "../../src/tui/otel/model/db";
import { LogStore } from "../../src/tui/otel/model/logStore";
import { MetricStore } from "../../src/tui/otel/model/metricStore";
import { TopologyStore } from "../../src/tui/otel/model/topologyStore";
import { TraceStore } from "../../src/tui/otel/model/traceStore";
import {
	activeKeybindCatalog,
	activeKeybindContext,
	footerKeybinds,
} from "../../src/tui/shared/keybinds";

// The shell must publish the wiki "note" footer context while a note is open so
// the note-only actions appear in the footer; in the tree state they stay out.

const previousWikiRoot = process.env.HERDR_WIKI_DIR;
let wikiRoot: string;

beforeEach(() => {
	wikiRoot = mkdtempSync(join(tmpdir(), "wiki-note-context-"));
	process.env.HERDR_WIKI_DIR = wikiRoot;
	writeFileSync(
		join(wikiRoot, "demo.md"),
		"---\ntype: concept\ntitle: Demo\ndescription: demo concept\nstatus: stable\n---\n\n# Demo\n\nBody text.\n",
	);
});

afterEach(() => {
	if (previousWikiRoot === undefined) delete process.env.HERDR_WIKI_DIR;
	else process.env.HERDR_WIKI_DIR = previousWikiRoot;
	rmSync(wikiRoot, { recursive: true, force: true });
});

async function renderHomeApp() {
	const dir = mkdtempSync(join(tmpdir(), "wiki-note-context-db-"));
	const db = new TraceDb(dir);
	const t = await testRender(
		() => {
			const renderer = useRenderer();
			const keymap = createDefaultOpenTuiKeymap(renderer);
			const dispose = keymap.registerLayerFields({
				name() {},
				appView(value, ctx) {
					ctx.require("app.view", String(value));
				},
				activeModal(value, ctx) {
					ctx.require("modal.active", String(value));
				},
				textEntry(value, ctx) {
					ctx.require("textEntry.active", Boolean(value));
				},
			});
			keymap.setData("app.view", "home");
			keymap.setData("modal.active", "none");
			onCleanup(dispose);
			return (
				<App
					repos={["/demo"]}
					db={db}
					traceStore={new TraceStore()}
					metricStore={new MetricStore()}
					logStore={new LogStore()}
					topologyStore={new TopologyStore()}
					dashboard={{ mode: "home", keymap }}
				/>
			);
		},
		{ width: 140, height: 40 },
	);
	await t.renderOnce();
	return { t, db };
}

const footerActions = () =>
	footerKeybinds(activeKeybindCatalog(), activeKeybindContext()).map(
		(kb) => kb.action,
	);

test("wiki note actions appear in the footer only while a note is open", async () => {
	const { t, db } = await renderHomeApp();
	// workflow → wiki (tab 2).
	t.mockInput.pressKey("2");
	await t.waitForFrame((frame) => frame.includes("demo.md"));

	// Tree state: note-only actions stay out of the footer.
	expect(activeKeybindContext()).toBeUndefined();
	expect(footerActions()).not.toContain("visual line selection");
	expect(footerActions()).toContain("help");

	// Open the note: the shell publishes the "note" context.
	t.mockInput.pressEnter();
	await t.waitForFrame((frame) => frame.includes("c Comment"));
	expect(activeKeybindContext()).toBe("note");
	expect(footerActions()).toContain("visual line selection");
	expect(footerActions()).toContain("next/previous note");
	expect(footerActions()).toContain("comment");

	t.renderer.destroy();
	db.close();
});
