/** @jsxImportSource @opentui/solid */
import { expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createDefaultOpenTuiKeymap } from "@opentui/keymap/opentui";
import { KeymapProvider } from "@opentui/keymap/solid";
import { testRender, useRenderer } from "@opentui/solid";
import { onCleanup } from "solid-js";
import { AppShell } from "../../src/tui/app/AppShell";
import { setupKeymap } from "../../src/tui/dash/keymap-setup";
import { TraceDb } from "../../src/tui/otel/model/db";
import { LogStore } from "../../src/tui/otel/model/logStore";
import { MetricStore } from "../../src/tui/otel/model/metricStore";
import { TopologyStore } from "../../src/tui/otel/model/topologyStore";
import { TraceStore } from "../../src/tui/otel/model/traceStore";

// TQ-005/TQ-101: the composition root must actually mount the embedded
// environment feature (shared renderer/keymap, no devenv header/footer), and
// the embedded keymap registration must not throw. The environment body has
// unique content (its sub-tab row and startup splash) that the shell's own
// feature row cannot produce.
test("AppShell mounts the embedded Environments feature without keymap errors", async () => {
	const dir = mkdtempSync(join(tmpdir(), "app-shell-mount-"));
	const db = new TraceDb(dir);
	const diagnostics: string[] = [];
	const originalError = console.error;
	const originalWarn = console.warn;
	const capture = (...args: unknown[]) => {
		const message = args.map((arg) => String(arg)).join(" ");
		if (message.includes("[Keymap]")) diagnostics.push(message);
	};
	console.error = (...args: unknown[]) => {
		capture(...args);
		originalError(...args);
	};
	console.warn = (...args: unknown[]) => {
		capture(...args);
		originalWarn(...args);
	};
	try {
		const t = await testRender(
			() => {
				const renderer = useRenderer();
				const keymap = createDefaultOpenTuiKeymap(renderer);
				const dispose = setupKeymap(keymap);
				onCleanup(dispose);
				return (
					<KeymapProvider keymap={keymap}>
						<AppShell
							repos={["/demo"]}
							db={db}
							traceStore={new TraceStore()}
							metricStore={new MetricStore()}
							logStore={new LogStore()}
							topologyStore={new TopologyStore()}
							environments={{ serverUrl: "http://127.0.0.1:1" }}
						/>
					</KeymapProvider>
				);
			},
			{ width: 120, height: 40 },
		);
		// Wait for the embedded environment body (its own sub-tab row), which the
		// shell feature row cannot produce.
		const frame = await t.waitForFrame((value) =>
			value.includes("Infrastructure (0)"),
		);
		expect(frame).toContain("Observability");
		// The embedded app projected its live command registrations into the shell
		// footer (task 3.6).
		expect(frame).toContain("T Theme");
		t.renderer.destroy();
	} finally {
		console.error = originalError;
		console.warn = originalWarn;
		db.close();
	}
	expect(diagnostics).toEqual([]);
});
