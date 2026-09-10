/** @jsxImportSource @opentui/solid */
import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createDefaultOpenTuiKeymap } from "@opentui/keymap/opentui";
import { testRender, useRenderer } from "@opentui/solid";
import { onCleanup } from "solid-js";
import { WikiView } from "../../src/tui/otel/views/WikiView";

/** The wiki tab used to print its own keybind cheat sheet in the content area
 * ("Wiki · Enter open/expand · c comment · f finish · r refresh") and repeat
 * single hints ("Press r to refresh/retry") in its empty/error states. The
 * standard footer (`otel/components/StatusBar.tsx`) is the single keybind-help
 * surface, so the tab body must stay free of keybinding text. */

const previousWikiRoot = process.env.HERDR_WIKI_DIR;
let wikiRoot: string;

beforeEach(() => {
	wikiRoot = mkdtempSync(join(tmpdir(), "wiki-view-keybinds-"));
	process.env.HERDR_WIKI_DIR = wikiRoot;
});

afterEach(() => {
	if (previousWikiRoot === undefined) delete process.env.HERDR_WIKI_DIR;
	else process.env.HERDR_WIKI_DIR = previousWikiRoot;
	rmSync(wikiRoot, { recursive: true, force: true });
});

function writeConcept(id: string): void {
	writeFileSync(
		join(wikiRoot, `${id}.md`),
		"---\ntype: concept\ntitle: Demo\ndescription: demo concept\nstatus: stable\n---\n\n# Demo\n\nBody text.\n",
	);
}

function TestWiki() {
	const keymap = createDefaultOpenTuiKeymap(useRenderer());
	const dispose = keymap.registerLayerFields({
		name() {},
		appView(value, ctx) {
			ctx.require("app.view", String(value));
		},
		activeModal(value, ctx) {
			ctx.require("modal.active", String(value));
		},
	});
	onCleanup(dispose);
	return (
		<WikiView
			keymap={keymap}
			comments={[]}
			onAddComment={() => {}}
			onFinish={async () => ""}
			submitting={false}
			onSubmittingChange={() => {}}
			onClearComments={() => {}}
		/>
	);
}

test("wiki tab content does not embed a keybind cheat sheet", async () => {
	writeConcept("demo");
	const t = await testRender(() => <TestWiki />, { width: 120, height: 40 });
	await t.flush();
	const frame = t.captureCharFrame();
	expect(frame).toContain("demo.md");
	expect(frame).not.toContain("open/expand");
	expect(frame).not.toContain("Wiki ·");
	expect(frame).not.toContain("c comment");
	t.renderer.destroy();
});

test("empty wiki state keeps keybind hints out of the content", async () => {
	const t = await testRender(() => <TestWiki />, { width: 120, height: 40 });
	await t.flush();
	const frame = t.captureCharFrame();
	expect(frame).toContain("No readable wiki concepts found.");
	expect(frame).not.toContain("Press r to refresh");
	t.renderer.destroy();
});
