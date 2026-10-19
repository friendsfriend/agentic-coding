/** @jsxImportSource @opentui/solid */
// The credential write's identity (`add-stage-testing-foundation`, task 5.1).
//
// The editor is escapable while a write is in flight — the request is already
// sent and the draft exists only in that dialog — and the next editor may open
// before the answer arrives. One request's outcome may then not land on another
// request's dialog: the second editor must stay typeable, keep its own draft,
// and not be closed by an answer about a write the developer cancelled. This
// file drives that race through the real shell against a stub backend that holds
// the write open, and asserts the rule itself at the unit level.
import { afterEach, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createDefaultOpenTuiKeymap } from "@opentui/keymap/opentui";
import { testRender, useRenderer } from "@opentui/solid";
import { onCleanup } from "solid-js";
import type { StagesStatusResponse } from "../../src/contracts/stages.ts";
import {
	clearBackendClient,
	configureBackendClient,
} from "../../src/server/client.ts";
import { startWorkflowServer } from "../../src/server/lifecycle.ts";
import { TraceDb } from "../../src/server/telemetry-db";
import { App, credentialAnswerIsCurrent } from "../../src/tui/otel/app/App.tsx";
import { LogStore } from "../../src/tui/otel/model/logStore.ts";
import { MetricStore } from "../../src/tui/otel/model/metricStore.ts";
import { TopologyStore } from "../../src/tui/otel/model/topologyStore.ts";
import { TraceStore } from "../../src/tui/otel/model/traceStore.ts";
import { clearStageSnapshot } from "../../src/tui/settings/stages.ts";

const VARIABLE = "GRID_INT_CLERK_PASSWORD";
const ROW = "clerk · password";
/** The row's title as the dialog renders it: variable, then the field-first
 * label the row supplied. */
const EDITOR_TITLE = `${VARIABLE} · password · clerk · Grid web · Grid integration`;

const cleanups: Array<() => void> = [];

afterEach(() => {
	for (const cleanup of cleanups.splice(0)) cleanup();
});

function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

/** One held credential write: what it asked to set, and its own answer. */
interface HeldWrite {
	readonly variable: string;
	readonly value: string;
	answer(status: number, body: unknown): void;
}

/** A proxy in front of the real server that holds exactly one route open: the
 * credential write. Everything else is forwarded, so the shell under test is the
 * real one attached to a real server. */
function stubServer(upstream: string): {
	readonly url: string;
	readonly held: HeldWrite[];
	stop(): void;
} {
	const held: HeldWrite[] = [];
	const server = Bun.serve({
		port: 0,
		fetch: async (request) => {
			const url = new URL(request.url);
			// The catalog read is the section's whole input, so the stub answers it
			// itself: one stage, one credential, and no dependency on the developer's
			// own configuration root.
			if (url.pathname === "/api/v1/stages")
				return Response.json({ ok: true, value: stageStatus() });
			if (url.pathname === "/api/v1/stages/credential") {
				const body = (await request.json()) as {
					variable: string;
					value: string;
				};
				return await new Promise<Response>((resolve) => {
					held.push({
						variable: body.variable,
						value: body.value,
						answer: (status, answer) =>
							resolve(Response.json(answer, { status })),
					});
				});
			}
			const headers = new Headers(request.headers);
			headers.delete("host");
			const response = await fetch(
				new URL(`${url.pathname}${url.search}`, upstream),
				{
					method: request.method,
					headers,
					body:
						request.method === "GET" || request.method === "HEAD"
							? undefined
							: await request.arrayBuffer(),
				},
			);
			return response;
		},
	});
	return {
		url: `http://127.0.0.1:${server.port}`,
		held,
		stop: () => void server.stop(true),
	};
}

/** The catalog the stub answers with: one stage, one role, one credential. */
function stageStatus(): StagesStatusResponse {
	return {
		configDir: "/tmp/credential-race-config",
		stages: [
			{
				ident: "grid-int",
				displayName: "Grid integration",
				environment: "integration",
				system: "grid",
				access: "read-only",
				planApproval: "always",
				exclusive: false,
				apps: [
					{
						key: "web",
						label: "Grid web",
						url: "https://grid-int.example.test/",
						kind: "ui",
						roles: [
							{
								role: "clerk",
								login: "web-form",
								loginKind: "form",
								credentialStatus: `missing ${VARIABLE}`,
								loginMode: "handoff",
								credentials: [
									{
										field: "password",
										variable: VARIABLE,
										status: `missing ${VARIABLE}`,
									},
								],
							},
						],
					},
				],
				origins: ["https://grid-int.example.test"],
				readOnlyExceptions: [],
				limits: {
					maxSessions: 1,
					maxActionsPerMinute: 30,
					maxWaitSeconds: 120,
					maxScreenshots: 20,
					maxRecordingMinutes: 5,
					maxLoginHandoffSeconds: 900,
				},
				identityCache: {
					enabled: true,
					ttlMinutes: 240,
					maxEntries: 8,
					refreshSeconds: 120,
				},
				data: {},
				wiki: { processes: [] },
				diagnostics: [],
			},
		],
		excluded: [],
	};
}

type Test = Awaited<ReturnType<typeof renderSettings>>;

async function renderSettings() {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "credential-race-db-"));
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

/** Poll the *complete* frame until it satisfies `predicate`. */
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

function type(t: Test, text: string) {
	for (const character of text) t.mockInput.pressKey(character);
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

/** Walk the selection down to the credential row and activate it. */
async function openCredentialEditor(t: Test) {
	// The section is the only list on the page: definitions, the stage, the stage's
	// identity-cache row, the app, the role's login-mode row, then the credential
	// row the write belongs to.
	for (let i = 0; i < 5; i++) {
		t.mockInput.pressKey("j");
		await t.renderOnce();
	}
	await frameWhere(t, (frame) => frame.includes(ROW));
	t.mockInput.pressEnter();
	await frameWhere(t, (frame) => frame.includes(EDITOR_TITLE));
}

test("a credential write's answer never lands on the dialog that replaced it", async () => {
	const started = await startWorkflowServer({ port: 0, ownTelemetry: false });
	cleanups.push(() => started.stop());
	const stub = stubServer(started.url);
	cleanups.push(() => stub.stop());
	// The client presents the server's capability from the environment
	// (`createCustomFetch`, which prefers `AGENTIC_DEVENV_TOKEN`), and the stub
	// forwards it verbatim. Both variables are set, as the shell does, so a token
	// the surrounding process exported cannot win.
	const previousTokens = {
		devenv: process.env.AGENTIC_DEVENV_TOKEN,
		workflow: process.env.AGENTIC_WORKFLOW_TOKEN,
	};
	process.env.AGENTIC_DEVENV_TOKEN = started.token;
	process.env.AGENTIC_WORKFLOW_TOKEN = started.token;
	cleanups.push(() => {
		for (const [name, value] of [
			["AGENTIC_DEVENV_TOKEN", previousTokens.devenv],
			["AGENTIC_WORKFLOW_TOKEN", previousTokens.workflow],
		] as const) {
			if (value === undefined) delete process.env[name];
			else process.env[name] = value;
		}
	});
	clearStageSnapshot();
	cleanups.push(() => clearStageSnapshot());
	configureBackendClient({
		baseUrl: stub.url,
		token: started.token,
		ownerId: `credential-race-${process.pid}`,
	});
	cleanups.push(() => clearBackendClient());
	const t = await renderSettings();
	await openSettings(t, "stages", "Grid integration");

	// The first write: a draft, then Enter. It stays in flight because the stub
	// holds it, which is exactly the slow-server window the finding describes.
	await openCredentialEditor(t);
	type(t, "first-secret");
	t.mockInput.pressEnter();
	await frameWhere(t, (frame) => frame.includes("••••••••••••█"));
	for (let i = 0; stub.held.length === 0 && i < 200; i++) await sleep(25);
	expect(stub.held.map((write) => write.variable)).toEqual([VARIABLE]);
	expect(stub.held[0]?.value).toBe("first-secret");

	// Esc cancels it. The secret is gone from the shell, and the request cannot be
	// recalled — it is still on its way.
	await pressEscape(t);
	await frameWhere(t, (frame) => !frame.includes(EDITOR_TITLE));

	// The same row is opened again while the first answer is in flight. This is
	// the dialog the answer must not touch: it is a *new* request, and it has to
	// be typeable from the first keystroke.
	await openCredentialEditor(t);
	const reopened = await frameWhere(t, (frame) => frame.includes(EDITOR_TITLE));
	expect(reopened).toContain("(empty)");
	type(t, "second");
	const typed = await frameWhere(t, (frame) => frame.includes("••••••█"));
	expect(typed).toContain("6/1024");

	// The cancelled write's answer lands now, and it is *reported* rather than
	// applied: the toast names the variable, and the editor the developer is
	// looking at stays open with the draft they are typing. Waiting for the toast
	// is what makes this an assertion about the answer: it is the one thing both
	// outcomes have in common.
	stub.held[0]?.answer(200, { ok: true, value: stageStatus() });
	const reported = await frameWhere(t, (frame) =>
		frame.includes(`${VARIABLE} set`),
	);
	expect(reported).toContain(EDITOR_TITLE);
	expect(reported).toContain("••••••█");
	expect(reported).toContain("6/1024");
	expect(reported).not.toContain("(empty)");

	// The dialog the developer is actually looking at still writes: its own Enter
	// sends the second value, and that answer closes it.
	t.mockInput.pressEnter();
	for (let i = 0; stub.held.length < 2 && i < 200; i++) await sleep(25);
	expect(stub.held[1]?.value).toBe("second");
	stub.held[1]?.answer(200, { ok: true, value: stageStatus() });
	await frameWhere(t, (frame) => !frame.includes(EDITOR_TITLE));
});

test("an answer belongs to the request, the variable and the overlay it was sent for", () => {
	const sent = {
		dialog: 2,
		openDialog: 2,
		request: 4,
		answeredRequest: 4,
		variable: "A",
		openVariable: "A",
		overlay: "stage-credential",
	};
	expect(credentialAnswerIsCurrent(sent)).toBe(true);
	// The same row reopened is a *different* dialog with the same variable: the
	// answer may not unfreeze, fill or close it.
	expect(credentialAnswerIsCurrent({ ...sent, openDialog: 3 })).toBe(false);
	// And a later write is another request, so an answer cannot unfreeze a dialog
	// that is waiting on its own write.
	expect(credentialAnswerIsCurrent({ ...sent, answeredRequest: 5 })).toBe(
		false,
	);
	// The same request id cannot be reached by another variable, and the dialog
	// that is open names the variable it writes.
	expect(credentialAnswerIsCurrent({ ...sent, openVariable: "B" })).toBe(false);
	expect(credentialAnswerIsCurrent({ ...sent, openVariable: undefined })).toBe(
		false,
	);
	// No overlay, or a different one on top: the answer is a toast, not an edit.
	expect(credentialAnswerIsCurrent({ ...sent, overlay: undefined })).toBe(
		false,
	);
	expect(
		credentialAnswerIsCurrent({ ...sent, overlay: "compaction-value" }),
	).toBe(false);
});
