// Stage flow evidence (`add-stage-flow-evidence`, tasks 2.1-2.3): the step
// journal and the server-side wait as the browser routes expose them, plus the
// two limits the flow test is held to.
//
// Everything runs against the fake driver and a throwaway configuration root, so
// no browser is launched and no real stage is touched.
// biome-ignore-all lint/suspicious/noTemplateCurlyInString: the stage definition names its credential references in the literal `${VARIABLE}` syntax, so every occurrence is intentional fixture text. The one real network
// endpoint is a fake Mailpit the test serves itself: the mail wait is the only
// condition that talks to the stage's own infrastructure.
import { describe, expect, spyOn, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Schema } from "effect";
import { stageJournalSchema } from "../src/contracts/stages.ts";
import {
	createFakeDriver,
	type FakeContext,
} from "../src/server/browser/fake-driver.ts";
import { BrowserInstaller } from "../src/server/browser/install.ts";
import { BrowserPool } from "../src/server/browser/pool.ts";
import {
	type BrowserRouteDeps,
	handleBrowserRoute,
	stageWaitTiming,
} from "../src/server/browser/routes.ts";
import type { BrowserSession } from "../src/server/browser/session.ts";
import {
	appendStageJournalEntry,
	hasStageJournal,
	readStageJournal,
	STAGE_FLOW_FILE,
	writeStageFlowPage,
} from "../src/server/evidence/journal.ts";
import { listEvidence } from "../src/server/evidence/store.ts";
import {
	AGENT_BROWSER_OPEN_PATH,
	AGENT_BROWSER_RECORD_PATH,
	AGENT_BROWSER_SCREENSHOT_PATH,
	AGENT_BROWSER_STAGE_JOURNAL_PATH,
	AGENT_BROWSER_STAGE_STEP_PATH,
	AGENT_BROWSER_STAGE_WAIT_PATH,
} from "../src/server/protocol.ts";
import { stagePaths } from "../src/server/stages/catalog.ts";
import { SESSION_STORAGE_READ_SCRIPT } from "../src/server/stages/identity-cache.ts";
import { StageUsageRegistry } from "../src/server/stages/limits.ts";
import { DEFAULT_BROWSER_VIEWPORT } from "../src/workflow/effects.ts";
import {
	removeWorkflowEvidence,
	workflowEvidenceScope,
} from "../src/workflow/runtime/evidence-store.ts";

const OWNER = "workflow:wf-flow";
const PASSWORD_SENTINEL = "flow-pw-sentinel-91ab";
const USERNAME_SENTINEL = "flow-user-sentinel";
const APP_URL = "https://grid-flow.example.test/";
/** A URL whose query carries a token: the journal must never hold it. */
const TOKEN_URL = `${APP_URL}dash?token=leak-me`;
/** A kept recording has to be recognised as WebM, so the fake driver serves the
 * format's own leading bytes rather than a placeholder string. */
const WEBM = new Uint8Array([0x1a, 0x45, 0xdf, 0xa3, 0x00, 0x00, 0x00, 0x00]);
const JPEG = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10]);

/** One throwaway configuration root: a UI app with a clerk role, and a mail
 * catcher pointing at the caller's fake Mailpit. */
function configRoot(
	options: {
		readonly mailUrl?: string;
		/** Declare the mail app under a configured ident (`apps.mail.app`), which is
		 * how a stage app links a system the configuration already knows. */
		readonly mailAlias?: boolean;
	} = {},
): string {
	const configDir = fs.mkdtempSync(path.join(os.tmpdir(), "stage-flow-"));
	const defsDir = stagePaths(configDir).defsDir;
	fs.mkdirSync(defsDir, { recursive: true });
	const definition = {
		ident: "grid-flow",
		displayName: "Grid flow",
		environment: "integration",
		system: "grid",
		access: "read-only",
		apps: {
			web: {
				label: "Grid web",
				url: APP_URL,
				kind: "ui",
				roles: {
					clerk: {
						login: "web-form",
						username: "${GRID_FLOW_CLERK_USERNAME}",
						password: "${GRID_FLOW_CLERK_PASSWORD}",
					},
				},
			},
			...(options.mailUrl === undefined
				? {}
				: {
						mail: {
							label: "Grid mail",
							url: options.mailUrl,
							kind: "mail-catcher",
							api: "mailpit",
							...(options.mailAlias ? { app: "mailpit" } : {}),
						},
					}),
		},
		logins: {
			"web-form": {
				kind: "form",
				origin: APP_URL,
				steps: [
					{
						fields: [{ credential: "username", label: "User" }],
						submit: { role: "button", name: "Next" },
					},
					{ fields: [{ credential: "password", label: "Password" }] },
				],
				// The login is complete once the page is back on the app's own origin:
				// the fake driver reports the URL it navigated to.
				success: { url: `${APP_URL}*` },
			},
		},
		limits: {
			// Two sessions, so the mail catcher and the app under test can both be
			// open: a flow's mailbox is an app of its own.
			maxSessions: 2,
			maxActionsPerMinute: 600,
			maxWaitSeconds: 30,
			maxScreenshots: 2,
			maxRecordingMinutes: 1,
		},
	};
	fs.writeFileSync(
		path.join(defsDir, "grid-flow.json"),
		`${JSON.stringify(definition, null, 2)}\n`,
	);
	// `apps.mail.app` may only name an application the configuration knows, so the
	// alias fixture declares the ident under `apps/definitions`.
	if (options.mailAlias === true) {
		const appsDir = path.join(configDir, "apps", "definitions");
		fs.mkdirSync(appsDir, { recursive: true });
		fs.writeFileSync(
			path.join(appsDir, "mailpit.json"),
			`${JSON.stringify({ ident: "mailpit", displayName: "Mailpit", appType: "APP" }, null, 2)}\n`,
		);
	}
	fs.writeFileSync(
		path.join(configDir, ".env"),
		[
			`GRID_FLOW_CLERK_USERNAME=${USERNAME_SENTINEL}`,
			`GRID_FLOW_CLERK_PASSWORD=${PASSWORD_SENTINEL}`,
			"",
		].join("\n"),
	);
	return configDir;
}

function build(
	configDir: string,
	driver: ReturnType<typeof createFakeDriver>,
): BrowserRouteDeps & {
	readonly pool: BrowserPool;
	readonly worktree: string;
} {
	const worktree = fs.mkdtempSync(path.join(os.tmpdir(), "stage-flow-tree-"));
	const chrome = path.join(worktree, "fake-chrome");
	fs.writeFileSync(chrome, "#!/bin/sh\n");
	const installer = new BrowserInstaller({
		configDir: path.join(worktree, "config"),
		chromeCandidates: [chrome],
		display: () => true,
	});
	let clock = 1_000_000;
	const pool = new BrowserPool({
		driver,
		launch: (launchOptions) => installer.resolveLaunch(launchOptions),
		maxSessions: () => 4,
		idleTtlMs: () => 900_000,
	});
	return {
		installer,
		pool,
		configDir,
		worktree,
		settings: () => ({
			maxSessions: 4,
			idleTtlMs: 900_000,
			viewport: DEFAULT_BROWSER_VIEWPORT,
		}),
		stages: new StageUsageRegistry({
			now: () => clock,
			stageSessions: (owner, stage) => pool.stageSessions(owner, stage),
		}),
		locate: (workflowId: string) =>
			workflowId === "wf-flow"
				? { workflowId, worktree, definitionId: "core" }
				: undefined,
		// The clock a `stage_wait` is bounded by, and the one a step's time is
		// taken from: one second per call, so a wait's elapsed time is observable
		// without sleeping through it.
		now: () => (clock += 1_000),
	};
}

type Call = {
	status: number;
	value: Record<string, unknown>;
	text: string;
};

async function call(
	deps: BrowserRouteDeps,
	routePath: string,
	body: unknown = {},
	owner = OWNER,
): Promise<Call> {
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

async function openStage(
	deps: BrowserRouteDeps,
	body: Record<string, unknown> = {},
): Promise<Call> {
	return await call(deps, AGENT_BROWSER_OPEN_PATH, {
		stage: "grid-flow",
		stageApp: "web",
		...body,
	});
}

/** The stage usage registry of one fixture: the routes' own, so a test can spend
 * a recording budget or observe a counted action without standing one in. */
function usageOf(deps: BrowserRouteDeps): StageUsageRegistry {
	if (!deps.stages) throw new Error("the fixture attached no stage registry");
	return deps.stages;
}

function sessionOf(deps: BrowserRouteDeps, name = "default"): BrowserSession {
	const session = deps.pool.session(OWNER, name);
	if (!session) throw new Error(`no session ${name}`);
	return session;
}

/** The workflow's evidence directory, located exactly like the server does. */
function scopeOf(deps: BrowserRouteDeps & { readonly worktree: string }) {
	return workflowEvidenceScope({
		workflowId: "wf-flow",
		worktree: deps.worktree,
		definitionId: "core",
	});
}

describe("stage wait timing", () => {
	test("the timeout is clamped to the stage's own bound and the interval to five seconds", () => {
		// A request longer than the stage allows is cut to the stage's bound: a wait
		// can never outlast what an operator declared.
		expect(
			stageWaitTiming({ maxWaitSeconds: 30 }, { timeoutSeconds: 600 }),
		).toEqual({ timeoutMs: 30_000, intervalMs: 5_000, timeoutSeconds: 30 });
		// A tighter poll than the floor is raised to it: a flow is observed, not a
		// page hammered.
		expect(
			stageWaitTiming({ maxWaitSeconds: 30 }, { intervalSeconds: 1 })
				.intervalMs,
		).toBe(5_000);
		// A longer one is capped at the ceiling.
		expect(
			stageWaitTiming({ maxWaitSeconds: 600 }, { intervalSeconds: 120 })
				.intervalMs,
		).toBe(60_000);
		// A stage that declares nothing gets the defaults.
		expect(stageWaitTiming(undefined, {})).toEqual({
			timeoutMs: 600_000,
			intervalMs: 5_000,
			timeoutSeconds: 600,
		});
		// A subtype of a second is a single second, never zero.
		expect(
			stageWaitTiming({ maxWaitSeconds: 30 }, { timeoutSeconds: 0.4 })
				.timeoutSeconds,
		).toBe(1);
	});
});

describe("the stage step journal over the browser routes", () => {
	test("a step carries the server's own facts and the sanitized URL", async () => {
		const deps = build(configRoot(), createFakeDriver());
		// A URL whose query carries a token, which the session keeps and the journal
		// must not.
		await openStage(deps, { path: "/dash?token=leak-me" });
		expect(sessionOf(deps).url).toBe(TOKEN_URL);

		const step = await call(deps, AGENT_BROWSER_STAGE_STEP_PATH, {
			label: "the dashboard opened",
			expected: "the balance is visible",
			observed: "the balance is visible",
			captures: { balance: "0.00 EUR" },
		});
		expect(step.status).toBe(200);
		const entry = step.value.step as Record<string, unknown>;
		expect(entry.seq).toBe(1);
		expect(entry.app).toBe("web");
		expect(entry.session).toBe("default");
		expect(typeof entry.at).toBe("string");
		expect(entry.label).toBe("the dashboard opened");
		// The journal outlives the call, so the URL it records is the sanitized one.
		expect(entry.url).toBe(`${APP_URL}dash?token=redacted`);
		expect(JSON.stringify(entry)).not.toContain("leak-me");

		// The write is a file beside the manifest, and the read answers it back.
		const scope = scopeOf(deps);
		expect(readStageJournal(scope).map((each) => each.seq)).toEqual([1]);
		const read = await call(deps, AGENT_BROWSER_STAGE_JOURNAL_PATH, {});
		expect(read.status).toBe(200);
		const journal = read.value as Record<string, unknown>;
		expect(journal.workflowId).toBe("wf-flow");
		expect(journal.flowPage).toBe(STAGE_FLOW_FILE);
		expect(
			(journal.entries as Array<Record<string, unknown>>).map(
				(each) => each.label,
			),
		).toEqual(["the dashboard opened"]);
		// A second step continues the sequence, and a narrowed read answers only
		// the matching steps.
		await call(deps, AGENT_BROWSER_STAGE_STEP_PATH, {
			label: "the cart opened",
		});
		const narrowed = await call(deps, AGENT_BROWSER_STAGE_JOURNAL_PATH, {
			limit: 1,
		});
		expect(
			(narrowed.value.entries as Array<Record<string, unknown>>).map(
				(each) => each.label,
			),
		).toEqual(["the cart opened"]);
		// A workflow this server has no evidence store for has no journal to read.
		const unknown = await call(
			deps,
			AGENT_BROWSER_STAGE_JOURNAL_PATH,
			{},
			"workflow:wf-other",
		);
		expect(unknown.status).toBe(404);
		expect(unknown.value.code).toBe("evidence-missing");
		await deps.pool.closeAll();
	});

	test("the journal is masked with the configuration's own secrets", async () => {
		const deps = build(configRoot(), createFakeDriver());
		await openStage(deps);
		const step = await call(deps, AGENT_BROWSER_STAGE_STEP_PATH, {
			label: `signed in with ${PASSWORD_SENTINEL}`,
			observed: `the form shows ${PASSWORD_SENTINEL}`,
		});
		expect(step.status).toBe(200);
		// Nothing an agent, an operator or the flow page can read carries the
		// credential, and the refusal-free write is the recorded one.
		expect(step.text).not.toContain(PASSWORD_SENTINEL);
		const journal = fs.readFileSync(
			path.join(scopeOf(deps).root, "stage-journal.jsonl"),
			"utf8",
		);
		expect(journal).not.toContain(PASSWORD_SENTINEL);
		// What a reader sees instead names the variable, never the value.
		expect(journal).toContain("redacted:GRID_FLOW_CLERK_PASSWORD");
		const page = fs.readFileSync(
			path.join(scopeOf(deps).root, STAGE_FLOW_FILE),
			"utf8",
		);
		expect(page).not.toContain(PASSWORD_SENTINEL);
		await deps.pool.closeAll();
	});

	test("a step that names evidence the manifest does not hold is refused", async () => {
		const deps = build(configRoot(), createFakeDriver());
		await openStage(deps);
		const refused = await call(deps, AGENT_BROWSER_STAGE_STEP_PATH, {
			label: "look at the screenshot",
			evidence: ["01J0NOPE0000000000000000A"],
		});
		expect(refused.status).toBe(404);
		expect(refused.value.code).toBe("evidence-missing");
		// Nothing was written: a refusal must not leave a half step behind.
		expect(hasStageJournal(scopeOf(deps))).toBe(false);
		await deps.pool.closeAll();
	});

	test("a step written while a segment records names its segment and offset", async () => {
		const deps = build(
			configRoot(),
			createFakeDriver({ video: WEBM, screenshot: JPEG }),
		);
		await openStage(deps);
		const started = await call(deps, AGENT_BROWSER_RECORD_PATH, {
			action: "start",
		});
		expect(started.status).toBe(200);
		expect(started.value.segment).toBe(1);

		const step = await call(deps, AGENT_BROWSER_STAGE_STEP_PATH, {
			label: "the cart is empty",
		});
		expect(step.status).toBe(200);
		expect(step.value.segment).toBe(1);
		expect(typeof step.value.offsetMs).toBe("number");

		const stopped = await call(deps, AGENT_BROWSER_RECORD_PATH, {
			action: "stop",
			keep: true,
			caption: "checkout flow",
		});
		expect(stopped.status).toBe(200);
		const video = stopped.value.video as Record<string, unknown>;
		expect(video.kind).toBe("video");
		expect(video.segment).toBe(1);

		// The step learned the kept video's id, and the page links it: a step is
		// seekable in the recording it was written during.
		const [entry] = readStageJournal(scopeOf(deps));
		expect(entry?.video).toBe(String(video.id));
		expect(entry?.segment).toBe(1);
		const page = fs.readFileSync(
			path.join(scopeOf(deps).root, STAGE_FLOW_FILE),
			"utf8",
		);
		expect(page).toContain(`src="${video.file}"`);
		expect(page).toContain(`href="${video.file}#t=`);
		await deps.pool.closeAll();
	});

	test("a second recording is a second segment, numbered by the server", async () => {
		const deps = build(configRoot(), createFakeDriver());
		await openStage(deps);
		const first = await call(deps, AGENT_BROWSER_RECORD_PATH, {
			action: "start",
		});
		expect(first.value.segment).toBe(1);
		// A discarded recording keeps no minutes and still owns its segment number,
		// so the numbers an agent sees are never reused.
		expect(
			(await call(deps, AGENT_BROWSER_RECORD_PATH, { action: "stop" })).status,
		).toBe(200);
		const second = await call(deps, AGENT_BROWSER_RECORD_PATH, {
			action: "start",
		});
		expect(second.value.segment).toBe(2);
		await deps.pool.closeAll();
	});

	test("the stage's recording minutes bound the segment and are spent on keep", async () => {
		const deps = build(configRoot(), createFakeDriver());
		await openStage(deps);
		// Half of the stage's one minute is already kept, so this segment may only
		// run for the remaining thirty seconds.
		usageOf(deps).settleRecording({
			stage: "grid-flow",
			owner: OWNER,
			session: "default",
			keptMs: 30_000,
		});
		const started = await call(deps, AGENT_BROWSER_RECORD_PATH, {
			action: "start",
		});
		expect(started.status).toBe(200);
		expect(sessionOf(deps).recording?.maxMs).toBe(30_000);
		await deps.pool.closeAll();

		// A workflow that spent the whole budget is refused before any page is
		// touched, and the refusal says what to do instead.
		const spent = build(configRoot(), createFakeDriver());
		await openStage(spent);
		usageOf(spent).settleRecording({
			stage: "grid-flow",
			owner: OWNER,
			session: "default",
			keptMs: 60_000,
		});
		const refused = await call(spent, AGENT_BROWSER_RECORD_PATH, {
			action: "start",
		});
		expect(refused.status).toBe(409);
		expect(refused.value.code).toBe("stage-recording-limit");
		expect(refused.text).toContain("stage_step");
		await spent.pool.closeAll();
	});

	test("the recording swap carries the live page's sessionStorage into the segment", async () => {
		const driver = createFakeDriver({
			sessionStorage: JSON.stringify({ token: "session-abc", tab: "1" }),
		});
		const deps = build(configRoot(), driver);
		await openStage(deps);
		const before = sessionOf(deps).context as unknown as FakeContext;
		const started = await call(deps, AGENT_BROWSER_RECORD_PATH, {
			action: "start",
		});
		expect(started.status).toBe(200);
		// The recording context is a new one: `sessionStorage` is not part of a
		// `storageState()` snapshot, so it is seeded by an init script for the
		// page's own origin — and only that origin.
		const after = sessionOf(deps).context as unknown as FakeContext;
		expect(after).not.toBe(before);
		const seed = after.initScripts.find((script) =>
			script.includes("session-abc"),
		);
		expect(seed).toBeDefined();
		expect(seed).toContain("https://grid-flow.example.test");
		expect(seed).not.toContain("evil.example.test");
		// The read the carry is built from is the live document's own.
		expect(SESSION_STORAGE_READ_SCRIPT).toContain("window.sessionStorage");

		// The carry runs the other way too: the recording's page owns the tab state,
		// and closing its context must not cost the flow what it captured.
		const stopped = await call(deps, AGENT_BROWSER_RECORD_PATH, {
			action: "stop",
		});
		expect(stopped.status).toBe(200);
		const restored = sessionOf(deps).context as unknown as FakeContext;
		expect(restored).not.toBe(after);
		const carriedBack = restored.initScripts.find((script) =>
			script.includes("session-abc"),
		);
		expect(carriedBack).toBeDefined();
		expect(carriedBack).toContain("https://grid-flow.example.test");
		await deps.pool.closeAll();
	});

	test("a page that lost its sessionStorage still records, without a seed", async () => {
		const driver = createFakeDriver({ failSessionStorage: true });
		const deps = build(configRoot(), driver);
		await openStage(deps);
		const started = await call(deps, AGENT_BROWSER_RECORD_PATH, {
			action: "start",
		});
		expect(started.status).toBe(200);
		const after = sessionOf(deps).context as unknown as FakeContext;
		expect(after.initScripts.some((script) => script.includes("abc"))).toBe(
			false,
		);
		await deps.pool.closeAll();
	});
});

describe("the stage wait over the browser routes", () => {
	test("a URL condition that already holds answers met on the first poll", async () => {
		const deps = build(configRoot(), createFakeDriver());
		await openStage(deps, { path: "/orders/42" });
		const waited = await call(deps, AGENT_BROWSER_STAGE_WAIT_PATH, {
			until: { url: "*/orders/*" },
		});
		expect(waited.status).toBe(200);
		expect(waited.value.met).toBe(true);
		expect(waited.value.url).toBe(`${APP_URL}orders/42`);
		expect(waited.value.session).toBe("default");
		expect(waited.value.notice).toBeUndefined();
		await deps.pool.closeAll();
	});

	test("a condition that never holds answers once, unmet, with a notice", async () => {
		const deps = build(configRoot(), createFakeDriver());
		await openStage(deps);
		const waited = await call(deps, AGENT_BROWSER_STAGE_WAIT_PATH, {
			until: { text: "the payment cleared" },
			// The stage allows thirty seconds; this asks for one, so the poll ends
			// without waiting the whole bound out.
			timeoutSeconds: 1,
			intervalSeconds: 30,
		});
		expect(waited.status).toBe(200);
		expect(waited.value.met).toBe(false);
		expect(String(waited.value.notice)).toContain("within 1s");
		expect(typeof waited.value.elapsedMs).toBe("number");
		// The session is still usable after an unmet wait: a timeout is an answer,
		// not a failure of the session.
		expect(() => sessionOf(deps)).not.toThrow();
		await deps.pool.closeAll();
	});

	test("a selector condition answers met when the page grows the element", async () => {
		const deps = build(configRoot(), createFakeDriver());
		await openStage(deps);
		// The fake driver answers a `document` expression with the page URL, which is
		// never `true`: a met selector has to be decided by the page, so the session's
		// own evaluate is what the test drives.
		const evaluate = spyOn(sessionOf(deps), "evaluate").mockResolvedValue(true);
		const waited = await call(deps, AGENT_BROWSER_STAGE_WAIT_PATH, {
			until: { selector: "[data-testid='order-total']" },
		});
		expect(waited.status).toBe(200);
		expect(waited.value.met).toBe(true);
		// The answer always names the bound explicitly, so a caller never has to read
		// `!met` as a failure of the session.
		expect(waited.value.timeout).toBe(false);
		expect(waited.value.notice).toBeUndefined();
		// The selector reaches the page quoted and as one element query: an
		// interpolation bug would poll a selector nobody declared.
		const expression = String(evaluate.mock.calls[0]?.[0] ?? "");
		expect(expression).toContain(
			`document.querySelector("[data-testid='order-total']")`,
		);

		// The same condition, not (yet) true: the wait answers unmet at its bound.
		evaluate.mockResolvedValue(false);
		const unmet = await call(deps, AGENT_BROWSER_STAGE_WAIT_PATH, {
			until: { selector: "[data-testid='order-total']" },
			timeoutSeconds: 1,
			intervalSeconds: 30,
		});
		expect(unmet.status).toBe(200);
		expect(unmet.value.met).toBe(false);
		expect(unmet.value.timeout).toBe(true);
		await deps.pool.closeAll();
	});

	test("a text condition answers met when the page grows the text, and unmet while not", async () => {
		const deps = build(configRoot(), createFakeDriver());
		await openStage(deps);
		const evaluate = spyOn(sessionOf(deps), "evaluate").mockResolvedValue(true);
		const waited = await call(deps, AGENT_BROWSER_STAGE_WAIT_PATH, {
			until: { text: "the payment cleared" },
		});
		expect(waited.value.met).toBe(true);
		const expression = String(evaluate.mock.calls[0]?.[0] ?? "");
		expect(expression).toContain(".innerText");
		expect(expression).toContain('.includes("the payment cleared")');

		// A page that throws instead of answering is a condition that does not hold,
		// not a failed wait: the `catch` around the evaluate is what says so.
		evaluate.mockRejectedValue(new Error("execution context was destroyed"));
		const thrown = await call(deps, AGENT_BROWSER_STAGE_WAIT_PATH, {
			until: { text: "the payment cleared" },
			timeoutSeconds: 1,
			intervalSeconds: 30,
		});
		expect(thrown.status).toBe(200);
		expect(thrown.value.met).toBe(false);
		await deps.pool.closeAll();
	});

	test("`reload: true` re-opens the page between polls, and its absence does not", async () => {
		const deps = build(configRoot(), createFakeDriver());
		await openStage(deps);
		const session = sessionOf(deps);
		// Never met: every poll asks the page again, so the reload has to happen
		// between the first and the second.
		spyOn(session, "evaluate").mockResolvedValue(false);
		const goto = spyOn(session, "goto");
		// One poll interval: the wait answers unmet at its bound only after asking
		// the page a second time, and the reload is what stands between the two.
		const reloaded = await call(deps, AGENT_BROWSER_STAGE_WAIT_PATH, {
			until: { text: "the receipt" },
			timeoutSeconds: 6,
			intervalSeconds: 5,
			reload: true,
		});
		expect(reloaded.status).toBe(200);
		expect(reloaded.value.met).toBe(false);
		expect(goto.mock.calls.length).toBeGreaterThan(0);
		expect(String(goto.mock.calls[0]?.[0])).toBe(APP_URL);
		goto.mockClear();

		// Meeting on the first poll reloads nothing: there is no second page to load.
		spyOn(session, "evaluate").mockResolvedValue(true);
		const met = await call(deps, AGENT_BROWSER_STAGE_WAIT_PATH, {
			until: { text: "the receipt" },
			reload: true,
		});
		expect(met.value.met).toBe(true);
		expect(goto.mock.calls.length).toBe(0);
		await deps.pool.closeAll();
		// The poll floor is five real seconds, so crossing it once is this test's cost.
	}, 20_000);

	test("a mail wait reads the stage's mail catcher and answers when the mail lands", async () => {
		const seen: string[] = [];
		const queries: string[] = [];
		const server = Bun.serve({
			port: 0,
			fetch: (request) => {
				const url = new URL(request.url);
				seen.push(url.pathname);
				if (url.pathname !== "/api/v1/search")
					return new Response("not found", { status: 404 });
				const query = url.searchParams.get("query") ?? "";
				queries.push(query);
				// Both terms have to survive, and a spaced subject has to keep its
				// quoting: a wait that lost one of them would match the wrong mail.
				const matches =
					query.includes("to:clerk@grid.example.test") &&
					(!query.includes("subject:") ||
						query.includes('subject:"Your sign-in code"'));
				return Response.json({
					total: matches ? 1 : 0,
					messages: matches ? [{ ID: "m1", Subject: "Your sign-in code" }] : [],
				});
			},
		});
		try {
			const deps = build(
				configRoot({ mailUrl: server.url.href }),
				createFakeDriver(),
			);
			await openStage(deps);
			// The mail catcher is an app of its own: the session has to be on it.
			const wrongApp = await call(deps, AGENT_BROWSER_STAGE_WAIT_PATH, {
				until: { mail: { to: "clerk@grid.example.test" } },
			});
			expect(wrongApp.status).toBe(409);
			expect(wrongApp.value.code).toBe("stage-mail-unsupported");

			const mailbox = await call(deps, AGENT_BROWSER_OPEN_PATH, {
				stage: "grid-flow",
				stageApp: "mail",
				session: "mailbox",
			});
			expect(mailbox.status).toBe(200);
			const waited = await call(deps, AGENT_BROWSER_STAGE_WAIT_PATH, {
				session: "mailbox",
				until: {
					mail: { to: "clerk@grid.example.test", subject: "Your sign-in code" },
				},
			});
			expect(waited.status).toBe(200);
			expect(waited.value.met).toBe(true);
			expect(seen).toContain("/api/v1/search");
			// The search is Mailpit's own syntax: one field prefix per term, and a
			// subject with spaces quoted so it stays a single term.
			expect(queries[0]).toBe(
				'to:clerk@grid.example.test subject:"Your sign-in code"',
			);
			await deps.pool.closeAll();

			// A stage app that names a configured ident is the same application: the
			// session's `app` is then that ident, not the key, and the catcher has to be
			// found by either — otherwise every mail wait on such a stage would refuse
			// `stage-mail-unsupported`.
			const aliased = build(
				configRoot({ mailUrl: server.url.href, mailAlias: true }),
				createFakeDriver(),
			);
			const aliasedMailbox = await call(aliased, AGENT_BROWSER_OPEN_PATH, {
				stage: "grid-flow",
				stageApp: "mail",
				session: "mailbox",
			});
			expect(aliasedMailbox.status).toBe(200);
			expect(sessionOf(aliased, "mailbox").app).toBe("mailpit");
			const aliasedWait = await call(aliased, AGENT_BROWSER_STAGE_WAIT_PATH, {
				session: "mailbox",
				until: { mail: { to: "clerk@grid.example.test" } },
			});
			expect(aliasedWait.status).toBe(200);
			expect(aliasedWait.value.met).toBe(true);
			await aliased.pool.closeAll();
		} finally {
			server.stop(true);
		}
	});

	test("a mail wait on a session without a stage is refused as unsupported", async () => {
		const deps = build(configRoot(), createFakeDriver());
		const opened = await call(deps, AGENT_BROWSER_OPEN_PATH, { url: APP_URL });
		expect(opened.status).toBe(200);
		const waited = await call(deps, AGENT_BROWSER_STAGE_WAIT_PATH, {
			until: { mail: { subject: "anything" } },
		});
		// A stage limit refusal, not a contract error: the request is well formed,
		// the session simply cannot satisfy it.
		expect(waited.status).toBe(409);
		expect(waited.value.code).toBe("stage-mail-unsupported");
		await deps.pool.closeAll();
	});

	test("a wait counts as one stage action, and a read does not", async () => {
		const deps = build(configRoot(), createFakeDriver());
		await openStage(deps);
		const spy = spyOn(usageOf(deps), "countAction");
		await call(deps, AGENT_BROWSER_STAGE_WAIT_PATH, {
			until: { url: "*" },
		});
		expect(spy.mock.calls.length).toBe(1);
		spy.mockClear();
		await call(deps, AGENT_BROWSER_STAGE_JOURNAL_PATH, {});
		expect(spy.mock.calls.length).toBe(0);
		spy.mockRestore();
		await deps.pool.closeAll();
	});
});

describe("screenshot context control and its limit", () => {
	test("`view: false` stores the screenshot and returns no image", async () => {
		const deps = build(configRoot(), createFakeDriver());
		await openStage(deps);
		const shot = await call(deps, AGENT_BROWSER_SCREENSHOT_PATH, {
			evidence: true,
			view: false,
			caption: "the empty cart",
		});
		expect(shot.status).toBe(200);
		// Nothing of the image is in the reply: the model pays for the step, not
		// for the pixels.
		expect(shot.value.base64).toBeUndefined();
		expect(shot.value.bytes).toBeUndefined();
		expect(String(shot.value.notice)).toContain("stored as evidence");
		const entry = shot.value.evidence as Record<string, unknown>;
		expect(entry.kind).toBe("screenshot");
		expect(entry.caption).toBe("the empty cart");
		// The bytes are on disk, which is what the flow page links to.
		const stored = listEvidence(scopeOf(deps)).entries;
		expect(stored.map((each) => each.id)).toEqual([String(entry.id)]);
		await deps.pool.closeAll();
	});

	test("`view: false` without `evidence: true` is refused rather than answering nothing", async () => {
		const deps = build(configRoot(), createFakeDriver());
		await openStage(deps);
		const refused = await call(deps, AGENT_BROWSER_SCREENSHOT_PATH, {
			view: false,
		});
		expect(refused.status).toBe(400);
		expect(refused.value.code).toBe("view-requires-evidence");
		expect(listEvidence(scopeOf(deps)).entries).toEqual([]);
		await deps.pool.closeAll();
	});

	test("a stored screenshot re-renders the flow page, and a viewed one does not", async () => {
		const deps = build(configRoot(), createFakeDriver());
		await openStage(deps);
		await call(deps, AGENT_BROWSER_STAGE_STEP_PATH, {
			label: "the cart loaded",
		});
		const page = path.join(scopeOf(deps).root, STAGE_FLOW_FILE);
		expect(fs.readFileSync(page, "utf8")).toContain("the cart loaded");
		// A page left stale by a hand edit stands in for any render that has to follow
		// a new file: what is asserted is that the page was written again, which a
		// byte-identical rewrite would not show.
		fs.writeFileSync(page, "stale");
		const viewed = await call(deps, AGENT_BROWSER_SCREENSHOT_PATH, {});
		expect(viewed.status).toBe(200);
		expect(fs.readFileSync(page, "utf8")).toBe("stale");
		const kept = await call(deps, AGENT_BROWSER_SCREENSHOT_PATH, {
			evidence: true,
			view: false,
			caption: "the empty cart",
		});
		expect(kept.status).toBe(200);
		expect(fs.readFileSync(page, "utf8")).toContain("the cart loaded");

		// A step that names the screenshot shows its caption on the page, so the file
		// the flow points at is the one the panel counts.
		const id = String((kept.value.evidence as Record<string, unknown>).id);
		const step = await call(deps, AGENT_BROWSER_STAGE_STEP_PATH, {
			label: "the cart is empty",
			evidence: [id],
		});
		expect(step.status).toBe(200);
		expect(fs.readFileSync(page, "utf8")).toContain("the empty cart");
		await deps.pool.closeAll();
	});

	test("the stage's screenshot bound refuses the next stored screenshot, not the next view", async () => {
		const deps = build(configRoot(), createFakeDriver());
		await openStage(deps);
		// Viewing is free: only a stored screenshot spends the bound.
		for (let index = 0; index < 3; index += 1) {
			const viewed = await call(deps, AGENT_BROWSER_SCREENSHOT_PATH, {});
			expect(viewed.status).toBe(200);
			expect(typeof viewed.value.base64).toBe("string");
		}
		for (let index = 0; index < 2; index += 1) {
			const kept = await call(deps, AGENT_BROWSER_SCREENSHOT_PATH, {
				evidence: true,
				view: false,
			});
			expect(kept.status).toBe(200);
		}
		const refused = await call(deps, AGENT_BROWSER_SCREENSHOT_PATH, {
			evidence: true,
			view: false,
		});
		expect(refused.status).toBe(409);
		expect(refused.value.code).toBe("stage-screenshot-limit");
		expect(refused.text).toContain("stage_step");
		// The refusal wrote nothing: the manifest still holds the two it allowed.
		expect(listEvidence(scopeOf(deps)).entries).toHaveLength(2);
		await deps.pool.closeAll();
	});
});

describe("the journal's write-time bounds and its version", () => {
	test("a discarded recording takes its segment off the steps it filed", async () => {
		const deps = build(
			configRoot(),
			createFakeDriver({ video: WEBM, screenshot: JPEG }),
		);
		await openStage(deps);
		expect(
			(await call(deps, AGENT_BROWSER_RECORD_PATH, { action: "start" })).status,
		).toBe(200);
		const step = await call(deps, AGENT_BROWSER_STAGE_STEP_PATH, {
			label: "the cart is empty",
		});
		expect(step.value.segment).toBe(1);
		// Keeping it and discarding it are the two ends of one segment: a discard
		// leaves no video, so no step may still name the segment one would have been
		// seekable in.
		const stopped = await call(deps, AGENT_BROWSER_RECORD_PATH, {
			action: "stop",
		});
		expect(stopped.status).toBe(200);
		expect(stopped.value.segment).toBe(1);
		const [entry] = readStageJournal(scopeOf(deps));
		expect(entry?.label).toBe("the cart is empty");
		expect(entry?.segment).toBeUndefined();
		expect(entry?.offsetMs).toBeUndefined();
		const page = fs.readFileSync(
			path.join(scopeOf(deps).root, STAGE_FLOW_FILE),
			"utf8",
		);
		expect(page).not.toContain("Segment 1");
		// The step kept its place in the sequence: a discard rewrites the step, it
		// does not renumber the run.
		expect(entry?.seq).toBe(1);
		await deps.pool.closeAll();
	});

	test("the journal folds and bounds what it is handed, not only what a route sends", async () => {
		// A request's own contract already refuses a caller's control characters and
		// an over-long URL. This is the writer's own guarantee for the text no
		// request bound covers — a redirected page's URL is the one shape that can
		// outgrow it — so the file it writes still decodes through the journal's own
		// read contract.
		const scope = workflowEvidenceScope({
			workflowId: "wf-flow",
			worktree: fs.mkdtempSync(path.join(os.tmpdir(), "stage-journal-text-")),
			definitionId: "core",
		});
		const entry = await appendStageJournalEntry(scope, {
			label: "a long page\nand a second line",
			url: `https://grid-flow.example.test/${"a".repeat(3_000)}\nafter`,
			captures: { note: "line\r\nbreak" },
		});
		expect(entry.label).toBe("a long page and a second line");
		expect(entry.captures?.note).toBe("line  break");
		expect((entry.url ?? "").length).toBe(2_048);
		expect(entry.url).not.toContain("\n");
		const decoded = Schema.decodeUnknownSync(stageJournalSchema)({
			workflowId: "wf-flow",
			entries: readStageJournal(scope),
		});
		expect(decoded.entries.map((each) => each.label)).toEqual([
			"a long page and a second line",
		]);
	});

	test("a URL in a step's own text loses its query, like the entry's URL", async () => {
		const deps = build(configRoot(), createFakeDriver());
		await openStage(deps);
		const step = await call(deps, AGENT_BROWSER_STAGE_STEP_PATH, {
			label: "the reset link arrived",
			captures: {
				link: `${APP_URL}reset?sessionid=leak-me`,
			},
		});
		expect(step.status).toBe(200);
		// Redaction masks the configuration's secrets; sanitizing is the second pass,
		// because an application's own query is not a configured secret and would
		// otherwise outlive the call that saw it.
		expect(step.text).not.toContain("leak-me");
		const journal = fs.readFileSync(
			path.join(scopeOf(deps).root, "stage-journal.jsonl"),
			"utf8",
		);
		expect(journal).not.toContain("leak-me");
		expect(journal).toContain("redacted");
		await deps.pool.closeAll();
	});

	test("a journal a newer build wrote is reported, never rewritten", async () => {
		const deps = build(configRoot(), createFakeDriver());
		await openStage(deps);
		await call(deps, AGENT_BROWSER_STAGE_STEP_PATH, { label: "first" });
		const file = path.join(scopeOf(deps).root, "stage-journal.jsonl");
		// A line from a format this build does not know: rewriting the file from what
		// parsed would silently drop every field it does not understand.
		const newer = `${JSON.stringify({
			v: 2,
			seq: 1,
			at: "2026-01-01T00:00:00.000Z",
			label: "first",
			somethingNew: true,
		})}\n`;
		fs.writeFileSync(file, newer);
		const read = await call(deps, AGENT_BROWSER_STAGE_JOURNAL_PATH, {});
		expect(read.status).toBe(500);
		expect(read.text).toContain("newer build");
		expect(read.text).toContain("2");
		// And the write path refuses too, rather than appending to a file it would
		// rewrite from a partial parse.
		const step = await call(deps, AGENT_BROWSER_STAGE_STEP_PATH, {
			label: "second",
		});
		expect(step.status).toBe(500);
		expect(fs.readFileSync(file, "utf8")).toBe(newer);
		await deps.pool.closeAll();
	});

	test("a page is not written back for a workflow whose evidence was removed", async () => {
		const deps = build(configRoot(), createFakeDriver());
		await openStage(deps);
		await call(deps, AGENT_BROWSER_STAGE_STEP_PATH, { label: "the only step" });
		const scope = scopeOf(deps);
		expect(fs.existsSync(path.join(scope.root, STAGE_FLOW_FILE))).toBe(true);
		expect(
			await removeWorkflowEvidence({
				workflowId: "wf-flow",
				worktree: deps.worktree,
				definitionId: "core",
			}),
		).toBe(true);
		// The writer re-checks the journal inside the lock: a render that interleaved
		// with the deletion must not recreate the directory chain it just lost.
		expect(await writeStageFlowPage(scope)).toBeUndefined();
		expect(fs.existsSync(scope.root)).toBe(false);
		await deps.pool.closeAll();
	});
});

describe("the stage's recording and screenshot budgets under concurrency", () => {
	test("two starts cannot be told the same remaining recording minutes", async () => {
		const deps = build(
			configRoot(),
			createFakeDriver({ video: WEBM, screenshot: JPEG }),
		);
		await openStage(deps);
		const first = await call(deps, AGENT_BROWSER_RECORD_PATH, {
			action: "start",
		});
		expect(first.status).toBe(200);
		// The stage allows one minute in total, and the segment just started may keep
		// all of it: the grant is reserved the moment it is told out, so a second
		// start hears the remainder that is actually left (nothing) rather than the
		// same minute.
		expect(sessionOf(deps).recording?.maxMs).toBe(60_000);
		await call(deps, AGENT_BROWSER_OPEN_PATH, {
			stage: "grid-flow",
			stageApp: "web",
			session: "second",
			path: "/two",
		});
		const second = await call(deps, AGENT_BROWSER_RECORD_PATH, {
			action: "start",
			session: "second",
		});
		expect(second.status).toBe(409);
		expect(second.value.code).toBe("stage-recording-limit");
		// Discarding the first gives the reservation back: a spent budget is what a
		// discard must not be confused with.
		expect(
			(await call(deps, AGENT_BROWSER_RECORD_PATH, { action: "stop" })).status,
		).toBe(200);
		const retried = await call(deps, AGENT_BROWSER_RECORD_PATH, {
			action: "start",
			session: "second",
		});
		expect(retried.status).toBe(200);
		expect(retried.value.segment).toBe(2);
		await deps.pool.closeAll();
	});

	test("a second start on a recording session is refused as active, not as a spent budget", async () => {
		const deps = build(
			configRoot(),
			createFakeDriver({ video: WEBM, screenshot: JPEG }),
		);
		await openStage(deps);
		expect(
			(await call(deps, AGENT_BROWSER_RECORD_PATH, { action: "start" })).status,
		).toBe(200);
		// This session already has a segment: the answer names that, rather than the
		// budget its own live grant has (correctly) already spent — and the grant
		// stays exactly as it was, so the segment can still be kept for its minute.
		const again = await call(deps, AGENT_BROWSER_RECORD_PATH, {
			action: "start",
		});
		expect(again.status).toBe(409);
		expect(again.value.code).toBe("recording-active");
		expect(sessionOf(deps).recording?.maxMs).toBe(60_000);
		expect(
			(
				await call(deps, AGENT_BROWSER_RECORD_PATH, {
					action: "stop",
					keep: true,
					caption: "checkout flow",
				})
			).status,
		).toBe(200);
		await deps.pool.closeAll();
	});

	test("a refused start leaves another session's grant where it was", async () => {
		const deps = build(
			configRoot(),
			createFakeDriver({ video: WEBM, screenshot: JPEG }),
		);
		await openStage(deps);
		await call(deps, AGENT_BROWSER_RECORD_PATH, { action: "start" });
		await call(deps, AGENT_BROWSER_OPEN_PATH, {
			stage: "grid-flow",
			stageApp: "web",
			session: "second",
			path: "/two",
		});
		// The budget is fully granted to the first session, so this start is refused
		// before it reserves anything — and a refusal that settled "a grant" rather
		// than *its own* would release the live one, letting the retry through.
		const refused = await call(deps, AGENT_BROWSER_RECORD_PATH, {
			action: "start",
			session: "second",
		});
		expect(refused.status).toBe(409);
		expect(refused.value.code).toBe("stage-recording-limit");
		const retried = await call(deps, AGENT_BROWSER_RECORD_PATH, {
			action: "start",
			session: "second",
		});
		expect(retried.status).toBe(409);
		expect(sessionOf(deps).recording?.maxMs).toBe(60_000);
		await deps.pool.closeAll();
	});

	test("a capture that fails spends nothing of the screenshot bound", async () => {
		const deps = build(configRoot(), createFakeDriver());
		await openStage(deps);
		// A ref the page does not have: the capture fails, so nothing was stored and
		// the bound counts what it says it counts.
		const failed = await call(deps, AGENT_BROWSER_SCREENSHOT_PATH, {
			evidence: true,
			view: false,
			ref: "e999",
		});
		expect(failed.status).toBeGreaterThanOrEqual(400);
		expect(failed.value.code).not.toBe("stage-screenshot-limit");
		expect(listEvidence(scopeOf(deps)).entries).toEqual([]);
		for (let index = 0; index < 2; index += 1) {
			const kept = await call(deps, AGENT_BROWSER_SCREENSHOT_PATH, {
				evidence: true,
				view: false,
			});
			expect(kept.status).toBe(200);
		}
		const refused = await call(deps, AGENT_BROWSER_SCREENSHOT_PATH, {
			evidence: true,
			view: false,
		});
		expect(refused.value.code).toBe("stage-screenshot-limit");
		await deps.pool.closeAll();
	});

	test("two overlapping screenshots cannot both pass the bound", async () => {
		const deps = build(configRoot(), createFakeDriver({ screenshot: JPEG }));
		await openStage(deps);
		// One of the stage's two screenshots is already reserved, so exactly one of
		// the two calls below can be stored. Reserving before the capture and
		// charging after it would let both pass the bound inside their capture and
		// answer one of them a refusal for a file it had stored.
		usageOf(deps).reserveScreenshot({
			stage: "grid-flow",
			owner: OWNER,
			maxScreenshots: 2,
		});
		const [first, second] = await Promise.all([
			call(deps, AGENT_BROWSER_SCREENSHOT_PATH, {
				evidence: true,
				view: false,
				caption: "the cart",
			}),
			call(deps, AGENT_BROWSER_SCREENSHOT_PATH, {
				evidence: true,
				view: false,
				caption: "the cart again",
			}),
		]);
		const stored = [first, second].filter((each) => each.status === 200);
		const refused = [first, second].filter((each) => each.status === 409);
		expect(stored).toHaveLength(1);
		expect(refused).toHaveLength(1);
		expect(refused[0]?.value.code).toBe("stage-screenshot-limit");
		// Exactly the two the bound allows are on disk: the refusal left no
		// reservation behind, and the stored one is the entry its answer names.
		const entries = listEvidence(scopeOf(deps)).entries;
		expect(entries).toHaveLength(1);
		const answered = stored[0]?.value.evidence as
			| Record<string, unknown>
			| undefined;
		expect(answered?.id).toBe(entries[0]?.id);
		await deps.pool.closeAll();
	});

	test("a glob condition is matched in linear time, whatever the pattern looks like", async () => {
		const deps = build(configRoot(), createFakeDriver());
		await openStage(deps, { path: `/${"a".repeat(64)}` });
		const started = Date.now();
		// A pattern built into a regular expression backtracks catastrophically on
		// exactly this shape, and the poll would sit still instead of answering the one
		// time it is asked. The walk visits each literal once.
		const waited = await call(deps, AGENT_BROWSER_STAGE_WAIT_PATH, {
			until: { url: `${"*a".repeat(12)}*b` },
			timeoutSeconds: 1,
			intervalSeconds: 30,
		});
		expect(Date.now() - started).toBeLessThan(5_000);
		expect(waited.status).toBe(200);
		expect(waited.value.met).toBe(false);
		await deps.pool.closeAll();
	});
});
