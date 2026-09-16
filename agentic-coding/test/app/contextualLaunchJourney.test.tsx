/** @jsxImportSource @opentui/solid */
// Full launch journeys in the unified shell
// (launch-workflows-from-project-and-wiki-pages, tasks 3.1–3.4): Home has no
// Workflows destination, an application/library page offers the contextual
// start, Wiki offers the repository-independent start, and cancelling starts
// nothing.
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
import { pressEscapeAndSettle } from "./support/terminal";

/** Footer labels of the surface that currently owns input. */
const footerActions = () =>
	footerKeybinds(activeKeybindCatalog(), activeKeybindContext()).map(
		(keybind) => keybind.action,
	);

// The Wiki body reads a wiki root; give it a readable concept so it never opens
// the global error modal, which would own input.
const previousWikiRoot = process.env.HERDR_WIKI_DIR;
let wikiRoot: string;

beforeEach(() => {
	wikiRoot = mkdtempSync(join(tmpdir(), "launch-journey-wiki-"));
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

/** The contextual start the environment resource page reports upward. */
type EnvironmentStart = (project: {
	ident: string;
	name: string;
	repository: string;
}) => void;

let startFromResourcePage: EnvironmentStart | undefined;

async function renderHomeShell() {
	const dir = mkdtempSync(join(tmpdir(), "launch-journey-db-"));
	const db = new TraceDb(dir);
	const t = await testRender(
		() => {
			const renderer = useRenderer();
			const keymap = createDefaultOpenTuiKeymap(renderer);
			const dispose = keymap.registerLayerFields({
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
					environments={{ serverUrl: "http://127.0.0.1:4050" }}
					renderEnvironments={(
						_onCatalog,
						_active,
						_onModalChange,
						_destination,
						onStartWorkflow: EnvironmentStart,
					) => {
						startFromResourcePage = onStartWorkflow;
						return <text>ENV-BODY</text>;
					}}
					dashboard={{ mode: "home", keymap }}
				/>
			);
		},
		{ width: 140, height: 40 },
	);
	await t.renderOnce();
	return { t, db };
}

test("Wiki starts repository-independent work and cancelling starts nothing", async () => {
	const { t, db } = await renderHomeShell();
	await t.waitForFrame((value) => value.includes("Settings"));
	// Home order is Environments, Observability, Wiki, Settings.
	t.mockInput.pressKey("j");
	t.mockInput.pressKey("j");
	t.mockInput.pressEnter();
	await t.waitForFrame((value) => value.includes("demo.md"));
	t.mockInput.pressKey("w");
	const form = await t.waitForFrame((value) => value.includes("Independent ("));
	expect(form).toContain("Research");
	expect(form).not.toContain("Openspec");
	expect(form).not.toContain("Custom path");
	// While the form owns input, the footer describes the form itself and the
	// shell routes keys into the form (Enter advances the wizard step).
	expect(footerActions()).toContain("Select / create");
	t.mockInput.pressEnter();
	await t.flush();
	await t.renderOnce();
	// The shell routes the key into the mounted form, which advanced one step.
	expect(t.captureCharFrame()).toContain("Agent preset");
	expect(t.captureCharFrame()).toContain("Config defaults");

	// Escaping the form returns to Wiki; the origin page never changes.
	await pressEscapeAndSettle(t, (value) => !value.includes("Independent ("));
	const back = t.captureCharFrame();
	expect(back).toContain("Home › Wiki");
	expect(back).toContain("demo.md");
	t.renderer.destroy();
	db.close();
});

test("Home never offers a workflow list, history or reopen destination", async () => {
	const { t, db } = await renderHomeShell();
	const frame = await t.waitForFrame((value) => value.includes("Settings"));
	expect(frame).toContain("Environments");
	expect(frame).toContain("Observability");
	expect(frame).toContain("Wiki");
	expect(frame).not.toContain("Workflows");
	expect(frame).not.toContain("workspace");

	// The one location picker does not offer one either.
	t.mockInput.pressKey("p", { ctrl: true });
	for (const character of "workfl") {
		t.mockInput.pressKey(character);
		await t.renderOnce();
	}
	const picker = t.captureCharFrame();
	expect(picker).not.toContain("Workflows");
	t.renderer.destroy();
	db.close();
});

test("an application page starts a workflow for its own project identity", async () => {
	const { t, db } = await renderHomeShell();
	await t.waitForFrame((value) => value.includes("Settings"));
	t.mockInput.pressEnter(); // Environments
	await t.waitForFrame((value) => value.includes("Applications"));
	t.mockInput.pressEnter(); // Applications category page
	await t.waitForFrame((value) => value.includes("Home › Environments"));

	startFromResourcePage?.({
		ident: "checkout",
		name: "Checkout",
		repository: "/managed/checkout",
	});
	await t.flush();
	await t.renderOnce();
	const form = t.captureCharFrame();
	// The page's project is the target; no repository picker is offered.
	expect(form).toContain("Checkout");
	expect(form).not.toContain("Custom path");
	expect(form).not.toContain("Standalone research");
	expect(form).not.toContain("Current directory");
	// The full application keeps the originating page behind the form.
	expect(form).toContain("Home › Environments");

	await pressEscapeAndSettle(t, (value) => !value.includes("Custom path"));
	t.renderer.destroy();
	db.close();
});
