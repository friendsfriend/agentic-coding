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
import {
	activeErrorModal,
	activeKeybindCatalog,
	activeKeybindContext,
	dismissErrorModal,
	footerKeybinds,
	resetErrorModal,
} from "@ui";
import { onCleanup } from "solid-js";
import {
	clearBackendClient,
	configureBackendClient,
} from "../../src/server/client.ts";
import { TraceDb } from "../../src/server/telemetry-db";
import { clearGateway, configureGateway } from "../../src/tui/data/index.ts";
import { App } from "../../src/tui/otel/app/App.tsx";
import { LogStore } from "../../src/tui/otel/model/logStore.ts";
import { MetricStore } from "../../src/tui/otel/model/metricStore.ts";
import { TopologyStore } from "../../src/tui/otel/model/topologyStore.ts";
import { TraceStore } from "../../src/tui/otel/model/traceStore.ts";
import { pressEscapeAndSettle } from "./support/terminal.ts";

/** Footer labels of the surface that currently owns input. */
const footerActions = () =>
	footerKeybinds(activeKeybindCatalog(), activeKeybindContext()).map(
		(keybind) => keybind.action,
	);

// The Wiki body reads a wiki root; give it a readable concept so it never opens
// the global error modal, which would own input.
const previousWikiRoot = process.env.HERDR_WIKI_DIR;
const originalFetch = globalThis.fetch;
let wikiRoot: string;

beforeEach(() => {
	clearBackendClient();
	clearGateway();
	resetErrorModal();
	globalThis.fetch = originalFetch;
	wikiRoot = mkdtempSync(join(tmpdir(), "launch-journey-wiki-"));
	process.env.HERDR_WIKI_DIR = wikiRoot;
	writeFileSync(
		join(wikiRoot, "demo.md"),
		"---\ntype: concept\ntitle: Demo\ndescription: demo concept\nstatus: stable\n---\n\n# Demo\n\nBody text.\n",
	);
});

afterEach(() => {
	clearBackendClient();
	// a gateway installed by one test must not leak into the next file
	clearGateway();
	resetErrorModal();
	globalThis.fetch = originalFetch;
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

async function renderHomeShell(width = 140) {
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
		{ width, height: 40 },
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

test("failed starts open blocking errors and keep the completed form retryable", async () => {
	const { t, db } = await renderHomeShell();
	await t.waitForFrame((value) => value.includes("Settings"));
	t.mockInput.pressKey("j");
	t.mockInput.pressKey("j");
	t.mockInput.pressEnter();
	await t.waitForFrame((value) => value.includes("demo.md"));
	t.mockInput.pressKey("w");
	await t.waitForFrame((value) => value.includes("Independent ("));

	t.mockInput.pressEnter(); // research
	await t.renderOnce();
	t.mockInput.pressEnter(); // config defaults
	await t.renderOnce();
	t.mockInput.pressEnter(); // optional ticket
	await t.renderOnce();
	for (const character of "retryable-start") t.mockInput.pressKey(character);
	t.mockInput.pressEnter();
	await t.renderOnce();
	for (const character of "Check launch failure")
		t.mockInput.pressKey(character);
	t.mockInput.pressEnter({ meta: true });
	await t.waitForFrame((value) => value.includes("Confirm workflow"));

	let starts = 0;
	configureGateway(
		configureBackendClient({
			baseUrl: "http://127.0.0.1:1",
			token: "test",
			ownerId: "test",
		}),
	);
	globalThis.fetch = (async (request) => {
		if (!String(request).includes("/api/v1/workflow/start"))
			return new Response(null, { status: 200 });
		starts++;
		const rejected = starts === 1;
		return Response.json(
			{
				ok: false,
				error: {
					code: rejected ? "invalid-profile" : "internal",
					message: rejected
						? "selected model is gone"
						: "backend stopped responding",
				},
			},
			{ status: rejected ? 400 : 500 },
		);
	}) as typeof fetch;

	t.mockInput.pressEnter();
	await Bun.sleep(20);
	const failed = await t.waitForFrame((value) =>
		value.includes("selected model is gone"),
	);
	expect(failed).toContain("Workflow start failed");
	expect(activeErrorModal()?.message).toBe("selected model is gone");
	expect(starts).toBe(1);

	dismissErrorModal();
	await t.flush();
	const retry = await t.waitForFrame(
		(value) =>
			value.includes("Confirm workflow") &&
			!value.includes("selected model is gone"),
	);
	expect(retry).toContain("retryable-start");

	t.mockInput.pressEnter();
	await Bun.sleep(20);
	const uncertain = await t.waitForFrame((value) =>
		value.includes("backend stopped responding"),
	);
	expect(uncertain).toContain("Workflow start outcome unknown");
	expect(starts).toBe(2);

	dismissErrorModal();
	await t.flush();
	const stillOpen = await t.waitForFrame(
		(value) =>
			value.includes("Confirm workflow") &&
			!value.includes("backend stopped responding"),
	);
	expect(stillOpen).toContain("retryable-start");

	t.renderer.destroy();
	db.close();
});

test("Home offers the workflow action but never a workflow list, history or reopen destination", async () => {
	const { t, db } = await renderHomeShell();
	const frame = await t.waitForFrame((value) => value.includes("Settings"));
	expect(frame).toContain("Environments");
	expect(frame).toContain("Observability");
	expect(frame).toContain("Wiki");
	// The one top-level launch entry: starting new work, not browsing existing
	// workflows.
	expect(frame).toContain("New workflow");
	expect(frame).toContain(
		"Start a workflow in the working directory or a path you enter",
	);
	expect(frame).not.toContain("Workflows");
	expect(frame).not.toContain("workspace");

	// The one location picker offers pages only, never the action entry.
	t.mockInput.pressKey("p", { ctrl: true });
	for (const character of "workfl") {
		t.mockInput.pressKey(character);
		await t.renderOnce();
	}
	const picker = t.captureCharFrame();
	// The picker's own results list jumps to pages; the action entry behind it
	// stays a Home row, never a picker destination.
	expect(picker).toContain("/workfl (1 results)");
	expect(picker).not.toContain("Workflows");
	t.renderer.destroy();
	db.close();
});

test("Home starts a workflow in the working directory or a path the user enters", async () => {
	// A checkout path can be longer than the default 140-column frame, which
	// wraps the prefilled repository path across lines. Render this journey wide
	// enough that the absolute working directory is visible contiguously, so the
	// assertion does not depend on the checkout's length.
	const { t, db } = await renderHomeShell(240);
	await t.waitForFrame((value) => value.includes("Settings"));
	// Home order is Environments, Observability, Wiki, Settings, New workflow.
	for (let index = 0; index < 4; index += 1) {
		t.mockInput.pressKey("j");
		await t.renderOnce();
	}
	t.mockInput.pressEnter();
	const form = await t.waitForFrame((value) =>
		value.includes("Repository path"),
	);
	// The working directory is the prefill; the field is editable, so another
	// path is one step away without a second target selector. The opening Enter
	// must not submit the prefilled step, so the form is still on it.
	expect(form).toContain("Repository");
	expect(form).toContain(process.cwd());
	expect(form).not.toContain("Openspec apply");
	// Accepting the prefilled working directory opens the workflow-type list.
	t.mockInput.pressEnter();
	const types = await t.waitForFrame((value) =>
		value.includes("Openspec apply"),
	);
	expect(types).toMatch(/Workflow type\s+openspec-full/);
	// Selecting a type opens the preset list. The editor that owned the
	// repository path is removed from the tree here, and OpenTUI blurs only on
	// destroy: without an explicit blur it kept receiving keys and wrote its path
	// into the field the form was showing (the preset), so it must stay bound to
	// its own field and release the keyboard.
	t.mockInput.pressEnter();
	const presets = await t.waitForFrame((value) =>
		value.includes("Config defaults"),
	);
	expect(presets).toContain("Agent preset");
	expect(presets).toMatch(/Workflow type\s+openspec-full/);
	expect(presets).not.toMatch(/Agent preset\s+\/home\//);
	// The preset is a real choice: selecting one records it, never the path.
	t.mockInput.pressEnter();
	await t.flush();
	await t.renderOnce();
	const selected = t.captureCharFrame();
	expect(selected).toMatch(/Agent preset\s+Config/);
	expect(selected).not.toMatch(/Agent preset\s+\/home\//);
	// The form steps back to the page it was opened from.
	await pressEscapeAndSettle(t, (value) => value.includes("New workflow"));
	expect(t.captureCharFrame()).toContain("Home");
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
