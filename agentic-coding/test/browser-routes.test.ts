// The agent browser routes (`add-agent-browser-sessions`, tasks 4.1-4.2).
//
// The routes are exercised through their real HTTP-shaped handler with the fake
// driver and a temporary workflow checkout, so the whole pipeline is checked:
// contract decoding, the session/ref contract, `app-not-held` resolution,
// image results, evidence attach and discard, and the script timeout.
import { describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createFakeDriver } from "../src/server/browser/fake-driver.ts";
import { BrowserInstaller } from "../src/server/browser/install.ts";
import { BrowserPool } from "../src/server/browser/pool.ts";
import {
	type BrowserRouteDeps,
	handleBrowserRoute,
	MAX_SCRIPT_CONTENT_CHARS,
	reproSpec,
} from "../src/server/browser/routes.ts";
import type { App } from "../src/server/environment/config.ts";
import type { EnvironmentManager } from "../src/server/environment/manager.ts";
import { listEvidence } from "../src/server/evidence/store.ts";
import {
	AGENT_BROWSER_ACTION_PATH,
	AGENT_BROWSER_CLOSE_PATH,
	AGENT_BROWSER_EVAL_PATH,
	AGENT_BROWSER_FIND_PATH,
	AGENT_BROWSER_OPEN_PATH,
	AGENT_BROWSER_RECORD_PATH,
	AGENT_BROWSER_SCREENSHOT_PATH,
	AGENT_BROWSER_SCRIPT_PATH,
	AGENT_BROWSER_SNAPSHOT_PATH,
	AGENT_BROWSER_WAIT_PATH,
} from "../src/server/protocol.ts";
import type { EnvironmentInstanceController } from "../src/server/runtime/instances.ts";
import {
	BROWSER_MAX_IMAGE_WIDTH,
	DEFAULT_BROWSER_VIEWPORT,
} from "../src/workflow/effects.ts";
import { workflowEvidenceScope } from "../src/workflow/runtime/evidence-store.ts";

const WORKFLOW_ID = "wf-browser";
const OWNER = `workflow:${WORKFLOW_ID}`;
/** A real WebM header: the evidence store checks the content's own magic bytes
 * against the kind, so a placeholder string would be refused (correctly). */
const WEBM = new Uint8Array([0x1a, 0x45, 0xdf, 0xa3, 0x00, 0x00, 0x00, 0x00]);

/** A throwaway checkout whose `.herdr-workflow` is the workflow's data root. */
function fixture(): string {
	const base = fs.mkdtempSync(path.join(os.tmpdir(), "browser-routes-"));
	const worktree = path.join(base, "repo");
	fs.mkdirSync(worktree, { recursive: true });
	return worktree;
}

interface SlotStub {
	app: string;
	holder: string | null;
	endpoints: Record<string, string>;
}

function deps(
	worktree: string,
	driver: ReturnType<typeof createFakeDriver>,
	slot?: SlotStub,
	viewport: { width: number; height: number } = DEFAULT_BROWSER_VIEWPORT,
): BrowserRouteDeps {
	// A real file stands in for a detected system Chrome: the installer only
	// checks that the candidate exists, and the fake driver never launches it.
	const chrome = path.join(worktree, "fake-chrome");
	fs.writeFileSync(chrome, "#!/bin/sh\n");
	const installer = new BrowserInstaller({
		configDir: path.join(worktree, "config"),
		chromeCandidates: [chrome],
	});
	const pool = new BrowserPool({
		driver,
		launch: () => installer.resolveLaunch(),
		maxSessions: () => 4,
		idleTtlMs: () => 900_000,
	});
	return {
		installer,
		pool,
		settings: () => ({
			maxSessions: 4,
			idleTtlMs: 900_000,
			viewport,
		}),
		apps: {
			getAppByIdent: (ident: string) =>
				ident === "customer-fe"
					? ({ ident: "customer-fe", appType: "APP" } as unknown as App)
					: undefined,
		} as unknown as Pick<EnvironmentManager, "getAppByIdent">,
		instances: {
			slots: async () => [
				{
					app: slot?.app ?? "customer-fe",
					holder: slot?.holder ?? null,
					status: "running",
					waiters: [],
					waiting: [],
					holderSince: null,
					idleMs: null,
					idleTtlMs: null,
					endpoints: slot?.endpoints ?? { web: "http://127.0.0.1:5173" },
				},
			],
			touchOwnedActivity: () => {},
		} as unknown as EnvironmentInstanceController,
		locate: (workflowId: string) =>
			workflowId === WORKFLOW_ID
				? { workflowId, worktree, definitionId: "core" }
				: undefined,
	};
}

async function call(
	deps: BrowserRouteDeps,
	routePath: string,
	body: unknown = {},
	owner = OWNER,
): Promise<{ status: number; value: Record<string, unknown>; text: string }> {
	const url = `http://127.0.0.1:4050${routePath}`;
	const response = await handleBrowserRoute(
		deps,
		new Request(url, {
			method: "POST",
			body: JSON.stringify(body),
			headers: { "content-type": "application/json" },
		}),
		new URL(url),
		owner,
	);
	if (!response) throw new Error(`no route for ${routePath}`);
	const text = await response.text();
	const parsed = JSON.parse(text) as Record<string, unknown>;
	return {
		status: response.status,
		value:
			parsed.ok === true
				? (parsed.value as Record<string, unknown>)
				: ((parsed.error as Record<string, unknown>) ?? {}),
		text,
	};
}

describe("agent browser routes", () => {
	test("open, snapshot and a ref click drive one session", async () => {
		const worktree = fixture();
		const driver = createFakeDriver();
		const routeDeps = deps(worktree, driver);
		const opened = await call(routeDeps, AGENT_BROWSER_OPEN_PATH, {
			url: "http://app.local/",
		});
		expect(opened.status).toBe(200);
		expect(opened.value.url).toBe("http://app.local/");
		const snapshot = await call(routeDeps, AGENT_BROWSER_SNAPSHOT_PATH);
		expect(snapshot.value.refs).toBeGreaterThan(0);
		const clicked = await call(routeDeps, AGENT_BROWSER_ACTION_PATH, {
			action: "click",
			ref: "e0",
		});
		expect(clicked.status).toBe(200);
		expect(driver.performed).toEqual(["click:ref=e0"]);
		// A ref no snapshot produced is refused, not silently resolved.
		const stale = await call(routeDeps, AGENT_BROWSER_ACTION_PATH, {
			action: "click",
			ref: "e99",
		});
		expect(stale.status).toBe(400);
		expect(stale.text).toContain("unknown-ref");
		await routeDeps.pool.closeAll();
	});

	test("an app endpoint resolves only while this workflow holds the app", async () => {
		const worktree = fixture();
		const routeDeps = deps(worktree, createFakeDriver(), {
			app: "customer-fe",
			holder: "workflow:other",
			endpoints: { web: "http://127.0.0.1:5173" },
		});
		const refused = await call(routeDeps, AGENT_BROWSER_OPEN_PATH, {
			app: "customer-fe",
			endpoint: "web",
		});
		expect(refused.status).toBe(409);
		expect(refused.text).toContain("app-not-held");
		expect(refused.text).toContain("workflow:other");
		await routeDeps.pool.closeAll();
	});

	test("a held app endpoint resolves to its static URL", async () => {
		const worktree = fixture();
		const routeDeps = deps(worktree, createFakeDriver(), {
			app: "customer-fe",
			holder: OWNER,
			endpoints: { web: "http://127.0.0.1:5173" },
		});
		const opened = await call(routeDeps, AGENT_BROWSER_OPEN_PATH, {
			app: "customer-fe",
			endpoint: "web",
		});
		expect(opened.status).toBe(200);
		expect(opened.value.url).toBe("http://127.0.0.1:5173");
		expect(opened.value.app).toBe("customer-fe");
		await routeDeps.pool.closeAll();
	});

	test("a screenshot is returned to the model and stored only on request", async () => {
		const worktree = fixture();
		const routeDeps = deps(worktree, createFakeDriver());
		await call(routeDeps, AGENT_BROWSER_OPEN_PATH, {
			url: "http://app.local/",
		});
		const plain = await call(routeDeps, AGENT_BROWSER_SCREENSHOT_PATH, {});
		expect(plain.value.mediaType).toBe("image/jpeg");
		expect(String(plain.value.base64).length).toBeGreaterThan(0);
		expect(plain.value.evidence).toBeUndefined();
		const stored = await call(routeDeps, AGENT_BROWSER_SCREENSHOT_PATH, {
			evidence: true,
			caption: "the bug",
		});
		expect(stored.value.evidence).toMatchObject({
			kind: "screenshot",
			caption: "the bug",
		});
		const scope = workflowEvidenceScope({
			workflowId: WORKFLOW_ID,
			worktree,
			definitionId: "core",
		});
		const manifest = listEvidence(scope);
		expect(manifest.entries).toHaveLength(1);
		expect(manifest.entries[0]?.kind).toBe("screenshot");
		await routeDeps.pool.closeAll();
	});

	test("a discarded recording leaves no evidence and no video file", async () => {
		const worktree = fixture();
		const routeDeps = deps(worktree, createFakeDriver({ video: WEBM }));
		await call(routeDeps, AGENT_BROWSER_OPEN_PATH, {
			url: "http://app.local/",
		});
		const started = await call(routeDeps, AGENT_BROWSER_RECORD_PATH, {
			action: "start",
		});
		expect(started.value.recording).toBe(true);
		const stopped = await call(routeDeps, AGENT_BROWSER_RECORD_PATH, {
			action: "stop",
			keep: false,
		});
		// A discard answers the same shape a keep does, with `kept: false`: one
		// answer for one action, so a caller reads `kept` and never a second field.
		expect(stopped.value.kept).toBe(false);
		expect(stopped.value.video).toBe(false);
		expect(String(stopped.value.notice)).toContain("discarded");
		const scope = workflowEvidenceScope({
			workflowId: WORKFLOW_ID,
			worktree,
			definitionId: "core",
		});
		expect(listEvidence(scope).entries).toEqual([]);
		expect(
			filesUnder(path.join(worktree, ".herdr-workflow", "browser")),
		).toEqual([]);
		await routeDeps.pool.closeAll();
	});

	test("a kept recording stores the video with its poster", async () => {
		const worktree = fixture();
		const routeDeps = deps(worktree, createFakeDriver({ video: WEBM }));
		await call(routeDeps, AGENT_BROWSER_OPEN_PATH, {
			url: "http://app.local/",
		});
		await call(routeDeps, AGENT_BROWSER_RECORD_PATH, { action: "start" });
		const stopped = await call(routeDeps, AGENT_BROWSER_RECORD_PATH, {
			action: "stop",
			keep: true,
			caption: "the crash",
		});
		expect(stopped.value.kept).toBe(true);
		expect(stopped.value.video).toMatchObject({ kind: "video" });
		const poster = stopped.value.poster as { id: string } | undefined;
		expect(poster?.id).toBeString();
		expect(stopped.value.video).toMatchObject({ poster: poster?.id });
		await routeDeps.pool.closeAll();
	});

	test("a scripted page exposes the documented Playwright surface", async () => {
		const worktree = fixture();
		const routeDeps = deps(worktree, createFakeDriver());
		await call(routeDeps, AGENT_BROWSER_OPEN_PATH, {
			url: "http://app.local/",
		});
		// The facade is an allow-list: the methods the tool description names must
		// really be there, and each must answer like the Playwright method it wraps
		// (`fix-env-tool-defects-from-e2e`: `page.waitForFunction` was undefined).
		const script = await call(routeDeps, AGENT_BROWSER_SCRIPT_PATH, {
			code: [
				"const kinds = {};",
				"for (const name of ['waitForFunction','waitForSelector','waitForURL','waitForLoadState','title','content','getByText','getByLabel','getByPlaceholder','getByRole','press','fill'])",
				"  kinds[name] = typeof page[name];",
				"await page.waitForFunction(() => true);",
				"await page.waitForSelector('[data-ac-ref=\"e0\"]');",
				"await page.waitForURL('http://app.local/');",
				"await page.waitForLoadState('load');",
				"return {",
				"  kinds,",
				"  title: await page.title(),",
				"  text: await page.getByText('Save').textContent(),",
				"};",
			].join("\n"),
		});
		expect(script.status).toBe(200);
		const result = script.value.result as {
			kinds: Record<string, string>;
			title: string;
			text: string;
		};
		for (const value of Object.values(result.kinds))
			expect(value).toBe("function");
		expect(result.title).toBe("Fake");
		expect(result.text).toBe("fake");
		await routeDeps.pool.closeAll();
	});

	test("an unsupported page method fails with the supported surface", async () => {
		const worktree = fixture();
		const routeDeps = deps(worktree, createFakeDriver());
		await call(routeDeps, AGENT_BROWSER_OPEN_PATH, {
			url: "http://app.local/",
		});
		// The failure names the method and lists what *is* supported, instead of the
		// bare `TypeError` an undefined property produces.
		const refused = await call(routeDeps, AGENT_BROWSER_SCRIPT_PATH, {
			code: "return page.waitForPizza();",
		});
		expect(refused.status).toBe(400);
		expect(refused.text).toContain("page.waitForPizza is not available");
		expect(refused.text).toContain("waitForFunction");
		expect(refused.text).toContain("getByText");
		await routeDeps.pool.closeAll();
	});

	test("the scripted page's content is bounded", async () => {
		const worktree = fixture();
		const routeDeps = deps(
			worktree,
			createFakeDriver({ content: "x".repeat(MAX_SCRIPT_CONTENT_CHARS + 500) }),
		);
		await call(routeDeps, AGENT_BROWSER_OPEN_PATH, {
			url: "http://app.local/",
		});
		const script = await call(routeDeps, AGENT_BROWSER_SCRIPT_PATH, {
			code: "const html = await page.content();\nreturn html.length;",
		});
		expect(script.status).toBe(200);
		expect(script.value.result).toBe(MAX_SCRIPT_CONTENT_CHARS + 1);
		await routeDeps.pool.closeAll();
	});

	test("a script that exceeds its timeout fails with script-timeout", async () => {
		const worktree = fixture();
		const routeDeps = deps(worktree, createFakeDriver());
		await call(routeDeps, AGENT_BROWSER_OPEN_PATH, {
			url: "http://app.local/",
		});
		const timedOut = await call(routeDeps, AGENT_BROWSER_SCRIPT_PATH, {
			code: "await new Promise((resolve) => setTimeout(resolve, 200)); return 1;",
			timeoutMs: 1,
		});
		expect(timedOut.status).toBe(408);
		expect(timedOut.text).toContain("script-timeout");
		// The session is still usable afterwards.
		const snapshot = await call(routeDeps, AGENT_BROWSER_SNAPSHOT_PATH);
		expect(snapshot.status).toBe(200);
		await routeDeps.pool.closeAll();
	});

	test("a saved script is a rerunnable spec pinned to the page URL", async () => {
		const worktree = fixture();
		const routeDeps = deps(worktree, createFakeDriver());
		await call(routeDeps, AGENT_BROWSER_OPEN_PATH, {
			url: "http://app.local/",
		});
		const result = await call(routeDeps, AGENT_BROWSER_SCRIPT_PATH, {
			code: "await expect(page).toBeTruthy();",
			save: true,
			caption: "repro",
		});
		expect(result.value.result).toBeNull();
		const entry = result.value.evidence as { id: string; kind: string };
		expect(entry.kind).toBe("script");
		const scope = workflowEvidenceScope({
			workflowId: WORKFLOW_ID,
			worktree,
			definitionId: "core",
		});
		const stored = listEvidence(scope).entries[0];
		if (!stored) throw new Error("no script evidence was attached");
		const spec = fs.readFileSync(path.join(scope.root, stored.file), "utf8");
		expect(spec).toContain('from "@playwright/test"');
		expect(spec).toContain('const baseURL = "http://app.local/"');
		expect(spec).toContain("await expect(page).toBeTruthy();");
		await routeDeps.pool.closeAll();
	});

	test("a multi-line script body is accepted", async () => {
		const worktree = fixture();
		const routeDeps = deps(worktree, createFakeDriver());
		await call(routeDeps, AGENT_BROWSER_OPEN_PATH, {
			url: "http://app.local/",
		});
		// A script is multi-line by nature: the wire contract must not refuse the
		// ordinary case with a control-character error.
		const script = await call(routeDeps, AGENT_BROWSER_SCRIPT_PATH, {
			code: "const one = 1;\nawait Promise.resolve(one);\nreturn one;\t// tab",
			caption: "repro",
		});
		expect(script.status).toBe(200);
		expect(script.value.result).toBe(1);
		const evaluated = await call(routeDeps, AGENT_BROWSER_EVAL_PATH, {
			code: "await Promise.resolve(1);\nreturn 2;",
		});
		expect(evaluated.status).toBe(200);
		await routeDeps.pool.closeAll();
	});

	test("a screenshot is never wider than the design bound", async () => {
		const worktree = fixture();
		const driver = createFakeDriver();
		const routeDeps = deps(worktree, driver, undefined, {
			width: 1920,
			height: 1080,
		});
		await call(routeDeps, AGENT_BROWSER_OPEN_PATH, {
			url: "http://app.local/",
		});
		const shot = await call(routeDeps, AGENT_BROWSER_SCREENSHOT_PATH, {});
		expect(shot.status).toBe(200);
		const page = driver.lastPage();
		expect(page?.capturedAt.at(-1)).toEqual({
			width: BROWSER_MAX_IMAGE_WIDTH,
			height: 1080,
		});
		// The session keeps the viewport it was opened with.
		expect(page?.viewport).toEqual({ width: 1920, height: 1080 });
		await routeDeps.pool.closeAll();
	});

	test("a screenshot captures the whole page unless the viewport is asked for", async () => {
		const worktree = fixture();
		const driver = createFakeDriver();
		const routeDeps = deps(worktree, driver);
		await call(routeDeps, AGENT_BROWSER_OPEN_PATH, {
			url: "http://app.local/",
		});
		expect(
			(await call(routeDeps, AGENT_BROWSER_SCREENSHOT_PATH, {})).status,
		).toBe(200);
		expect(
			(
				await call(routeDeps, AGENT_BROWSER_SCREENSHOT_PATH, {
					fullPage: false,
				})
			).status,
		).toBe(200);
		expect(driver.lastPage()?.fullPageRequested).toEqual([true, false]);
		await routeDeps.pool.closeAll();
	});

	test("a script cannot reach the browser object that serves every run", async () => {
		const worktree = fixture();
		const routeDeps = deps(worktree, createFakeDriver());
		await call(routeDeps, AGENT_BROWSER_OPEN_PATH, {
			url: "http://app.local/",
		});
		const escaped = await call(routeDeps, AGENT_BROWSER_SCRIPT_PATH, {
			code: [
				"const reaches = [];",
				// A probe "reaches" when what it resolves to still exposes a way back to
				// the browser; a refused value is undefined, and a thrown probe is not a
				// reach either.
				"const walkable = (value) =>",
				'  value !== null && typeof value === "object" &&',
				'  (typeof value.frame === "function" || typeof value.browser === "function" ||',
				'   typeof value.context === "function" || typeof value.page === "function" ||',
				'   typeof value._browserContext !== "undefined");',
				"const check = async (name, probe) => {",
				"  try { if (walkable(await probe())) reaches.push(name); } catch {}",
				"};",
				"const listed = (await context.pages())[0];",
				"const opened = await context.newPage();",
				'await check("context.browser", () => context.browser);',
				'await check("page.browser", () => page.browser);',
				'await check("page._browserContext", () => page._browserContext);',
				'await check("locator.page", () => page.locator("body").page);',
				'await check("keyboard.page", () => page.keyboard.page);',
				'await check("mouse.page", () => page.mouse.page);',
				'await check("context.frames", () => context.frames);',
				'await check("listed.goto.response", () => listed.goto("http://app.local/"));',
				'await check("opened.goto.response", () => opened.goto("http://app.local/"));',
				'await check("listed.evaluateHandle", () => listed.evaluateHandle("1"));',
				'await check("page.evaluateHandle", () => page.evaluateHandle("1"));',
				'await check("locator.elementHandle", () => page.locator("body").elementHandle());',
				"return reaches;",
			].join("\n"),
		});
		expect(escaped.status).toBe(200);
		expect(escaped.value.result).toEqual([]);
		// The page still reaches its own context, so a script keeps working — and a
		// page obtained *through* the facade is a facade too, not the raw page a
		// reader would then be able to walk back from.
		const own = await call(routeDeps, AGENT_BROWSER_SCRIPT_PATH, {
			code: [
				"const opened = await context.newPage();",
				"const listed = (await context.pages())[0];",
				"return [",
				"  page.context() === context,",
				"  typeof context.newPage,",
				"  typeof page.locator,",
				"  typeof opened.goto,",
				"  typeof opened.locator,",
				"  opened.context() === context,",
				"  listed.context() === context,",
				"  typeof listed.goto,",
				"];",
			].join("\n"),
		});
		expect(own.status).toBe(200);
		expect(own.value.result).toEqual([
			true,
			"function",
			"function",
			"function",
			"function",
			true,
			true,
			"function",
		]);
		await routeDeps.pool.closeAll();
	});

	test("two concurrent kept recordings of one workflow both store their own video", async () => {
		const worktree = fixture();
		const routeDeps = deps(worktree, createFakeDriver({ video: WEBM }));
		await call(routeDeps, AGENT_BROWSER_OPEN_PATH, {
			url: "http://app.local/",
		});
		await call(routeDeps, AGENT_BROWSER_OPEN_PATH, {
			url: "http://app.local/second",
			session: "second",
		});
		await call(routeDeps, AGENT_BROWSER_RECORD_PATH, { action: "start" });
		await call(routeDeps, AGENT_BROWSER_RECORD_PATH, {
			action: "start",
			session: "second",
		});
		const [first, second] = await Promise.all([
			call(routeDeps, AGENT_BROWSER_RECORD_PATH, {
				action: "stop",
				keep: true,
				caption: "first",
			}),
			call(routeDeps, AGENT_BROWSER_RECORD_PATH, {
				action: "stop",
				keep: true,
				caption: "second",
				session: "second",
			}),
		]);
		expect(first.status).toBe(200);
		expect(second.status).toBe(200);
		expect(first.value.video).toMatchObject({
			kind: "video",
			caption: "first",
		});
		expect(second.value.video).toMatchObject({
			kind: "video",
			caption: "second",
		});
		const scope = workflowEvidenceScope({
			workflowId: WORKFLOW_ID,
			worktree,
			definitionId: "core",
		});
		const videos = listEvidence(scope).entries.filter(
			(entry) => entry.kind === "video",
		);
		expect(videos.map((entry) => entry.caption).sort()).toEqual([
			"first",
			"second",
		]);
		for (const entry of videos)
			expect(fs.statSync(path.join(scope.root, entry.file)).size).toBe(8);
		await routeDeps.pool.closeAll();
	});

	test("browser_close releases the session", async () => {
		const worktree = fixture();
		const routeDeps = deps(worktree, createFakeDriver());
		await call(routeDeps, AGENT_BROWSER_OPEN_PATH, {
			url: "http://app.local/",
		});
		const closed = await call(routeDeps, AGENT_BROWSER_CLOSE_PATH, {});
		expect(closed.value.closed).toBe(true);
		const snapshot = await call(routeDeps, AGENT_BROWSER_SNAPSHOT_PATH);
		expect(snapshot.status).toBe(409);
		await routeDeps.pool.closeAll();
	});

	describe("snapshot observation loop", () => {
		const IFRAME_SNAPSHOT = [
			'- iframe "Payment" [ref=f1e1]:',
			'  - textbox "Card" [ref=f1e2]',
		].join("\n");

		test("snapshot options are bounded and scoped reads keep their target", async () => {
			const worktree = fixture();
			const driver = createFakeDriver({
				withinSnapshots: { "selector=.card": '- button "Save" [ref=e9]' },
			});
			const routeDeps = deps(worktree, driver);
			await call(routeDeps, AGENT_BROWSER_OPEN_PATH, {
				url: "http://app.local/",
			});
			const full = await call(routeDeps, AGENT_BROWSER_SNAPSHOT_PATH, {
				depth: 2,
				maxChars: 1000,
			});
			expect(full.status).toBe(200);
			expect(full.value.snapshotId).toBeString();
			expect(driver.snapshotRequests[0]).toMatchObject({
				depth: 2,
				maxChars: 1000,
			});
			expect(full.value.timing).toMatchObject({
				changed: false,
				truncated: false,
			});
			const scoped = await call(routeDeps, AGENT_BROWSER_SNAPSHOT_PATH, {
				within: "e1",
			});
			expect(scoped.value.snapshot).toContain('button "Save"');
			expect(scoped.value.snapshot).not.toContain("textbox");
			expect(driver.snapshotRequests[1]?.within).toEqual({ ref: "e1" });
			const selector = await call(routeDeps, AGENT_BROWSER_SNAPSHOT_PATH, {
				within: ".card",
			});
			expect(selector.value.snapshot).toContain('button "Save" [ref=e9]');
			expect(driver.snapshotRequests[2]?.within).toEqual({
				selector: ".card",
			});
			const capped = await call(routeDeps, AGENT_BROWSER_SNAPSHOT_PATH, {
				maxChars: 10,
			});
			expect(String(capped.value.snapshot).length).toBeLessThanOrEqual(10);
			expect(capped.value.timing).toMatchObject({ truncated: true });
			await routeDeps.pool.closeAll();
		});

		test("diff uses bounded history and refuses an evicted or unknown since", async () => {
			const worktree = fixture();
			const driver = createFakeDriver({
				snapshots: [
					'- heading "One" [ref=e1]',
					'- heading "Two" [ref=e1]',
					'- heading "Three" [ref=e1]',
					'- heading "Four" [ref=e1]',
					'- heading "Five" [ref=e1]',
				],
			});
			const routeDeps = deps(worktree, driver);
			await call(routeDeps, AGENT_BROWSER_OPEN_PATH, {
				url: "http://app.local/",
			});
			const first = await call(routeDeps, AGENT_BROWSER_SNAPSHOT_PATH);
			const firstId = String(first.value.snapshotId);
			await call(routeDeps, AGENT_BROWSER_SNAPSHOT_PATH);
			const diff = await call(routeDeps, AGENT_BROWSER_SNAPSHOT_PATH, {
				diff: true,
				since: firstId,
			});
			expect(diff.status).toBe(200);
			expect(diff.value).toMatchObject({
				since: firstId,
				changed: true,
			});
			expect(diff.value.delta).toMatchObject({
				changed: [{ ref: "e1", role: "heading", name: "Two" }],
			});
			// Fill the four-state history so the first snapshot is evicted.
			for (let index = 0; index < 3; index++)
				await call(routeDeps, AGENT_BROWSER_SNAPSHOT_PATH);
			const evicted = await call(routeDeps, AGENT_BROWSER_SNAPSHOT_PATH, {
				diff: true,
				since: firstId,
			});
			expect(evicted.status).toBe(409);
			expect(evicted.value.code).toBe("snapshot-history-missing");
			const unknown = await call(routeDeps, AGENT_BROWSER_SNAPSHOT_PATH, {
				diff: true,
				since: "s999",
			});
			expect(unknown.status).toBe(409);
			expect(unknown.value.code).toBe("snapshot-history-missing");
			const conflict = await call(routeDeps, AGENT_BROWSER_SNAPSHOT_PATH, {
				diff: true,
				within: "e1",
			});
			expect(conflict.status).toBe(400);
			expect(conflict.value.code).toBe("snapshot-options-conflict");
			await routeDeps.pool.closeAll();
		});

		test("find returns matches without changing the current id or tree", async () => {
			const worktree = fixture();
			const driver = createFakeDriver();
			const routeDeps = deps(worktree, driver);
			await call(routeDeps, AGENT_BROWSER_OPEN_PATH, {
				url: "http://app.local/",
			});
			const snapshot = await call(routeDeps, AGENT_BROWSER_SNAPSHOT_PATH);
			const snapshotId = String(snapshot.value.snapshotId);
			const found = await call(routeDeps, AGENT_BROWSER_FIND_PATH, {
				query: "save",
				role: "button",
			});
			expect(found.status).toBe(200);
			expect(found.value).toMatchObject({
				snapshotId,
				total: 1,
				truncated: false,
			});
			expect(found.value.matches).toEqual([
				{ ref: "e1", role: "button", name: "Save" },
			]);
			expect(found.value.snapshot).toBeUndefined();
			const scoped = await call(routeDeps, AGENT_BROWSER_FIND_PATH, {
				query: "save",
				within: "e1",
			});
			expect(scoped.value).toMatchObject({ snapshotId, total: 1 });
			const missing = await call(routeDeps, AGENT_BROWSER_FIND_PATH, {
				query: "does-not-exist",
			});
			expect(missing.value).toMatchObject({ total: 0, matches: [] });
			// A find is a read: the id still names the exact state an action uses.
			driver.queueSnapshot('- button "Save" [ref=e1]');
			const clicked = await call(routeDeps, AGENT_BROWSER_ACTION_PATH, {
				action: "click",
				ref: "e1",
				snapshotId,
			});
			expect(clicked.status).toBe(200);
			// A frame-prefixed ref is findable in the state its snapshot named.
			driver.setSnapshot(IFRAME_SNAPSHOT);
			const withFrame = await call(routeDeps, AGENT_BROWSER_SNAPSHOT_PATH);
			expect(withFrame.status).toBe(200);
			const frameFind = await call(routeDeps, AGENT_BROWSER_FIND_PATH, {
				query: "card",
				role: "textbox",
			});
			expect(frameFind.value.matches).toEqual([
				{ ref: "f1e2", role: "textbox", name: "Card" },
			]);
			await routeDeps.pool.closeAll();
		});

		test("an action answers with a compact delta and a new snapshot id", async () => {
			const worktree = fixture();
			const driver = createFakeDriver();
			const routeDeps = deps(worktree, driver);
			await call(routeDeps, AGENT_BROWSER_OPEN_PATH, {
				url: "http://app.local/",
			});
			const before = await call(routeDeps, AGENT_BROWSER_SNAPSHOT_PATH);
			driver.queueSnapshot(
				[
					'- heading "Fake" [level=1] [ref=e0]',
					'- button "Save" [ref=e1]',
					'- textbox "Name" [ref=e2]',
					'- link "Home" [ref=e3]',
					'- button "Delete" [ref=e4]',
				].join("\n"),
			);
			const clicked = await call(routeDeps, AGENT_BROWSER_ACTION_PATH, {
				action: "click",
				ref: "e1",
				snapshotId: before.value.snapshotId,
			});
			expect(clicked.status).toBe(200);
			expect(clicked.value.snapshotId).not.toBe(before.value.snapshotId);
			expect(clicked.value.snapshot).toBeUndefined();
			expect(clicked.value.observation).toContain("changed: +1 -0 ~0");
			expect(clicked.value.delta).toMatchObject({
				added: [{ ref: "e4", role: "button", name: "Delete" }],
				removed: [],
				changed: [],
			});
			expect(clicked.value.deltaTruncated).toBe(false);
			expect(clicked.value.snapshotRequired).toBe(false);
			expect(clicked.value.timing).toMatchObject({
				changed: true,
				truncated: false,
			});
			driver.queueSnapshot(
				[
					'- heading "Fake" [level=1] [ref=e0]',
					'- button "Save" [ref=e1]',
					'- textbox "Name" [ref=e2]',
					'- link "Home" [ref=e3]',
					'- button "Delete" [ref=e4]',
				].join("\n"),
			);
			const unchanged = await call(routeDeps, AGENT_BROWSER_ACTION_PATH, {
				action: "click",
				ref: "e1",
			});
			expect(unchanged.value.changed).toBe(false);
			expect(unchanged.value.observation).toContain("changed: none");
			await routeDeps.pool.closeAll();
		});

		test("a stale snapshot id and a stale ref are refused before the page is touched", async () => {
			const worktree = fixture();
			const driver = createFakeDriver();
			const routeDeps = deps(worktree, driver);
			await call(routeDeps, AGENT_BROWSER_OPEN_PATH, {
				url: "http://app.local/",
			});
			const first = await call(routeDeps, AGENT_BROWSER_SNAPSHOT_PATH);
			driver.queueSnapshot(
				[
					'- heading "Fake" [level=1] [ref=e0]',
					'- button "Save" [ref=e1]',
					'- textbox "Name" [ref=e2]',
					'- link "Home" [ref=e3]',
				].join("\n"),
			);
			const clicked = await call(routeDeps, AGENT_BROWSER_ACTION_PATH, {
				action: "click",
				ref: "e1",
			});
			expect(clicked.status).toBe(200);
			const performed = driver.performed.length;
			const staleId = await call(routeDeps, AGENT_BROWSER_ACTION_PATH, {
				action: "click",
				ref: "e1",
				snapshotId: first.value.snapshotId,
			});
			expect(staleId.status).toBe(409);
			expect(staleId.value.code).toBe("stale-snapshot");
			expect(driver.performed).toHaveLength(performed);
			driver.setSnapshot('- heading "No controls" [ref=e1]');
			const refreshed = await call(routeDeps, AGENT_BROWSER_SNAPSHOT_PATH);
			const staleRef = await call(routeDeps, AGENT_BROWSER_ACTION_PATH, {
				action: "click",
				ref: "e0",
				snapshotId: refreshed.value.snapshotId,
			});
			expect(staleRef.status).toBe(400);
			expect(staleRef.value.code).toBe("unknown-ref");
			expect(driver.performed).toHaveLength(performed);
			await routeDeps.pool.closeAll();
		});

		test("a failed post-action observation preserves the action and requires a snapshot", async () => {
			const worktree = fixture();
			const driver = createFakeDriver();
			const routeDeps = deps(worktree, driver);
			await call(routeDeps, AGENT_BROWSER_OPEN_PATH, {
				url: "http://app.local/",
			});
			await call(routeDeps, AGENT_BROWSER_SNAPSHOT_PATH);
			driver.failNextSnapshot();
			const clicked = await call(routeDeps, AGENT_BROWSER_ACTION_PATH, {
				action: "click",
				ref: "e1",
			});
			expect(clicked.status).toBe(200);
			expect(driver.performed).toEqual(["click:ref=e1"]);
			expect(clicked.value.snapshotId).toBeUndefined();
			expect(clicked.value.snapshotRequired).toBe(true);
			expect(clicked.value.observation).toContain(
				"post-action snapshot failed",
			);
			expect(clicked.value.changed).toBe(false);
			const refused = await call(routeDeps, AGENT_BROWSER_ACTION_PATH, {
				action: "click",
				ref: "e1",
			});
			expect(refused.status).toBe(409);
			expect(refused.value.code).toBe("snapshot-required");
			expect(driver.performed).toEqual(["click:ref=e1"]);
			await routeDeps.pool.closeAll();
		});

		test("wait and script can observe in one call; a script without observe does not snapshot", async () => {
			const worktree = fixture();
			const driver = createFakeDriver();
			const routeDeps = deps(worktree, driver);
			await call(routeDeps, AGENT_BROWSER_OPEN_PATH, {
				url: "http://app.local/",
			});
			await call(routeDeps, AGENT_BROWSER_SNAPSHOT_PATH);
			driver.queueSnapshot(
				[
					'- heading "Fake" [level=1] [ref=e0]',
					'- button "Save" [ref=e1]',
					'- textbox "Name" [ref=e2]',
					'- link "Home" [ref=e3]',
					'- text "Ready" [ref=e4]',
				].join("\n"),
			);
			const waited = await call(routeDeps, AGENT_BROWSER_WAIT_PATH, {
				observe: true,
			});
			expect(waited.status).toBe(200);
			expect(waited.value.observation).toContain("changed: +1 -0 ~0");
			expect(waited.value.snapshotId).toBeString();
			expect(waited.value.timing).toMatchObject({ changed: true });
			driver.queueSnapshot(
				[
					'- heading "Fake" [level=1] [ref=e0]',
					'- button "Save" [ref=e1]',
					'- textbox "Name" [ref=e2]',
					'- link "Home" [ref=e3]',
					'- text "Ready" [ref=e4]',
					'- text "Still ready" [ref=e5]',
				].join("\n"),
			);
			const scripted = await call(routeDeps, AGENT_BROWSER_SCRIPT_PATH, {
				code: "return 1;",
				observe: true,
			});
			expect(scripted.status).toBe(200);
			expect(scripted.value.observation).toContain("changed: +1 -0 ~0");
			expect(scripted.value.snapshotId).toBeString();
			const requests = driver.snapshotRequests.length;
			const noObserve = await call(routeDeps, AGENT_BROWSER_SCRIPT_PATH, {
				code: "return 2;",
			});
			expect(noObserve.value.observation).toBeUndefined();
			expect(driver.snapshotRequests).toHaveLength(requests);
			expect(noObserve.value.timing).toMatchObject({ changed: false });
			await routeDeps.pool.closeAll();
		});

		test("a navigation short-circuits the delta and asks for a new snapshot", async () => {
			const worktree = fixture();
			const driver = createFakeDriver();
			const routeDeps = deps(worktree, driver);
			await call(routeDeps, AGENT_BROWSER_OPEN_PATH, {
				url: "http://app.local/",
			});
			await call(routeDeps, AGENT_BROWSER_SNAPSHOT_PATH);
			const scripted = await call(routeDeps, AGENT_BROWSER_SCRIPT_PATH, {
				code: "await page.goto('http://app.local/next');\nreturn 1;",
				observe: true,
			});
			expect(scripted.status).toBe(200);
			expect(scripted.value.observation).toContain(
				"navigated to a new document",
			);
			expect(scripted.value.snapshotRequired).toBe(true);
			expect(scripted.value.delta).toBeUndefined();
			expect(scripted.value.snapshotId).toBeString();
			await routeDeps.pool.closeAll();
		});

		test("telemetry is value-free and records a refusal code", async () => {
			const worktree = fixture();
			const driver = createFakeDriver();
			const events: Array<Record<string, unknown>> = [];
			const routeDeps = {
				...deps(worktree, driver),
				telemetry: (event: unknown) =>
					events.push(event as Record<string, unknown>),
			};
			await call(routeDeps, AGENT_BROWSER_OPEN_PATH, {
				url: "http://app.local/?token=secret",
			});
			await call(routeDeps, AGENT_BROWSER_SNAPSHOT_PATH);
			await call(routeDeps, AGENT_BROWSER_ACTION_PATH, {
				action: "click",
				ref: "e1",
			});
			const old = await call(routeDeps, AGENT_BROWSER_ACTION_PATH, {
				action: "click",
				ref: "e1",
				snapshotId: "s-old",
			});
			expect(old.status).toBe(409);
			expect(events.map((event) => event.tool)).toContain("snapshot");
			expect(events.map((event) => event.tool)).toContain("click");
			const success = events.find(
				(event) => event.tool === "click" && event.errorCode === undefined,
			);
			expect(success).toMatchObject({
				domain: "browser",
				kind: "browser.tool",
				snapshotRequired: false,
			});
			expect(typeof success?.session).toBe("string");
			const failure = events.find(
				(event) => event.errorCode === "stale-snapshot",
			);
			expect(failure).toMatchObject({ tool: "click" });
			// No page text, URL, query value, credential or observation is in any event.
			const wire = JSON.stringify(events);
			expect(wire).not.toContain("Fake");
			expect(wire).not.toContain("http://");
			expect(wire).not.toContain("token=secret");
			await routeDeps.pool.closeAll();
		});
	});
});

describe("repro spec template", () => {
	test("pins the base URL, imports the real expect and keeps the code", () => {
		const spec = reproSpec("await page.click('#go');", "http://app.local/x");
		expect(spec).toContain('import { test, expect } from "@playwright/test";');
		expect(spec).toContain('const baseURL = "http://app.local/x";');
		expect(spec).toContain("await page.click('#go');");
		expect(spec).toContain("await page.goto(baseURL);");
	});
});

/** Every regular file under a directory, or nothing when it does not exist. */
function filesUnder(directory: string): string[] {
	let entries: fs.Dirent[];
	try {
		entries = fs.readdirSync(directory, { withFileTypes: true });
	} catch {
		return [];
	}
	const files: string[] = [];
	for (const entry of entries) {
		const full = path.join(directory, entry.name);
		if (entry.isDirectory()) files.push(...filesUnder(full));
		else files.push(full);
	}
	return files;
}
