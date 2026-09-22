/** @jsxImportSource @opentui/solid */
import { afterEach, beforeEach, expect, test } from "bun:test";
import fs, { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createDefaultOpenTuiKeymap } from "@opentui/keymap/opentui";
import { testRender, useRenderer } from "@opentui/solid";
import { activeKeybindCatalog, resetErrorModal, themeNames } from "@ui";
import { onCleanup } from "solid-js";
import { TraceDb } from "../../src/server/telemetry-db";
import { clearAgentConfigCache } from "../../src/tui/dash/agent-config-cache.ts";
import { App } from "../../src/tui/otel/app/App.tsx";
import { LogStore } from "../../src/tui/otel/model/logStore.ts";
import { MetricStore } from "../../src/tui/otel/model/metricStore.ts";
import { TopologyStore } from "../../src/tui/otel/model/topologyStore.ts";
import { TraceStore } from "../../src/tui/otel/model/traceStore.ts";
import { pressEscapeAndSettle, renderUntil } from "./support/terminal.ts";

// Settings as a Home destination (centralize-application-settings, tasks 1.2,
// 2.1, 2.2, 3.3). Rendered checks: the landing lists every section, a section
// states effective values with their source, the shared profile/preset editor
// opens from Settings without any workflow, and the footer/`?` help describe the
// section surface the user is actually on.

const previousEnv = {
	configDir: process.env.DEVENV_CONFIG_DIR,
	workflowConfig: process.env.HERDR_WORKFLOW_CONFIG,
	wikiRoot: process.env.HERDR_WIKI_DIR,
};
let configDir: string;
let workflowConfig: string;
let wikiRoot: string;

beforeEach(() => {
	// The error-modal signal is module-global; a dialog left open by another
	// file would own input and swallow this suite's keys.
	resetErrorModal();
	clearAgentConfigCache();
	configDir = mkdtempSync(join(tmpdir(), "settings-pages-config-"));
	workflowConfig = join(configDir, "herdr-workflow.toml");
	wikiRoot = mkdtempSync(join(tmpdir(), "settings-pages-wiki-"));
	writeFileSync(
		workflowConfig,
		'[agents]\ndefault_profile = "pi-a"\n\n[agents.profiles.pi-a]\nruntime = "pi"\nmodel = "stub/stub-model"\n',
	);
	writeFileSync(
		join(wikiRoot, "demo.md"),
		"---\ntype: concept\ntitle: Demo\ndescription: demo concept\nstatus: stable\n---\n\n# Demo\n\nBody text.\n",
	);
	process.env.DEVENV_CONFIG_DIR = configDir;
	process.env.HERDR_WORKFLOW_CONFIG = workflowConfig;
	process.env.HERDR_WIKI_DIR = wikiRoot;
});

afterEach(() => {
	for (const [key, value] of [
		["DEVENV_CONFIG_DIR", previousEnv.configDir],
		["HERDR_WORKFLOW_CONFIG", previousEnv.workflowConfig],
		["HERDR_WIKI_DIR", previousEnv.wikiRoot],
	] as const) {
		if (value === undefined) delete process.env[key];
		else process.env[key] = value;
	}
	rmSync(configDir, { recursive: true, force: true });
	rmSync(wikiRoot, { recursive: true, force: true });
});

async function renderHomeShell(width = 140, height = 40) {
	const dir = mkdtempSync(join(tmpdir(), "settings-pages-db-"));
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
					environments={{ serverUrl: "http://127.0.0.1:1" }}
					renderEnvironments={() => <text>ENVIRONMENTS-BODY</text>}
					dashboard={{ mode: "home", keymap }}
				/>
			);
		},
		{ width, height },
	);
	await t.renderOnce();
	await settleBackgroundErrors(t);
	return { t, db };
}

/** Wait for the frame a real async read produces (renderOnce alone never lets
 * timers or a rejected fetch settle). */
async function waitForFrame(
	t: Awaited<ReturnType<typeof testRender>>,
	predicate: (frame: string) => boolean,
	timeoutMs = 400,
): Promise<boolean> {
	const deadline = Date.now() + timeoutMs;
	for (;;) {
		await t.renderOnce();
		if (predicate(t.captureCharFrame())) return true;
		if (Date.now() > deadline) return false;
		await new Promise((resolve) => setTimeout(resolve, 10));
	}
}

/** The shell reads the project catalog in the background; against a server that
 * refuses the connection that read surfaces an error modal which owns input.
 * Dismiss it so the section keys below are the ones under test. */
async function settleBackgroundErrors(
	t: Awaited<ReturnType<typeof testRender>>,
): Promise<void> {
	await waitForFrame(t, (frame) => frame.includes("Observation failed"), 200);
	if (!t.captureCharFrame().includes("Observation failed")) return;
	t.mockInput.pressEscape();
	await new Promise((resolve) => setTimeout(resolve, 80));
	await t.renderOnce();
}

/** Home lists Environments, Observability, Wiki, Settings, New workflow:
 * open Settings from the Home page. */
async function openSettings(
	t: Awaited<ReturnType<typeof renderHomeShell>>["t"],
) {
	await t.waitForFrame((frame) => frame.includes("Home"));
	for (let index = 0; index < 3; index += 1) {
		t.mockInput.pressKey("j");
		await t.renderOnce();
	}
	t.mockInput.pressEnter();
	// The Home row's description also contains "Appearance", so wait for the
	// settings location itself before the caller captures a frame.
	return renderUntil(t, (frame) => frame.includes("Home › Settings"));
}

/** Open one Settings section by its landing-page position. */
async function openSection(
	t: Awaited<ReturnType<typeof renderHomeShell>>["t"],
	index: number,
	expectText: string,
) {
	await openSettings(t);
	for (let step = 0; step < index; step += 1) {
		t.mockInput.pressKey("j");
		await t.renderOnce();
	}
	t.mockInput.pressEnter();
	return renderUntil(t, (frame) => frame.includes(expectText));
}

test("Home exposes Settings and the landing lists every section", async () => {
	const { t, db } = await renderHomeShell();
	const home = await t.waitForFrame((frame) => frame.includes("Home"));
	expect(home).toContain("Settings");
	expect(await openSettings(t)).toBe(true);
	const frame = t.captureCharFrame();
	for (const label of [
		"Appearance",
		"Agent Presets",
		"Providers/credentials",
		"Projects/environments",
		"Backend/telemetry",
	]) {
		expect(frame).toContain(label);
	}
	expect(frame).toContain("Home › Settings");
	t.renderer.destroy();
	db.close();
});

test("the appearance section states the client-local scope and opens the shared picker", async () => {
	const { t, db } = await renderHomeShell();
	expect(await openSection(t, 0, "Appearance")).toBe(true);
	const frame = t.captureCharFrame();
	// One item: the effective theme, described in terms of what it changes. The
	// source/scope inventory lives in the settings inventory, not in the body.
	expect(frame).toContain("Theme");
	expect(frame).toContain("catppuccin");
	expect(frame).toContain("Changes the colorscheme of the application");

	// Enter reuses the shared theme picker; saving there writes the client-local
	// preference file.
	t.mockInput.pressEnter();
	expect(await waitForFrame(t, (value) => value.includes("Theme Picker"))).toBe(
		true,
	);
	t.mockInput.pressEnter();
	expect(
		await waitForFrame(t, () => fs.existsSync(join(configDir, "tui.json"))),
	).toBe(true);
	const saved = JSON.parse(
		fs.readFileSync(join(configDir, "tui.json"), "utf8"),
	) as { theme?: string };
	expect(themeNames).toContain(saved.theme ?? "");
	t.renderer.destroy();
	db.close();
});

test("Agent Presets offers Model profiles and Presets and opens the inline form", async () => {
	const { t, db } = await renderHomeShell();
	expect(await openSection(t, 1, "Model profiles")).toBe(true);
	let frame = t.captureCharFrame();
	expect(frame).toContain("Model profiles");
	expect(frame).toContain("Presets");
	expect(frame).toContain("1 profiles");
	expect(frame).toContain("Agent Presets");

	// Enter opens the selectable profile list.
	t.mockInput.pressEnter();
	expect(await renderUntil(t, (value) => value.includes("pi-a"))).toBe(true);

	// Enter on the entry opens a prefilled inline form, not the old editor modal.
	t.mockInput.pressEnter();
	expect(await renderUntil(t, (value) => value.includes("Profile name"))).toBe(
		true,
	);
	frame = t.captureCharFrame();
	expect(frame).toContain("pi-a");
	expect(frame).not.toContain("Model configuration");
	expect(frame).toContain("Execution environment");
	t.renderer.destroy();
	db.close();
});

test("the Agent Presets catalog survives opening and closing ? help", async () => {
	const { t, db } = await renderHomeShell();
	expect(await openSection(t, 1, "Model profiles")).toBe(true);
	t.mockInput.pressEnter(); // open the profile list
	expect(await renderUntil(t, (value) => value.includes("pi-a"))).toBe(true);
	const actions = () =>
		activeKeybindCatalog().flatMap((section) =>
			section.keybinds.map((keybind) => keybind.action),
		);
	expect(actions()).toContain("add entry");

	// `?` opens the shared help over the section; closing it must not overwrite
	// the Agent Presets catalog with the shell tab catalog.
	t.mockInput.pressKey("?");
	expect(await renderUntil(t, (value) => value.includes("Keybindings"))).toBe(
		true,
	);
	expect(
		await pressEscapeAndSettle(t, (value) => !value.includes("Keybindings")),
	).toBe(true);
	expect(actions()).toContain("add entry");
	expect(actions()).not.toContain("select setting");
	t.renderer.destroy();
	db.close();
});

test("Agent Presets reads the canonical JSON even when a legacy TOML remains", async () => {
	const root = mkdtempSync(join(tmpdir(), "settings-inactive-"));
	const previousEnv = {
		root: process.env.AGENTIC_CODING_CONFIG_DIR,
		workflow: process.env.HERDR_WORKFLOW_CONFIG,
	};
	try {
		writeFileSync(
			join(root, "config.toml"),
			'[agents]\ndefault_profile = "legacy"\n',
		);
		writeFileSync(
			join(root, "config.json"),
			`${JSON.stringify({
				agents: {
					default_profile: "pi-a",
					profiles: { "pi-a": { runtime: "pi", model: "stub/stub-model" } },
				},
			})}\n`,
		);
		process.env.AGENTIC_CODING_CONFIG_DIR = root;
		delete process.env.HERDR_WORKFLOW_CONFIG;

		const { t, db } = await renderHomeShell();
		expect(await openSection(t, 1, "Model profiles")).toBe(true);
		t.mockInput.pressEnter();
		// The canonical JSON is the active source; the leftover TOML is never read.
		expect(await renderUntil(t, (value) => value.includes("pi-a"))).toBe(true);
		t.renderer.destroy();
		db.close();
	} finally {
		if (previousEnv.root === undefined)
			delete process.env.AGENTIC_CODING_CONFIG_DIR;
		else process.env.AGENTIC_CODING_CONFIG_DIR = previousEnv.root;
		if (previousEnv.workflow === undefined)
			delete process.env.HERDR_WORKFLOW_CONFIG;
		else process.env.HERDR_WORKFLOW_CONFIG = previousEnv.workflow;
		rmSync(root, { recursive: true, force: true });
	}
});

test("the backend section reports restart-required read-only overrides", async () => {
	const { t, db } = await renderHomeShell();
	expect(await openSection(t, 4, "Backend endpoint")).toBe(true);
	const frame = t.captureCharFrame();
	expect(frame).toContain("connected server");
	expect(frame).toContain("needs a restart");
	expect(frame).toContain("value not shown");
	expect(frame).toContain("not started");
	t.renderer.destroy();
	db.close();
});

test("an unavailable server is a retryable section error, not a local fallback", async () => {
	const dir = mkdtempSync(join(tmpdir(), "settings-pages-offline-"));
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
					environments={{ serverUrl: "http://127.0.0.1:1" }}
					renderEnvironments={() => <text>ENVIRONMENTS-BODY</text>}
					dashboard={{ mode: "home", keymap }}
				/>
			);
		},
		{ width: 140, height: 40 },
	);
	await t.renderOnce();
	// Providers and projects both read the connected server and must report the
	// failure with a retry instead of writing to this client's configuration.
	expect(await openSection(t, 2, "Providers")).toBe(true);
	// The read is asynchronous: wait for the error state rather than the spinner.
	expect(await waitForFrame(t, (frame) => frame.includes("unavailable"))).toBe(
		true,
	);
	const frame = t.captureCharFrame();
	expect(frame).toContain("Providers unavailable");
	expect(frame).toContain("Retry");
	expect(frame).toContain("no local configuration was written");
	expect(fs.existsSync(join(configDir, "providers"))).toBe(false);
	t.renderer.destroy();
	db.close();
});

test("a narrow terminal keeps the section readable and publishes its catalog", async () => {
	const { t, db } = await renderHomeShell(64, 24);
	expect(await openSection(t, 0, "Appearance")).toBe(true);
	const frame = t.captureCharFrame();
	// The section body stays bounded and readable at a narrow width.
	expect(frame).toContain("Appearance");
	expect(frame).toContain("Theme");
	expect(frame).toContain("catppuccin");
	// The footer advertises the section's special keys, and the catalog the `?`
	// help modal renders is the settings catalog (standard keys included).
	expect(frame).toContain("Ctrl+P");
	expect(frame).toContain("? help");
	const actions = activeKeybindCatalog().flatMap((section) =>
		section.keybinds.map((keybind) => keybind.action),
	);
	expect(actions).toContain("select setting");
	expect(actions).toContain("activate setting");
	expect(actions).toContain("reload server settings");
	expect(actions).toContain("locations");
	t.renderer.destroy();
	db.close();
});

test("the profile list keeps the cursor row in view while scrolling", async () => {
	const profiles = Array.from(
		{ length: 20 },
		(_, i) =>
			`[agents.profiles.p${String(i).padStart(2, "0")}]\nruntime = "pi"\nmodel = "stub/model-${i}"\n`,
	).join("\n");
	writeFileSync(
		workflowConfig,
		`[agents]\ndefault_profile = "p00"\n\n${profiles}`,
	);
	const { t, db } = await renderHomeShell(120, 20);
	expect(await openSection(t, 1, "Model profiles")).toBe(true);
	t.mockInput.pressEnter();
	expect(await renderUntil(t, (frame) => frame.includes("p00"))).toBe(true);

	// Every step keeps the row the cursor is on inside the window.
	for (let step = 0; step < 14; step += 1) {
		t.mockInput.pressKey("j");
		await t.renderOnce();
		const name = `p${String(step + 1).padStart(2, "0")}`;
		expect(t.captureCharFrame()).toContain(name);
	}

	// Coming back lands on the first row again, not a drifted window.
	for (let step = 0; step < 14; step += 1) {
		t.mockInput.pressKey("k");
		await t.renderOnce();
	}
	expect(t.captureCharFrame()).toContain("p00");
	t.renderer.destroy();
	db.close();
});
