/** @jsxImportSource @opentui/solid */
// The embedded agent pages are exercised separately from the large render
// shard: their terminals own native OpenTUI state, and the launchers are faked
// so this test never starts the developer's real OpenCode or Pi clients.
import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RGBA } from "@opentui/core";
import { createDefaultOpenTuiKeymap } from "@opentui/keymap/opentui";
import { testRender, useRenderer } from "@opentui/solid";
import { dismissErrorModal, uiColors } from "@ui";
import { onCleanup } from "solid-js";
import { TraceDb } from "../src/server/telemetry-db";
import { setupKeymap } from "../src/tui/dash/keymap-setup.ts";
import { clearGateway } from "../src/tui/data/index.ts";
import { App } from "../src/tui/otel/app/App.tsx";
import type { TerminalAgentLauncher } from "../src/tui/otel/app/terminal-agent-process.ts";
import { LogStore } from "../src/tui/otel/model/logStore.ts";
import { MetricStore } from "../src/tui/otel/model/metricStore.ts";
import { TopologyStore } from "../src/tui/otel/model/topologyStore.ts";
import { TraceStore } from "../src/tui/otel/model/traceStore.ts";
import { advance, renderUntil } from "./app/support/terminal.ts";

test("embedded agents own content keys, stay mounted, and stop on shutdown", async () => {
	const directory = mkdtempSync(join(tmpdir(), "opencode-shell-"));
	const db = new TraceDb(directory);
	let launches = 0;
	const writes: string[] = [];
	const terminalSizes: { cols: number; rows: number }[] = [];
	let stops = 0;
	const launcher: TerminalAgentLauncher = ({ cwd, cols, rows, onData }) => {
		expect(cwd).toBe(process.cwd());
		terminalSizes.push({ cols, rows });
		launches += 1;
		onData(new TextEncoder().encode("OpenCode-test-terminal\r\n"));
		return {
			pid: undefined,
			write: (data) => {
				writes.push(new TextDecoder().decode(data));
			},
			resize: (cols, rows) => {
				terminalSizes.push({ cols, rows });
			},
			stop: () => {
				stops += 1;
			},
		};
	};
	let piLaunches = 0;
	const piWrites: string[] = [];
	const piSizes: { cols: number; rows: number }[] = [];
	let piStops = 0;
	const piLauncher: TerminalAgentLauncher = ({ cwd, cols, rows, onData }) => {
		expect(cwd).toBe(process.cwd());
		piSizes.push({ cols, rows });
		piLaunches += 1;
		onData(new TextEncoder().encode("Pi-test-terminal\r\n"));
		return {
			pid: undefined,
			write: (data) => {
				piWrites.push(new TextDecoder().decode(data));
			},
			resize: (cols, rows) => {
				piSizes.push({ cols, rows });
			},
			stop: () => {
				piStops += 1;
			},
		};
	};
	const previousTmux = process.env.TMUX;
	const previousUrl = process.env.AGENTIC_WORKFLOW_URL;
	delete process.env.TMUX;
	delete process.env.AGENTIC_WORKFLOW_URL;
	clearGateway();
	const t = await testRender(
		() => {
			const renderer = useRenderer();
			const keymap = createDefaultOpenTuiKeymap(renderer);
			const disposeKeymap = setupKeymap(keymap);
			keymap.setData("modal.active", "none");
			onCleanup(disposeKeymap);
			return (
				<App
					repos={["/demo"]}
					db={db}
					traceStore={new TraceStore()}
					metricStore={new MetricStore()}
					logStore={new LogStore()}
					topologyStore={new TopologyStore()}
					dashboard={{ mode: "home", keymap }}
					openCodeLauncher={launcher}
					piLauncher={piLauncher}
				/>
			);
		},
		{ width: 140, height: 40 },
	);
	try {
		await t.renderOnce();
		expect(launches).toBe(0);
		t.mockInput.pressKey("s", { ctrl: true });
		await advance(t, 4, 60);
		expect(await renderUntil(t, "OpenCode")).toBe(true);
		t.mockInput.pressKey("j");
		await t.renderOnce();
		t.mockInput.pressEnter();
		expect(await renderUntil(t, "OpenCode-test-terminal")).toBe(true);
		expect(launches).toBe(1);
		await advance(t, 4, 60);
		const terminalSize = terminalSizes.at(-1);
		expect(terminalSize?.cols).toBeGreaterThan(100);
		expect(terminalSize?.rows).toBeGreaterThanOrEqual(35);

		const contentFrame = t.captureCharFrame();
		expect(contentFrame).toContain("opencode");
		expect(contentFrame).toContain("Ctrl+S");
		expect(contentFrame).toContain("? help");
		expect(contentFrame).not.toContain("Ctrl+H");
		expect(contentFrame).not.toContain("Ctrl+T");

		// Ctrl+T reaches the embedded terminal, but never spawns another shell.
		// Install the attach URL only for this keypress so the Home monitor does
		// not start an unrelated HTTP subscription during the UI test.
		process.env.AGENTIC_WORKFLOW_URL = "http://127.0.0.1:4050";
		writes.length = 0;
		t.mockInput.pressKey("t", { ctrl: true });
		await advance(t, 2, 20);
		expect(launches).toBe(1);
		expect(t.captureCharFrame()).not.toContain("tmux is not available");
		expect(writes.join("")).toContain("\u0014");
		writes.length = 0;
		t.mockInput.pressKey("?");
		t.mockInput.pressKey("x");
		await advance(t, 2, 20);
		expect(writes.join("")).toContain("?x");
		expect(t.captureCharFrame()).not.toContain("Keybindings");
		if (previousUrl !== undefined)
			process.env.AGENTIC_WORKFLOW_URL = previousUrl;
		else delete process.env.AGENTIC_WORKFLOW_URL;

		// Ctrl+S moves shell focus to the sidebar without stopping the PTY. The
		// sidebar owns `?`, so its catalog is available while OpenCode is blurred.
		writes.length = 0;
		t.mockInput.pressKey("s", { ctrl: true });
		await advance(t, 4, 60);
		if (!(await renderUntil(t, "Workspaces")))
			throw new Error(`Sidebar did not take focus:\n${t.captureCharFrame()}`);
		expect(
			await renderUntil(
				t,
				(frame) => frame.includes("Ctrl+S") && !frame.includes("Ctrl+T"),
			),
		).toBe(true);
		expect(stops).toBe(0);
		expect(writes.join("")).not.toContain("\u0013");
		const expandedSize = terminalSizes.at(-1);
		expect(expandedSize?.cols).toBeLessThan(terminalSize?.cols ?? 0);
		const sidebarFrame = t.captureCharFrame();
		expect(sidebarFrame).toContain("Ctrl+S");
		expect(sidebarFrame).not.toContain("Ctrl+T");
		t.mockInput.pressKey("?");
		await advance(t, 2, 20);
		expect(await renderUntil(t, "Keybindings")).toBe(true);
		const helpFrame = t.captureCharFrame();
		expect(helpFrame).toContain(
			"select the Orchestrator, OpenCode, Pi, or a workflow",
		);
		expect(helpFrame).toContain("Ctrl+H");
		expect(helpFrame).toContain("Ctrl+L");
		expect(helpFrame).not.toContain("Ctrl+T");
		t.mockInput.pressEscape();
		await advance(t, 2, 20);
		t.mockInput.pressKey("s", { ctrl: true });
		await advance(t, 4, 60);
		expect(terminalSizes.at(-1)?.cols).toBe(terminalSize?.cols);
		expect(piLaunches).toBe(0);

		// Sidebar from OpenCode reveals its pin, so one step down selects Pi.
		// Pi starts lazily on its first visit and keeps its own client.
		t.mockInput.pressKey("s", { ctrl: true });
		await advance(t, 4, 60);
		t.mockInput.pressKey("j");
		await advance(t);
		t.mockInput.pressEnter();
		expect(await renderUntil(t, "Pi-test-terminal")).toBe(true);
		expect(piLaunches).toBe(1);
		await advance(t, 4, 60);
		const piSize = piSizes.at(-1);
		expect(piSize?.cols).toBeGreaterThan(100);
		expect(piSize?.rows).toBeGreaterThanOrEqual(35);

		const piFrame = t.captureCharFrame();
		expect(piFrame).toContain("Pi");
		expect(piFrame).toContain("Ctrl+S");
		// Pi has no `?` help key, so the footer does not claim one.
		expect(piFrame).not.toContain("? help");
		expect(piFrame).not.toContain("Ctrl+T");

		// The agent TUI paints no default background of its own, so its cells
		// must use the shell theme rather than the terminal emulator's black.
		const piTerminalBackground = t
			.captureSpans()
			.lines.flatMap((line) => line.spans)
			.find((span) => span.text.includes("Pi-test-terminal"))?.bg;
		expect(piTerminalBackground?.equals(RGBA.fromHex(uiColors.bgBase))).toBe(
			true,
		);

		// Pi owns content keys just like OpenCode: Ctrl+T and ordinary text go
		// to the PTY, and `?` does not open shell help while content has focus.
		piWrites.length = 0;
		t.mockInput.pressKey("t", { ctrl: true });
		t.mockInput.pressKey("?");
		t.mockInput.pressKey("x");
		await advance(t, 2, 20);
		expect(piWrites.join("")).toContain("\u0014");
		expect(piWrites.join("")).toContain("?x");
		expect(t.captureCharFrame()).not.toContain("Keybindings");
		expect(piLaunches).toBe(1);

		// Returning to OpenCode does not start a second client, and the first
		// client stayed alive while Pi held the page.
		t.mockInput.pressKey("s", { ctrl: true });
		await advance(t, 4, 60);
		expect(piStops).toBe(0);
		expect(stops).toBe(0);
		expect(piSizes.at(-1)?.cols).toBeLessThan(piSize?.cols ?? 0);
		t.mockInput.pressKey("k");
		await advance(t);
		t.mockInput.pressEnter();
		expect(await renderUntil(t, "OpenCode-test-terminal")).toBe(true);
		expect(launches).toBe(1);
		expect(piLaunches).toBe(1);
	} finally {
		if (previousTmux !== undefined) process.env.TMUX = previousTmux;
		if (previousUrl !== undefined)
			process.env.AGENTIC_WORKFLOW_URL = previousUrl;
		else delete process.env.AGENTIC_WORKFLOW_URL;
		t.renderer.destroy();
		expect(stops).toBe(1);
		expect(piStops).toBe(1);
		clearGateway();
		dismissErrorModal();
		db.close();
		rmSync(directory, { recursive: true, force: true });
	}
});
