// The server's browser runtime composition (`add-stage-interactive-login`,
// TQ2-001).
//
// `runtime.ts` is the seam that makes the hand-off testable: it is the one place
// where the installer, the pool and the coordinator are wired together, and the
// two wiring decisions that matter — every launch goes through one path, and
// every session the pool drops ends the hand-off that held it — are invisible
// from either side alone. The registry is covered here too, because a second
// runtime would be a second browser for the same machine.
import { describe, expect, spyOn, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createFakeDriver } from "../src/server/browser/fake-driver.ts";
import {
	HANDOFF_TICK_MS,
	type LoginHandoffAttention,
} from "../src/server/browser/handoff.ts";
import {
	browserRuntime,
	createBrowserRuntime,
	resetBrowserRuntimes,
} from "../src/server/browser/runtime.ts";
import type { StageLoginRecipe } from "../src/server/stages/schema.ts";
import { DEFAULT_BROWSER_VIEWPORT } from "../src/workflow/effects.ts";

const ATTENTION: LoginHandoffAttention = {
	open: async () => {},
	answer: async () => undefined,
	close: async () => {},
};

/** An attention adapter that records what it was asked, so a composition test
 * can assert the coordinator reached the adapter it was given. */
function recordingAttention(): LoginHandoffAttention & {
	readonly opened: Array<Record<string, unknown>>;
	readonly closed: Array<Record<string, unknown>>;
} {
	const opened: Array<Record<string, unknown>> = [];
	const closed: Array<Record<string, unknown>> = [];
	return {
		opened,
		closed,
		open: async (input) => {
			opened.push({ ...input });
		},
		answer: async () => undefined,
		close: async (input) => {
			closed.push({ ...input });
		},
	};
}

/** A recipe whose success condition holds once the browser is on the app. */
const RECIPE: StageLoginRecipe = {
	kind: "interactive",
	success: { url: "https://app.test/logged-in" },
};

function tempConfigDir(): string {
	return fs.mkdtempSync(path.join(os.tmpdir(), "browser-runtime-"));
}

describe("the browser runtime composition", () => {
	test("one launch path serves the pool and the hand-off, and the injected seams are the ones used", async () => {
		const driver = createFakeDriver();
		const launches: Array<{ headed?: boolean } | undefined> = [];
		const timers: Array<{ run: () => void; ms: number }> = [];
		let clock = 1_000_000;
		const attention = recordingAttention();
		const runtime = createBrowserRuntime({
			configDir: tempConfigDir(),
			driver,
			launch: (launchOptions) => {
				launches.push(launchOptions);
				return { headless: launchOptions?.headed !== true };
			},
			availability: () => ({ ok: true }),
			schedule: (run, ms) => {
				timers.push({ run, ms });
				return () => {};
			},
			attention,
			now: () => clock,
		});
		expect(runtime.handoff.available()).toEqual({ ok: true });
		const session = await runtime.pool.acquire({
			owner: "workflow:wf-runtime",
			name: "default",
			viewport: DEFAULT_BROWSER_VIEWPORT,
			url: "https://app.test/",
		});
		// A headless launch takes no options; only a hand-off's window asks for one.
		expect(launches).toHaveLength(1);
		expect(launches[0]?.headed).toBeUndefined();
		// The hand-off raises its window through the same path, as the headed
		// launch the installer would have resolved.
		await runtime.handoff.request({
			session,
			stage: "grid-int",
			stageLabel: "Grid integration",
			app: "web",
			appLabel: "Grid web",
			role: "clerk",
			reason: "no-credentials",
			loginUrl: "https://idp.test/login",
			recipe: RECIPE,
			maxSeconds: 900,
			description: "Grid web · log in as clerk",
			context: "stage grid-int, app web, role clerk",
		});
		for (let i = 0; i < 50 && launches.length < 2; i++) {
			await new Promise((resolve) => setTimeout(resolve, 0));
		}
		expect(launches.at(-1)).toEqual({ headed: true });
		// The loop is the only thing that ends a hand-off, and the injected
		// scheduler owns its turns: the test drives them past the deadline, so
		// nothing here sleeps for real and a 900 s deadline is one loop.
		clock += 20 * 60 * 1000;
		const waiting = runtime.handoff.wait(session, 1);
		await new Promise((resolve) => setTimeout(resolve, 0));
		for (let i = 0; i < 20; i++) {
			for (const timer of timers.splice(0, timers.length)) {
				if (timer.ms !== HANDOFF_TICK_MS) {
					timers.push(timer);
					continue;
				}
				clock += timer.ms;
				timer.run();
			}
			await new Promise((resolve) => setTimeout(resolve, 0));
		}
		expect(await waiting).toEqual({
			outcome: { outcome: "timeout", deadlineAt: expect.any(String) },
		});
		// The adapter the runtime was composed with is the one the coordinator used,
		// from the window's record to its terminal outcome.
		expect(attention.opened).toHaveLength(1);
		expect(typeof attention.opened[0]?.recordId).toBe("string");
		expect(String(attention.opened[0]?.expiresAt)).toMatch(
			/^\d{4}-\d{2}-\d{2}T/,
		);
		expect(attention.closed[0]).toMatchObject({
			outcome: "login-handoff-timeout",
			by: "system",
		});
		await runtime.pool.closeAll();
	});

	test("a session the pool drops ends the hand-off that held it", async () => {
		const driver = createFakeDriver();
		const runtime = createBrowserRuntime({
			configDir: tempConfigDir(),
			driver,
			launch: () => ({ headless: false }),
			availability: () => ({ ok: true }),
			schedule: () => () => {},
			attention: ATTENTION,
		});
		const session = await runtime.pool.acquire({
			owner: "workflow:wf-runtime",
			name: "default",
			viewport: DEFAULT_BROWSER_VIEWPORT,
			url: "https://app.test/",
		});
		await runtime.handoff.request({
			session,
			stage: "grid-int",
			stageLabel: "Grid integration",
			app: "web",
			appLabel: "Grid web",
			role: "clerk",
			reason: "no-credentials",
			loginUrl: "https://idp.test/login",
			recipe: RECIPE,
			maxSeconds: 900,
			description: "Grid web · log in as clerk",
			context: "stage grid-int, app web, role clerk",
		});
		expect(session.heldByUser).toBe(true);
		// The wiring the pool owns: a session leaving it is the end of its
		// hand-off, and the developer's own close is told apart from the run's end.
		await runtime.pool.close("workflow:wf-runtime", "default");
		expect(await runtime.handoff.wait(session, 1)).toEqual({
			outcome: { outcome: "aborted", by: "window-closed" },
		});
		await runtime.pool.closeAll();
	});

	test("the registry is one runtime per config directory, and a later caller's attention is attached to it", () => {
		resetBrowserRuntimes();
		const dir = tempConfigDir();
		const first = browserRuntime(dir, ATTENTION);
		// The settings and operations surfaces build a runtime without the workflow
		// composition; a later caller must not get a second browser.
		expect(browserRuntime(dir)).toBe(first);
		const attach = spyOn(first.handoff, "attachAttention");
		const other: LoginHandoffAttention = { ...ATTENTION };
		expect(browserRuntime(dir, other)).toBe(first);
		expect(attach).toHaveBeenCalledWith(other);
		expect(browserRuntime(tempConfigDir())).not.toBe(first);
		resetBrowserRuntimes();
	});

	test("a runtime built before the workflow composition still gets its bearer-token source", () => {
		resetBrowserRuntimes();
		const dir = tempConfigDir();
		// The settings surface builds the runtime first, with no composition: no
		// stage request would be authenticated for the life of the process.
		const first = browserRuntime(dir);
		const setBearerToken = spyOn(first.pool, "setBearerToken");
		const source = async () => "Bearer token";

		const second = browserRuntime(dir, undefined, source);
		expect(second).toBe(first);
		// The source reaches the pool that already exists (CONC-004), so the next
		// request a stage-bound session makes is answered by it rather than by nobody.
		expect(setBearerToken).toHaveBeenCalledWith(source);
		// A caller without a source leaves the one a previous caller attached alone:
		// it must not detach what the composition already installed.
		const replacement = async () => "Bearer other";
		expect(browserRuntime(dir, undefined, replacement)).toBe(first);
		expect(setBearerToken).toHaveBeenLastCalledWith(replacement);
		expect(browserRuntime(dir)).toBe(first);
		expect(setBearerToken).toHaveBeenCalledTimes(2);
		resetBrowserRuntimes();
	});
});
