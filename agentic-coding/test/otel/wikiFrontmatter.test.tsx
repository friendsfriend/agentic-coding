/** @jsxImportSource @opentui/solid */
import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createDefaultOpenTuiKeymap } from "@opentui/keymap/opentui";
import { testRender, useRenderer } from "@opentui/solid";
import { createSignal, onCleanup } from "solid-js";
import { setupKeymap } from "../../src/tui/dash/keymap-setup.ts";
import { WikiView } from "../../src/tui/otel/views/WikiView.tsx";
import { advance } from "../app/support/terminal.ts";

// The wiki note page hides frontmatter from the reading view; `F` (shift+f)
// reveals it in its own popup rendered as structured rows. `f` stays the
// review finish key, so the note view keeps both actions.

const previousWikiRoot = process.env.HERDR_WIKI_DIR;
let wikiRoot: string;

beforeEach(() => {
	wikiRoot = mkdtempSync(join(tmpdir(), "wiki-frontmatter-"));
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
		"---\ntype: concept\ntitle: Demo\ndescription: unique-frontmatter-description\nstatus: stable\ntags:\n  - unique-tag-alpha\n  - unique-tag-beta\n---\n\n# Demo\n\nBody text.\n",
	);
}

function TestWiki() {
	// The shell owns the note identity; this host mirrors it with a signal.
	const [noteId, setNoteId] = createSignal<string | undefined>();
	const keymap = createDefaultOpenTuiKeymap(useRenderer());
	// Production keymap setup: its shift resolver maps a shifted letter onto the
	// uppercase binding, so `F` (frontmatter) dispatches exactly as in the shell.
	const dispose = setupKeymap(keymap);
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
			noteId={noteId()}
			onOpenNote={setNoteId}
			onCloseNote={() => setNoteId(undefined)}
		/>
	);
}

test("note page hides frontmatter and `F` shows it in a structured popup", async () => {
	writeConcept("demo");
	const t = await testRender(() => <TestWiki />, { width: 120, height: 40 });
	await t.waitForFrame((frame) => frame.includes("demo.md"));

	// Open the note: the body renders, the frontmatter does not.
	t.mockInput.pressEnter();
	await advance(t, 8);
	const noteFrame = t.captureCharFrame();
	expect(noteFrame).toContain("Body text.");
	expect(noteFrame).not.toContain("unique-frontmatter-description");
	expect(noteFrame).not.toContain("unique-tag-alpha");

	// `F` opens the popup and renders the frontmatter as labelled rows.
	t.mockInput.pressKey("f", { shift: true });
	const popup = await t.waitForFrame((frame) =>
		frame.includes("unique-frontmatter-description"),
	);
	expect(popup).toContain("Frontmatter");
	expect(popup).toContain("Description");
	expect(popup).toContain("Tags");
	expect(popup).toContain("unique-tag-alpha");
	expect(popup).toContain("unique-tag-beta");

	// `F` again closes it and the reading view is back.
	t.mockInput.pressKey("f", { shift: true });
	await t.waitForFrame(
		(frame) => !frame.includes("unique-frontmatter-description"),
	);
	const closed = t.captureCharFrame();
	expect(closed).toContain("Body text.");
	expect(closed).not.toContain("unique-frontmatter-description");
	t.renderer.destroy();
});

test("`F` in the tree state opens no frontmatter popup", async () => {
	writeConcept("demo");
	const t = await testRender(() => <TestWiki />, { width: 120, height: 40 });
	await t.waitForFrame((frame) => frame.includes("demo.md"));

	t.mockInput.pressKey("f", { shift: true });
	await advance(t, 2);
	const frame = t.captureCharFrame();
	expect(frame).toContain("demo.md");
	expect(frame).not.toContain("Frontmatter");
	t.renderer.destroy();
});
