/** @jsxImportSource @opentui/solid */
import { afterEach, beforeEach, expect, spyOn, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createDefaultOpenTuiKeymap } from "@opentui/keymap/opentui";
import { testRender, useRenderer } from "@opentui/solid";
import { onCleanup } from "solid-js";
import { WikiView } from "../../src/tui/otel/views/WikiView";

// `?` is owned by WikiView: it opens the shell help in the tree/note state but
// must reach the comment editor while a comment is being typed.

const previousWikiRoot = process.env.HERDR_WIKI_DIR;
let wikiRoot: string;

beforeEach(() => {
	wikiRoot = mkdtempSync(join(tmpdir(), "wiki-help-"));
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

function TestWiki(props: { onHelp: () => void }) {
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
	keymap.setData("app.view", "home");
	keymap.setData("modal.active", "none");
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
			onHelp={props.onHelp}
		/>
	);
}

test("`?` opens help in the wiki tree but types into an open comment", async () => {
	writeConcept("demo");
	const marker = { open: () => {} };
	const onHelp = spyOn(marker, "open");
	const t = await testRender(() => <TestWiki onHelp={onHelp} />, {
		width: 120,
		height: 40,
	});
	await t.waitForFrame((frame) => frame.includes("demo.md"));

	// Tree state: `?` asks the shell to open the catalog help.
	t.mockInput.pressKey("?");
	await t.renderOnce();
	expect(onHelp).toHaveBeenCalledTimes(1);

	// Open the note, enter comment mode, then type `?`: the character goes to
	// the comment, not to the help modal.
	t.mockInput.pressEnter();
	await t.waitForFrame((frame) => frame.includes("c Comment"));
	t.mockInput.pressKey("c");
	await t.renderOnce();
	t.mockInput.pressKey("?");
	await t.renderOnce();
	expect(onHelp).toHaveBeenCalledTimes(1);
	expect(t.captureCharFrame()).toContain("?█");
	t.renderer.destroy();
});
