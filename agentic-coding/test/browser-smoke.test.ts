// Browser smoke test (`add-agent-browser-sessions`, task 4.3).
//
// Opt-in and therefore skipped by default: it drives a real headless Chromium
// against a local static page through the same routes the tools call, so the
// whole path — pool, navigation, snapshot refs, a ref click, an evidence
// screenshot and a kept recording — is exercised against the browser the
// application actually launches.
//
//   DEVENV_SMOKE_BROWSER=1 bun test test/browser-smoke.test.ts
//
// It requires a usable browser: a system Chrome, or Chromium installed under
// `PLAYWRIGHT_BROWSERS_PATH` (Settings → Browser → Install).
import { describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createFakeDriver } from "../src/server/browser/fake-driver.ts";
import { BrowserInstaller } from "../src/server/browser/install.ts";
import { createPlaywrightDriver } from "../src/server/browser/playwright-driver.ts";
import { BrowserPool } from "../src/server/browser/pool.ts";
import {
	type BrowserRouteDeps,
	handleBrowserRoute,
} from "../src/server/browser/routes.ts";
import { listEvidence } from "../src/server/evidence/store.ts";
import {
	AGENT_BROWSER_ACTION_PATH,
	AGENT_BROWSER_OPEN_PATH,
	AGENT_BROWSER_RECORD_PATH,
	AGENT_BROWSER_SCREENSHOT_PATH,
	AGENT_BROWSER_SNAPSHOT_PATH,
} from "../src/server/protocol.ts";
import { workflowEvidenceScope } from "../src/workflow/runtime/evidence-store.ts";

const ENABLED = process.env.DEVENV_SMOKE_BROWSER === "1";
const WORKFLOW_ID = "wf-smoke";
const OWNER = `workflow:${WORKFLOW_ID}`;

const PAGE = `<!doctype html><html><head><title>Smoke</title></head><body>
<h1>Browser smoke</h1>
<button id="go" onclick="document.title='Clicked'">Run</button>
<input aria-label="Name" />
</body></html>`;

async function call(
	deps: BrowserRouteDeps,
	routePath: string,
	body: unknown,
): Promise<{ status: number; value: Record<string, unknown> }> {
	const url = `http://127.0.0.1:4051${routePath}`;
	const response = await handleBrowserRoute(
		deps,
		new Request(url, {
			method: "POST",
			body: JSON.stringify(body),
			headers: { "content-type": "application/json" },
		}),
		new URL(url),
		OWNER,
	);
	if (!response) throw new Error(`no route for ${routePath}`);
	const parsed = JSON.parse(await response.text()) as Record<string, unknown>;
	return {
		status: response.status,
		value:
			parsed.ok === true
				? (parsed.value as Record<string, unknown>)
				: ((parsed.error as Record<string, unknown>) ?? {}),
	};
}

describe.skipIf(!ENABLED)("browser smoke (real Chromium)", () => {
	test("open, snapshot, click by ref, screenshot evidence and a kept recording", async () => {
		const base = fs.mkdtempSync(path.join(os.tmpdir(), "browser-smoke-"));
		const worktree = path.join(base, "repo");
		fs.mkdirSync(worktree, { recursive: true });
		const browsersPath =
			process.env.PLAYWRIGHT_BROWSERS_PATH ??
			path.join(os.homedir(), ".config", "agentic-coding", "browsers");
		const installer = new BrowserInstaller({
			configDir: path.dirname(browsersPath),
		});
		const status = installer.status();
		if (!status.available)
			throw new Error(
				`no browser is available (system Chrome or Chromium under ${browsersPath}); install one first`,
			);
		const pool = new BrowserPool({
			driver: createPlaywrightDriver(),
			launch: () => installer.resolveLaunch(),
			maxSessions: () => 2,
			idleTtlMs: () => 900_000,
		});
		const deps: BrowserRouteDeps = {
			installer,
			pool,
			settings: () => ({
				maxSessions: 2,
				idleTtlMs: 900_000,
				viewport: { width: 1024, height: 768 },
			}),
			locate: (workflowId: string) =>
				workflowId === WORKFLOW_ID
					? { workflowId, worktree, definitionId: "core" }
					: undefined,
		};
		const server = Bun.serve({
			port: 0,
			fetch: () =>
				new Response(PAGE, { headers: { "content-type": "text/html" } }),
		});
		try {
			const opened = await call(deps, AGENT_BROWSER_OPEN_PATH, {
				url: `http://127.0.0.1:${server.port}/`,
			});
			expect(opened.status).toBe(200);

			const snapshot = await call(deps, AGENT_BROWSER_SNAPSHOT_PATH, {});
			expect(snapshot.status).toBe(200);
			const text = String(snapshot.value.snapshot);
			const ref = text.match(/\[ref=(e\d+)\]/)?.[1] as string;
			expect(ref).toBeString();
			expect(text).toContain('button "Run" [ref=');
			expect(text).toContain('textbox "Name" [ref=');

			const clicked = await call(deps, AGENT_BROWSER_ACTION_PATH, {
				action: "click",
				ref,
			});
			expect(clicked.status).toBe(200);

			const shot = await call(deps, AGENT_BROWSER_SCREENSHOT_PATH, {
				evidence: true,
				caption: "the smoke page",
			});
			expect(shot.value.mediaType).toBe("image/jpeg");
			expect(String(shot.value.base64).length).toBeGreaterThan(1_000);

			expect(
				(await call(deps, AGENT_BROWSER_RECORD_PATH, { action: "start" }))
					.status,
			).toBe(200);
			const stopped = await call(deps, AGENT_BROWSER_RECORD_PATH, {
				action: "stop",
				keep: true,
				caption: "the smoke recording",
			});
			expect(stopped.status).toBe(200);
			expect(stopped.value.video).toMatchObject({ kind: "video" });

			const scope = workflowEvidenceScope({
				workflowId: WORKFLOW_ID,
				worktree,
				definitionId: "core",
			});
			const manifest = listEvidence(scope);
			expect(manifest.entries.map((entry) => entry.kind).sort()).toEqual([
				"screenshot",
				"screenshot",
				"video",
			]);
			const video = manifest.entries.find((entry) => entry.kind === "video");
			if (!video) throw new Error("no video evidence was stored");
			expect(
				fs.statSync(path.join(scope.root, video.file)).size,
			).toBeGreaterThan(0);
		} finally {
			server.stop(true);
			await pool.closeAll();
			fs.rmSync(base, { recursive: true, force: true });
		}
	}, 120_000);
});

describe.skipIf(ENABLED)("browser smoke is opt-in", () => {
	test("does nothing unless DEVENV_SMOKE_BROWSER=1", () => {
		// The fake driver lets this module be imported and its helpers exercised
		// without a browser, so a plain `bun test` run costs nothing.
		expect(typeof createFakeDriver).toBe("function");
	});
});
