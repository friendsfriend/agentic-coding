/** @jsxImportSource @opentui/solid */
// The OpenCode shell page is exercised separately from the large render shard:
// its embedded terminal owns native OpenTUI state, and the launcher is faked so
// this test never starts the developer's real OpenCode client.
import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createDefaultOpenTuiKeymap } from "@opentui/keymap/opentui";
import { testRender, useRenderer } from "@opentui/solid";
import { dismissErrorModal } from "@ui";
import { onCleanup } from "solid-js";
import { TraceDb } from "../src/server/telemetry-db";
import { setupKeymap } from "../src/tui/dash/keymap-setup.ts";
import { clearGateway } from "../src/tui/data/index.ts";
import { App } from "../src/tui/otel/app/App.tsx";
import type { OpenCodeLauncher } from "../src/tui/otel/app/opencode-process.ts";
import { LogStore } from "../src/tui/otel/model/logStore.ts";
import { MetricStore } from "../src/tui/otel/model/metricStore.ts";
import { TopologyStore } from "../src/tui/otel/model/topologyStore.ts";
import { TraceStore } from "../src/tui/otel/model/traceStore.ts";
import { advance, renderUntil } from "./app/support/terminal.ts";

test("OpenCode owns content keys, shell help stays in the sidebar, and PTY stops on shutdown", async () => {
	const directory = mkdtempSync(join(tmpdir(), "opencode-shell-"));
	const db = new TraceDb(directory);
	let launches = 0;
	const writes: string[] = [];
	const terminalSizes: { cols: number; rows: number }[] = [];
	let stops = 0;
	const launcher: OpenCodeLauncher = ({ cwd, cols, rows, onData }) => {
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
			"select the Orchestrator, OpenCode, or a workflow",
		);
		expect(helpFrame).toContain("Ctrl+H");
		expect(helpFrame).toContain("Ctrl+L");
		expect(helpFrame).not.toContain("Ctrl+T");
		t.mockInput.pressEscape();
		await advance(t, 2, 20);
		t.mockInput.pressKey("s", { ctrl: true });
		await advance(t, 4, 60);
		expect(terminalSizes.at(-1)?.cols).toBe(terminalSize?.cols);
	} finally {
		if (previousTmux !== undefined) process.env.TMUX = previousTmux;
		if (previousUrl !== undefined)
			process.env.AGENTIC_WORKFLOW_URL = previousUrl;
		else delete process.env.AGENTIC_WORKFLOW_URL;
		t.renderer.destroy();
		expect(stops).toBe(1);
		clearGateway();
		dismissErrorModal();
		db.close();
		rmSync(directory, { recursive: true, force: true });
	}
});
