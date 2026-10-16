/** @jsxImportSource @opentui/solid */
// Settings > Compaction, driven end to end through the headless TUI
// (fix-compaction-trigger-and-settings).
//
// The section's rows, the shell's numeric-editor overlay, the user-scope write
// of `[agents.compaction]` into the temp configuration root and the live
// accessor a durable host reads are one chain, and every link of it is
// exercised here against the real shell. The unit tests around it covered the
// rows and the pure editor rules, which is exactly why a render fault in the
// overlay could hide behind them: activating a threshold row took the whole
// Settings page down.
import { afterEach, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createDefaultOpenTuiKeymap } from "@opentui/keymap/opentui";
import { testRender, useRenderer } from "@opentui/solid";
import { onCleanup } from "solid-js";
import { liveCompactionSection } from "../../src/agent-host/host-main.ts";
import {
	clearBackendClient,
	configureBackendClient,
} from "../../src/server/client.ts";
import { startWorkflowServer } from "../../src/server/lifecycle.ts";
import { TraceDb } from "../../src/server/telemetry-db";
import { clearAgentConfigCache } from "../../src/tui/dash/agent-config-cache.ts";
import { App } from "../../src/tui/otel/app/App.tsx";
import { LogStore } from "../../src/tui/otel/model/logStore.ts";
import { MetricStore } from "../../src/tui/otel/model/metricStore.ts";
import { TopologyStore } from "../../src/tui/otel/model/topologyStore.ts";
import { TraceStore } from "../../src/tui/otel/model/traceStore.ts";
import {
	type CompactionConfig,
	resolveCompactionPolicy,
} from "../../src/workflow/compaction.ts";

const previousRoot = process.env.AGENTIC_CODING_CONFIG_DIR;
const cleanups: Array<() => void> = [];

afterEach(() => {
	for (const cleanup of cleanups.splice(0)) cleanup();
});

/** A fresh configuration root, so the write under test lands in a sandbox. */
function configRoot(): { root: string; configPath: string } {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "compaction-journey-"));
	process.env.AGENTIC_CODING_CONFIG_DIR = root;
	cleanups.push(() => {
		if (previousRoot === undefined)
			delete process.env.AGENTIC_CODING_CONFIG_DIR;
		else process.env.AGENTIC_CODING_CONFIG_DIR = previousRoot;
	});
	clearAgentConfigCache();
	return { root, configPath: path.join(root, "config.json") };
}

function writtenCompaction(configPath: string): CompactionConfig | undefined {
	if (!fs.existsSync(configPath)) return undefined;
	try {
		const document = JSON.parse(fs.readFileSync(configPath, "utf8")) as {
			agents?: { compaction?: CompactionConfig };
		};
		return document.agents?.compaction;
	} catch {
		// A non-atomic write caught mid-truncation: the caller polls.
		return undefined;
	}
}

async function waitForWritten(
	configPath: string,
	predicate: (compaction: CompactionConfig) => boolean,
	attempts = 250,
): Promise<CompactionConfig> {
	for (let i = 0; i < attempts; i++) {
		const compaction = writtenCompaction(configPath);
		if (compaction && predicate(compaction)) return compaction;
		await sleep(20);
	}
	throw new Error(
		`no matching [agents.compaction] in ${configPath}: ${fs.existsSync(configPath) ? fs.readFileSync(configPath, "utf8") : "missing"}`,
	);
}

function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Poll the *complete* frame until it satisfies `predicate`. The renderer's own
 * `waitForFrame` reports the union of the frames it saw, so a positive match is
 * all it is good for; an assertion wants one whole frame. */
async function frameWhere(
	t: Test,
	predicate: (frame: string) => boolean,
	attempts = 120,
): Promise<string> {
	for (let i = 0; i < attempts; i++) {
		await t.renderOnce();
		const frame = t.captureCharFrame();
		if (predicate(frame)) return frame;
		await sleep(25);
	}
	throw new Error(`no frame matched\n${t.captureCharFrame()}`);
}

/** A lone ESC byte is only flushed by the input parser after a short delay. */
async function pressEscape(t: Test) {
	t.mockInput.pressEscape();
	await sleep(90);
}

type Test = Awaited<ReturnType<typeof renderSettings>>;

async function renderSettings() {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "compaction-journey-db-"));
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
				agentView(value, ctx) {
					ctx.require("agent.view", String(value));
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
	cleanups.push(() => {
		t.renderer.destroy();
		db.close();
	});
	return t;
}

/** Jump to a Settings page through the location picker (Ctrl+P). */
async function openSettings(t: Test, destination: string, marker: string) {
	// A background observation failure raises the global error modal, which owns
	// input until it is dismissed.
	await pressEscape(t);
	t.mockInput.pressKey("p", { ctrl: true });
	await t.renderOnce();
	for (const character of destination) {
		t.mockInput.pressKey(character);
		await t.renderOnce();
	}
	t.mockInput.pressEnter();
	await frameWhere(t, (frame) => frame.includes(marker));
}

function rowSelected(frame: string, label: string): boolean {
	return frame
		.split("\n")
		.some((line) => line.includes("│") && line.includes(label));
}

/** Empty the editor's draft: every field's displayed value is five characters. */
function clearDraft(t: Test, times = 5) {
	for (let i = 0; i < times; i++) t.mockInput.pressBackspace();
}

function type(t: Test, text: string) {
	for (const character of text) t.mockInput.pressKey(character);
}

test("the compaction rows open the numeric editor, validate, cancel and save", async () => {
	const { configPath } = configRoot();
	const t = await renderSettings();
	await openSettings(t, "compaction", "Automatic compaction");
	// The host's own live accessor, built before the edit: a saved value has to
	// reach a running host without restarting it (design D4).
	const live = () =>
		resolveCompactionPolicy(liveCompactionSection(configPath)());
	expect(live().reserveTokens).toBe(32000);

	// `j` walks to the Reserve tokens row, and Enter opens the editor on it.
	t.mockInput.pressKey("j");
	const rows = await frameWhere(t, (frame) =>
		rowSelected(frame, "Reserve tokens"),
	);
	// The documented default is visible where the row explains itself: it is
	// window-relative, which is what makes automatic compaction fire on a
	// 1M-token model at all.
	expect(rows).toContain("30% of the run's window");
	t.mockInput.pressEnter();
	// The editor renders at all — the fault that made every threshold row of this
	// section unusable.
	const editor = await frameWhere(t, (frame) =>
		frame.includes("Reserve tokens · compaction"),
	);
	// The draft starts at the value the row showed, not empty.
	expect(editor).toContain("32000█");

	// An entry below the field's floor is refused inline and saves nothing.
	clearDraft(t);
	type(t, "32");
	t.mockInput.pressEnter();
	const refused = await frameWhere(t, (frame) =>
		frame.includes("must be at least 4096"),
	);
	expect(refused).toContain("Reserve tokens · compaction");
	expect(writtenCompaction(configPath)).toBeUndefined();

	// Esc cancels: the editor goes away and the stored configuration is still
	// untouched.
	await pressEscape(t);
	await frameWhere(
		t,
		(frame) => !frame.includes("Reserve tokens · compaction"),
	);
	expect(writtenCompaction(configPath)).toBeUndefined();

	// A valid absolute value is saved, the row shows it and the running host's
	// accessor resolves it.
	t.mockInput.pressEnter();
	await frameWhere(t, (frame) => frame.includes("Reserve tokens · compaction"));
	clearDraft(t);
	type(t, "40000");
	t.mockInput.pressEnter();
	await waitForWritten(configPath, (value) => value.reserveTokens === 40000);
	const saved = await frameWhere(t, (frame) =>
		frame.includes("Reserve tokens — 40000 tokens"),
	);
	expect(saved).not.toContain("40000█");
	expect(live().reserveTokens).toBe(40000);

	// A percentage is stored as written: the host resolves it against each run's
	// window, which this process cannot see.
	t.mockInput.pressKey("j");
	t.mockInput.pressKey("j");
	await frameWhere(t, (frame) => rowSelected(frame, "Kept verbatim"));
	t.mockInput.pressEnter();
	await frameWhere(t, (frame) => frame.includes("Kept verbatim · compaction"));
	clearDraft(t);
	type(t, "15");
	t.mockInput.pressKey("%");
	t.mockInput.pressEnter();
	await waitForWritten(configPath, (value) => value.keepRecentTokens === "15%");
	const percentRow = await frameWhere(t, (frame) =>
		frame.includes("15% → 20000 tokens without a known window"),
	);
	expect(percentRow).toContain("Kept verbatim — 15% → 20000 tokens");
	expect(live().keepRecentTokens).toBe(20000);
});

test("the enabled row toggles through the same server-owned write", async () => {
	const { configPath } = configRoot();
	const t = await renderSettings();
	await openSettings(t, "compaction", "Automatic compaction — on");
	t.mockInput.pressEnter();
	await waitForWritten(configPath, (value) => value.enabled === false);
	const off = await frameWhere(t, (frame) =>
		frame.includes("Automatic compaction — off"),
	);
	expect(off).toContain("from [agents.compaction] (user configuration)");
});

test("a pointer tap selects a compaction row and a second tap opens its editor", async () => {
	const { configPath } = configRoot();
	const t = await renderSettings();
	await openSettings(t, "compaction", "Automatic compaction");
	// The first pointer gesture on a fresh renderer also starts a text
	// selection; consume it on an inert cell before the measured taps.
	await t.mockMouse.click(78, 11);
	await t.renderOnce();
	// Rows are three lines tall and start below the shell chrome: the Reserve
	// tokens row is the second one.
	await t.mockMouse.click(10, 7);
	await frameWhere(t, (frame) => rowSelected(frame, "Reserve tokens"));
	await t.mockMouse.click(10, 7);
	const editor = await frameWhere(t, (frame) =>
		frame.includes("Reserve tokens · compaction"),
	);
	expect(editor).toContain("32000█");
	await pressEscape(t);
	await frameWhere(
		t,
		(frame) => !frame.includes("Reserve tokens · compaction"),
	);
	expect(writtenCompaction(configPath)).toBeUndefined();
});

test("the server-backed settings write lands in the user-scope file and re-reads", async () => {
	const { configPath, root } = configRoot();
	const started = await startWorkflowServer({ port: 0, ownTelemetry: false });
	cleanups.push(() => started.stop());
	const previousUrl = process.env.AGENTIC_WORKFLOW_URL;
	const previousToken = process.env.AGENTIC_WORKFLOW_TOKEN;
	process.env.AGENTIC_WORKFLOW_URL = started.url;
	process.env.AGENTIC_WORKFLOW_TOKEN = started.token;
	cleanups.push(() => {
		if (previousUrl === undefined) delete process.env.AGENTIC_WORKFLOW_URL;
		else process.env.AGENTIC_WORKFLOW_URL = previousUrl;
		if (previousToken === undefined) delete process.env.AGENTIC_WORKFLOW_TOKEN;
		else process.env.AGENTIC_WORKFLOW_TOKEN = previousToken;
	});
	// The shell installs this client when it attaches to a server
	// (`src/tui/index.tsx`); a headless mount has to do it itself.
	configureBackendClient({
		baseUrl: started.url,
		token: started.token,
		ownerId: `compaction-journey-${process.pid}`,
	});
	cleanups.push(() => clearBackendClient());
	clearAgentConfigCache();
	const t = await renderSettings();
	await openSettings(t, "compaction", "Reserve tokens");
	t.mockInput.pressKey("j");
	await frameWhere(t, (frame) => rowSelected(frame, "Reserve tokens"));
	t.mockInput.pressEnter();
	await frameWhere(t, (frame) => frame.includes("Reserve tokens · compaction"));
	clearDraft(t);
	type(t, "60000");
	t.mockInput.pressEnter();
	// The server wrote the user-scope document, and the re-read shows it.
	await waitForWritten(configPath, (value) => value.reserveTokens === 60000);
	const saved = await frameWhere(t, (frame) =>
		frame.includes("Reserve tokens — 60000 tokens"),
	);
	expect(saved).toContain("Reserve tokens — 60000 tokens");
	expect(path.dirname(configPath)).toBe(root);
});
