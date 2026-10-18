// Redaction and URL sanitizing of stage browser replies
// (`add-stage-testing-foundation`, tasks 4.2-4.3).
//
// Two independent mechanisms guard one rule — a credential never reaches a tool
// result, a log line or an evidence file:
//
// * the shared redactor replaces every configuration `.env` value, in plain and
//   in URL-encoded form, anywhere in a reply; and
// * the URL sanitizer drops a token-like query parameter and an opaque fragment
//   from every URL-shaped string, so an OAuth `code` or an implicit-flow
//   `#access_token` cannot ride out inside a URL the redactor has never seen.
//
// Both are exercised through the real browser route, because the point is what
// comes back from a call, not what one helper returns in isolation.
// biome-ignore-all lint/suspicious/noTemplateCurlyInString: this file asserts the literal `${VARIABLE}` reference syntax, so every occurrence is intentional fixture text, not a template placeholder.
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
	sanitizeUrlsIn,
} from "../src/server/browser/routes.ts";
import { listEvidence } from "../src/server/evidence/store.ts";
import {
	AGENT_BROWSER_ACTION_PATH,
	AGENT_BROWSER_CONSOLE_PATH,
	AGENT_BROWSER_OPEN_PATH,
	AGENT_BROWSER_RECORD_PATH,
	AGENT_BROWSER_SCREENSHOT_PATH,
	AGENT_BROWSER_SCRIPT_PATH,
} from "../src/server/protocol.ts";
import { stagePaths } from "../src/server/stages/catalog.ts";
import { DEFAULT_BROWSER_VIEWPORT } from "../src/workflow/effects.ts";
import { workflowEvidenceScope } from "../src/workflow/runtime/evidence-store.ts";

const OWNER = "workflow:wf-redaction";
/** A password whose URL-encoded form differs from its plain form, so the two
 * redaction paths are distinguishable. */
const PASSWORD = "P@ss w0rd/42%";
const PASSWORD_ENCODED = encodeURIComponent(PASSWORD);
/** A real WebM header: the evidence store checks the content's own magic bytes,
 * so a kept recording needs them to be storable at all. */
const WEBM = new Uint8Array([0x1a, 0x45, 0xdf, 0xa3, 0x00, 0x00, 0x00, 0x00]);

function configRoot(): string {
	const configDir = fs.mkdtempSync(path.join(os.tmpdir(), "stage-redaction-"));
	const defsDir = stagePaths(configDir).defsDir;
	fs.mkdirSync(defsDir, { recursive: true });
	fs.writeFileSync(
		path.join(defsDir, "grid-int.json"),
		`${JSON.stringify(
			{
				ident: "grid-int",
				displayName: "Grid integration",
				environment: "integration",
				system: "grid",
				access: "read-only",
				apps: {
					web: {
						label: "Grid web",
						url: "https://grid-int.example.test/",
						kind: "ui",
						roles: {
							clerk: {
								login: "web-form",
								password: "${GRID_INT_CLERK_PASSWORD}",
							},
						},
					},
				},
				logins: {
					"web-form": {
						kind: "form",
						steps: [
							{ fields: [{ credential: "password", label: "Password" }] },
						],
					},
				},
			},
			null,
			2,
		)}\n`,
	);
	fs.writeFileSync(
		path.join(configDir, ".env"),
		`GRID_INT_CLERK_PASSWORD="${PASSWORD}"\n`,
	);
	return configDir;
}

function build(
	configDir: string,
	driver: ReturnType<typeof createFakeDriver>,
): BrowserRouteDeps & { readonly worktree: string } {
	const worktree = fs.mkdtempSync(
		path.join(os.tmpdir(), "stage-redaction-wt-"),
	);
	const chrome = path.join(worktree, "fake-chrome");
	fs.writeFileSync(chrome, "#!/bin/sh\n");
	const installer = new BrowserInstaller({
		configDir: path.join(worktree, "config"),
		chromeCandidates: [chrome],
	});
	const pool = new BrowserPool({
		driver,
		launch: () => installer.resolveLaunch(),
		maxSessions: () => 2,
		idleTtlMs: () => 900_000,
	});
	return {
		installer,
		pool,
		configDir,
		worktree,
		// A recording (and an evidence write) belongs to the workflow's own store:
		// the run is located without the engine, as the recording tests do.
		locate: (workflowId: string) =>
			workflowId === "wf-redaction"
				? { workflowId, worktree, definitionId: "core" }
				: undefined,
		settings: () => ({
			maxSessions: 2,
			idleTtlMs: 900_000,
			viewport: DEFAULT_BROWSER_VIEWPORT,
		}),
	};
}

async function call(
	deps: BrowserRouteDeps,
	routePath: string,
	body: unknown,
): Promise<{ status: number; text: string }> {
	const url = `http://127.0.0.1:4050${routePath}`;
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
	return { status: response.status, text: await response.text() };
}

describe("URL sanitizing", () => {
	test("a token-like query parameter and an opaque fragment never survive a reported URL", () => {
		const sanitized = sanitizeUrlsIn({
			// The whole point: a URL an application itself produced.
			redirect:
				"https://login.example.test/callback?code=abc123&state=xyz&tenant=acme#access_token=token-value",
			fragment: "https://app.example.test/#code=secret-code",
			// A plain anchor is navigation, not a secret.
			anchor: "https://app.example.test/docs#install",
			// A parameter whose value is empty is left alone: nothing is hidden.
			empty: "https://app.example.test/callback?code=",
			nested: { list: ["https://app.example.test/?sessionId=abc"] },
			// The short names a session or a signature travels under, on top of the
			// OAuth vocabulary: each is a capability in a query string.
			session: "https://app.example.test/?sid=abc123",
			signature: "https://app.example.test/asset.png?sig=deadbeef",
			fullSignature: "https://app.example.test/asset.png?signature=deadbeef",
			// Not a URL at all: returned unchanged, byte for byte.
			plain: "no url here",
			number: 7,
		}) as Record<string, unknown>;
		expect(sanitized.redirect).toBe(
			"https://login.example.test/callback?code=redacted&state=redacted&tenant=acme#redacted",
		);
		expect(sanitized.fragment).toBe("https://app.example.test/#redacted");
		expect(sanitized.anchor).toBe("https://app.example.test/docs#install");
		expect(sanitized.empty).toBe("https://app.example.test/callback?code=");
		expect(sanitized.nested).toEqual({
			list: ["https://app.example.test/?sessionId=redacted"],
		});
		expect(sanitized.session).toBe("https://app.example.test/?sid=redacted");
		expect(sanitized.signature).toBe(
			"https://app.example.test/asset.png?sig=redacted",
		);
		expect(sanitized.fullSignature).toBe(
			"https://app.example.test/asset.png?signature=redacted",
		);
		expect(sanitized.plain).toBe("no url here");
		expect(sanitized.number).toBe(7);
	});
});

describe("stage reply redaction", () => {
	test("a `.env` value in page text is redacted, in plain and URL-encoded form", async () => {
		// The page itself carries the credential, as an app that echoes an
		// environment variable back into its own HTML does.
		const configDir = configRoot();
		const deps = build(
			configDir,
			createFakeDriver({
				content: `<html><body><p>connection failed for ${PASSWORD}</p><a href="https://grid-int.example.test/echo?q=${PASSWORD_ENCODED}">retry</a></body></html>`,
			}),
		);
		await call(deps, AGENT_BROWSER_OPEN_PATH, {
			stage: "grid-int",
			stageApp: "web",
		});

		const script = await call(deps, AGENT_BROWSER_SCRIPT_PATH, {
			code: "return await page.content();",
		});
		expect(script.status).toBe(200);
		expect(script.text).not.toContain(PASSWORD);
		expect(script.text).not.toContain(PASSWORD_ENCODED);
		// The name of the variable is what a reader sees instead — the same marker
		// every environment reply uses.
		expect(script.text).toContain("«redacted:GRID_INT_CLERK_PASSWORD»");
		expect(script.text).toContain(
			"q=«redacted:GRID_INT_CLERK_PASSWORD:url-encoded»",
		);
		await deps.pool.closeAll();
	});

	test("a credential the script reads back out of the page is redacted", async () => {
		const configDir = configRoot();
		const deps = build(configDir, createFakeDriver());
		await call(deps, AGENT_BROWSER_OPEN_PATH, {
			stage: "grid-int",
			stageApp: "web",
		});
		const filled = await call(deps, AGENT_BROWSER_ACTION_PATH, {
			action: "fill",
			selector: "input[name=password]",
			credential: { app: "web", role: "clerk", field: "password" },
		});
		expect(filled.status).toBe(200);

		// The value is in the field; a script that reads it back out gets the
		// marker, not the credential.
		const script = await call(deps, AGENT_BROWSER_SCRIPT_PATH, {
			code: "return await page.inputValue('input[name=password]');",
		});
		expect(script.status).toBe(200);
		expect(script.text).not.toContain(PASSWORD);
		expect(script.text).toContain("«redacted:GRID_INT_CLERK_PASSWORD»");
		await deps.pool.closeAll();
	});

	test("a console line the page logged with the value comes back redacted", async () => {
		const configDir = configRoot();
		const driver = createFakeDriver();
		const deps = build(configDir, driver);
		await call(deps, AGENT_BROWSER_OPEN_PATH, {
			stage: "grid-int",
			stageApp: "web",
		});
		// A failing app that logs its own configuration is the usual source of a
		// leaked value.
		driver.lastPage()?.emitConsole({
			type: "error",
			text: `POST /login failed with password=${PASSWORD}`,
		});
		const console = await call(deps, AGENT_BROWSER_CONSOLE_PATH, {});
		expect(console.status).toBe(200);
		expect(console.text).toContain("POST /login failed with password=");
		expect(console.text).not.toContain(PASSWORD);
		expect(console.text).toContain("redacted:GRID_INT_CLERK_PASSWORD");
		await deps.pool.closeAll();
	});

	test("a callback URL's token query and fragment never survive a reply", async () => {
		const configDir = configRoot();
		const deps = build(configDir, createFakeDriver());
		await call(deps, AGENT_BROWSER_OPEN_PATH, {
			stage: "grid-int",
			stageApp: "web",
		});
		// A URL the page itself handed back, as reading a link or a redirect out of
		// page text does. Its one-time code names no configured value, so only the
		// URL rules can catch it — and the fragment is opaque by nature.
		const script = await call(deps, AGENT_BROWSER_SCRIPT_PATH, {
			code: `return "https://login.example.test/callback?code=one-time-code&tenant=acme#access_token=implicit-token";`,
		});
		expect(script.status).toBe(200);
		expect(script.text).not.toContain("one-time-code");
		expect(script.text).not.toContain("implicit-token");
		expect(script.text).toContain("code=redacted");
		// A parameter that is not a token, and the tenant it names, are still there:
		// the sanitizer hides secrets, it does not blind the caller.
		expect(script.text).toContain("tenant=acme");
		await deps.pool.closeAll();
	});

	test("a refusal reports origin and path, never a query or a fragment", async () => {
		const configDir = configRoot();
		const deps = build(configDir, createFakeDriver());
		await call(deps, AGENT_BROWSER_OPEN_PATH, {
			stage: "grid-int",
			stageApp: "web",
		});
		const refused = await call(deps, AGENT_BROWSER_OPEN_PATH, {
			url: "https://evil.example.test/harvest?code=leak-me&token=also-secret#frag",
		});
		expect(refused.status).toBe(403);
		expect(refused.text).toContain("https://evil.example.test/harvest");
		expect(refused.text).not.toContain("leak-me");
		expect(refused.text).not.toContain("also-secret");
		expect(refused.text).not.toContain("#frag");
		await deps.pool.closeAll();
	});

	test("an evidence entry stores no token in its URL or in its default caption", async () => {
		// A capability in the session's own URL — an OIDC callback's one-time code —
		// plus an evidence write: the reply is sanitized, so a raw URL in the stored
		// manifest would be a leak the tool result cannot even show.
		const configDir = configRoot();
		const deps = build(configDir, createFakeDriver({ video: WEBM }));
		await call(deps, AGENT_BROWSER_OPEN_PATH, {
			stage: "grid-int",
			stageApp: "web",
		});
		const navigated = await call(deps, AGENT_BROWSER_SCRIPT_PATH, {
			code: `return await page.goto("https://grid-int.example.test/callback?code=one-time-code&state=xyz");`,
		});
		expect(navigated.status).toBe(200);

		const shot = await call(deps, AGENT_BROWSER_SCREENSHOT_PATH, {
			evidence: true,
		});
		expect(shot.status).toBe(200);
		expect(
			(JSON.parse(shot.text) as { value: { evidence: unknown } }).value
				.evidence,
		).toMatchObject({ kind: "screenshot" });
		expect(shot.text).not.toContain("one-time-code");

		// One recording, kept: its entry carries the sanitized URL and the default
		// caption of both the video and its poster frame.
		await call(deps, AGENT_BROWSER_RECORD_PATH, { action: "start" });
		const kept = await call(deps, AGENT_BROWSER_RECORD_PATH, {
			action: "stop",
			keep: true,
		});
		expect(kept.status).toBe(200);

		const scope = workflowEvidenceScope({
			workflowId: "wf-redaction",
			worktree: deps.worktree,
			definitionId: "core",
		});
		const entries = listEvidence(scope).entries;
		// The screenshot, the kept video, and the video's own final frame, which the
		// store attaches as an image entry of its own.
		expect(entries.map((entry) => entry.kind).sort()).toEqual([
			"screenshot",
			"screenshot",
			"video",
		]);
		expect(
			entries.filter((entry) => entry.caption.includes("final frame")),
		).toHaveLength(1);
		for (const entry of entries) {
			expect(entry.url).toContain("code=redacted");
			expect(entry.url).not.toContain("one-time-code");
			expect(entry.url).not.toContain("state=xyz");
			expect(entry.caption).toContain("code=redacted");
			expect(entry.caption).not.toContain("one-time-code");
		}
		await deps.pool.closeAll();
	});

	test("a saved repro spec is built from the sanitized URL and redacted before storage", async () => {
		// A saved script is a file on disk that outlives the call that made it, so
		// what the reply cannot show must not be in the file either: the spec is
		// built from the *sanitized* URL and the whole text passes the redactor
		// before anything is attached.
		const configDir = configRoot();
		const deps = build(configDir, createFakeDriver());
		await call(deps, AGENT_BROWSER_OPEN_PATH, {
			stage: "grid-int",
			stageApp: "web",
		});
		const saved = await call(deps, AGENT_BROWSER_SCRIPT_PATH, {
			code: `await page.goto("https://grid-int.example.test/callback?code=one-time-code");\nawait page.fill("#pw", ${JSON.stringify(PASSWORD)});`,
			save: true,
		});
		expect(saved.status).toBe(200);
		expect(saved.text).not.toContain(PASSWORD);
		expect(saved.text).not.toContain("one-time-code");

		const scope = workflowEvidenceScope({
			workflowId: "wf-redaction",
			worktree: deps.worktree,
			definitionId: "core",
		});
		const entry = listEvidence(scope).entries.find(
			(item) => item.kind === "script",
		);
		if (!entry) throw new Error("no script evidence was attached");
		const text = fs.readFileSync(path.join(scope.root, entry.file), "utf8");
		// The URL the script ran on is the sanitized one, in the file exactly as in
		// the reply.
		expect(text).toContain(
			'const baseURL = "https://grid-int.example.test/callback?code=redacted";',
		);
		expect(text).not.toContain("one-time-code");
		// And the credential the script typed is a marker, not a value.
		expect(text).toContain("«redacted:GRID_INT_CLERK_PASSWORD»");
		expect(text).not.toContain(PASSWORD);
		await deps.pool.closeAll();
	});

	test("a reply from a configuration with no `.env` is left byte-identical", async () => {
		const configDir = configRoot();
		fs.rmSync(path.join(configDir, ".env"));
		const deps = build(configDir, createFakeDriver());
		await call(deps, AGENT_BROWSER_OPEN_PATH, {
			stage: "grid-int",
			stageApp: "web",
		});
		const script = await call(deps, AGENT_BROWSER_SCRIPT_PATH, {
			code: "return { text: 'nothing to hide here', n: 1 };",
		});
		expect(script.status).toBe(200);
		expect(script.text).toContain("nothing to hide here");
		await deps.pool.closeAll();
	});
});
