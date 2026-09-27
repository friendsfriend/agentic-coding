// Focused live Luvus check (add-multiplexer-adapters, task 6.3, plus verifier
// fixes TQV-001/TQV-002): provisions its own disposable named session against
// the installed binary, launches and prompts one real agent, and asserts a
// bounded real event signal. When the `luvus` binary is unavailable the runner
// reports an explicit skip instead of a silent pass; the `default` session is
// never touched.
import { afterAll, describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Effect, Exit, Scope } from "effect";
import { LuvusMultiplexer } from "../src/multiplexer/luvus/index.ts";
import { resolveLuvusSocketPath } from "../src/multiplexer/luvus/uhp.ts";
import type { MultiplexerPort } from "../src/multiplexer/port.ts";

const binary = Bun.which("luvus");
const session = `agentic-coding-mux-test-${process.pid.toString(36)}`;
const socketPath = binary
	? (() => {
			const start = Bun.spawnSync(
				[binary, "--session", session, "server", "start"],
				{ stdout: "pipe", stderr: "pipe" },
			);
			if (start.exitCode !== 0) return undefined;
			const resolved = resolveLuvusSocketPath({
				LUVUS_HOME: process.env.LUVUS_HOME,
				LUVUS_SESSION: session,
			});
			if (!resolved) return undefined;
			const deadline = Date.now() + 15_000;
			while (Date.now() < deadline && !fs.existsSync(resolved))
				Bun.sleepSync(100);
			return fs.existsSync(resolved) ? resolved : undefined;
		})()
	: undefined;

afterAll(() => {
	if (!binary) return;
	Bun.spawnSync([binary, "session", "stop", session], {
		stdout: "pipe",
		stderr: "pipe",
	});
	Bun.spawnSync([binary, "session", "delete", session], {
		stdout: "pipe",
		stderr: "pipe",
	});
});

function livePort(): MultiplexerPort {
	if (!socketPath) throw new Error("live Luvus session is unavailable");
	return new LuvusMultiplexer({ socketPath, session });
}

describe("live Luvus adapter", () => {
	test.skipIf(!socketPath)(
		"launches and prompts a real agent in a disposable session",
		async () => {
			const repo = fs.mkdtempSync(path.join(os.tmpdir(), "luvus-live-"));
			try {
				const port = livePort();
				const workspace = await Effect.runPromise(
					port.workspaceCreate({
						cwd: repo,
						label: `probe-${Date.now().toString(36)}`,
					}),
				);
				const tabs = await Effect.runPromise(
					port.tabList(workspace.workspaceId),
				);
				const tab = tabs[0];
				if (!tab) throw new Error("no tab after workspace open");
				const panes = await Effect.runPromise(
					port.paneList({ workspaceId: workspace.workspaceId }),
				);
				const pane = panes.find((item) => item.tabId === tab.tabId);
				if (!pane) throw new Error("no pane after workspace open");
				const name = `luprobe${Date.now().toString(36)}`;
				const started = await Effect.runPromise(
					port.agentStart({
						kind: "pi",
						name,
						paneId: pane.paneId,
						cwd: repo,
						runId: "live-probe",
						runtimeArgs: ["--no-approve"],
						environment: { LUVUS_LIVE_PROBE: "1" },
						prompt: "Reply with the single word: pong",
					}),
				);
				const live = await Effect.runPromise(port.agentGet(name));
				await Effect.runPromise(port.workspaceClose(workspace.workspaceId));
				expect(started.paneId).toBeTruthy();
				expect(live?.name).toBe(started.name);
				expect(live?.status).not.toBe("unknown");
			} finally {
				fs.rmSync(repo, { recursive: true, force: true });
			}
		},
		60_000,
	);

	test.skipIf(!socketPath)(
		"the scoped event subscription delivers a live signal",
		async () => {
			const port = livePort();
			const repo = fs.mkdtempSync(path.join(os.tmpdir(), "luvus-live-events-"));
			const seen: Array<{ event: string }> = [];
			const scope = Effect.runSync(Scope.make());
			try {
				Effect.runSync(
					Effect.provideService(
						port.eventsSubscribe((event) => seen.push(event)),
						Scope.Scope,
						scope,
					),
				);
				// Trigger a real state change after the subscription is registered.
				const workspace = await Effect.runPromise(
					port.workspaceCreate({
						cwd: repo,
						label: `live-events-${Date.now().toString(36)}`,
					}),
				);
				const deadline = Date.now() + 10_000;
				while (Date.now() < deadline && seen.length === 0) await Bun.sleep(25);
				await Effect.runPromise(port.workspaceClose(workspace.workspaceId));
				expect(seen.length).toBeGreaterThan(0);
			} finally {
				Effect.runSync(Scope.close(scope, Exit.void));
				fs.rmSync(repo, { recursive: true, force: true });
			}
		},
		60_000,
	);
});
