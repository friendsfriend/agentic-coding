// The `agentic.browser` tool surface (`add-agent-browser-sessions`, task 4.1):
// the discrete tools every durable run is offered, the owner capability they
// present, the ref versus selector action bodies, and the image content block a
// screenshot returns — all against a fake server.
import { describe, expect, test } from "bun:test";
import type { Extension } from "@earendil-works/pi-durable";
import {
	BROWSER_EXTENSION,
	createBrowserExtension,
} from "../src/agent-host/browser-tools.ts";
import { ENVIRONMENT_OWNER_HEADER } from "../src/agent-host/environment-capability.ts";
import type { RunContextLookup } from "../src/agent-host/tools.ts";

const BROWSER_TOOLS = [
	"browser_open",
	"stage_login",
	"stage_login_wait",
	"browser_snapshot",
	"browser_find",
	"browser_click",
	"browser_fill",
	"browser_press",
	"browser_select",
	"browser_hover",
	"browser_wait",
	"stage_wait",
	"stage_step",
	"stage_journal",
	"stage_blocks",
	"stage_run",
	"stage_block_save",
	"stage_flows",
	"stage_replay",
	"browser_eval",
	"browser_console",
	"browser_network",
	"browser_screenshot",
	"browser_record_start",
	"browser_record_stop",
	"browser_run_script",
	"browser_close",
];

const RUN_ENV = {
	HERDR_WORKFLOW_ID: "wf-alpha",
	HERDR_RUN_ID: "run-1",
	AGENTIC_ENV_URL: "http://127.0.0.1:4050",
	AGENTIC_ENV_TOKEN: "capability-for-wf-alpha",
};

interface Call {
	readonly url: string;
	readonly method: string;
	readonly owner: string | null;
	readonly authorization: string | null;
	readonly body: Record<string, unknown> | undefined;
}

interface FakeServer {
	readonly calls: Call[];
	readonly replies: unknown[];
}

function fakeFetch(server: FakeServer): typeof fetch {
	return (async (input: RequestInfo | URL, init?: RequestInit) => {
		const headers = new Headers(init?.headers);
		server.calls.push({
			url: String(input),
			method: init?.method ?? "GET",
			owner: headers.get(ENVIRONMENT_OWNER_HEADER),
			authorization: headers.get("authorization"),
			body: init?.body ? JSON.parse(String(init.body)) : undefined,
		});
		const index = Math.min(server.calls.length - 1, server.replies.length - 1);
		const reply = server.replies[index] ?? {};
		if (typeof reply === "object" && reply !== null && "error" in reply)
			return Response.json({ ok: false, error: reply.error }, { status: 409 });
		return Response.json({ ok: true, value: reply });
	}) as unknown as typeof fetch;
}

interface ContentBlock {
	readonly type: string;
	readonly text?: string;
	readonly data?: string;
	readonly mimeType?: string;
}

interface Executable {
	readonly name: string;
	execute(
		args: unknown,
		api: unknown,
		context: unknown,
	): Promise<{ output: ContentBlock[]; isError?: boolean }>;
}

function toolOf(extension: Extension, name: string): Executable {
	const tool = (extension.tools ?? []).find((entry) => entry.name === name);
	if (!tool) throw new Error(`no tool ${name}`);
	return tool as unknown as Executable;
}

const lookup: RunContextLookup = () => ({
	runId: "run-1",
	cwd: "/tmp",
	env: RUN_ENV,
	toolPolicy: "default",
});

async function invoke(
	name: string,
	args: unknown,
	server: FakeServer,
): Promise<{ result: { output: ContentBlock[]; isError?: boolean } }> {
	const extension = createBrowserExtension(lookup);
	const tool = toolOf(extension, name);
	// The extension builds its own fetch; swapping the global is the seam the
	// environment-tool tests use too, expressed as an injected transport here.
	const original = globalThis.fetch;
	globalThis.fetch = fakeFetch(server);
	try {
		return {
			result: await tool.execute(args, { conversationId: 1 }, {}),
		};
	} finally {
		globalThis.fetch = original;
	}
}

const textOf = (blocks: readonly ContentBlock[]): string =>
	blocks
		.filter((block) => block.type === "text")
		.map((block) => block.text ?? "")
		.join("");

describe("browser tool surface", () => {
	test("one discrete tool per action is offered to every durable run", () => {
		const extension = createBrowserExtension(lookup);
		expect(extension.name).toBe(BROWSER_EXTENSION);
		expect((extension.tools ?? []).map((tool) => tool.name)).toEqual(
			BROWSER_TOOLS,
		);
	});

	test("browser_open presents the owner capability and sends only what it was given", async () => {
		const server: FakeServer = {
			calls: [],
			replies: [{ session: "default", url: "http://app.local/", sessions: 1 }],
		};
		const { result } = await invoke(
			"browser_open",
			{ url: "http://app.local/" },
			server,
		);
		expect(result.isError).toBeFalsy();
		expect(server.calls[0]?.url).toBe(
			"http://127.0.0.1:4050/api/v1/agent-env/browser/open",
		);
		expect(server.calls[0]?.method).toBe("POST");
		expect(server.calls[0]?.owner).toBe("workflow:wf-alpha");
		expect(server.calls[0]?.authorization).toBe(
			"Bearer capability-for-wf-alpha",
		);
		expect(server.calls[0]?.body).toEqual({ url: "http://app.local/" });
	});

	test("an app endpoint open sends the app and endpoint, not a url", async () => {
		const server: FakeServer = {
			calls: [],
			replies: [{ session: "default", url: "http://127.0.0.1:5173" }],
		};
		await invoke(
			"browser_open",
			{ app: "customer-fe", endpoint: "web" },
			server,
		);
		expect(server.calls[0]?.body).toEqual({
			app: "customer-fe",
			endpoint: "web",
		});
	});

	test("an action sends a ref when it was given one and a selector otherwise", async () => {
		const refCall: FakeServer = { calls: [], replies: [{ action: "click" }] };
		await invoke("browser_click", { ref: "e3" }, refCall);
		expect(refCall.calls[0]?.body).toEqual({ action: "click", ref: "e3" });

		const selectorCall: FakeServer = {
			calls: [],
			replies: [{ action: "fill" }],
		};
		await invoke(
			"browser_fill",
			{ selector: "#name", value: "ada" },
			selectorCall,
		);
		expect(selectorCall.calls[0]?.body).toEqual({
			action: "fill",
			selector: "#name",
			value: "ada",
		});
	});

	test("a strict-schema model's blank optional arguments are treated as absent", async () => {
		const server: FakeServer = {
			calls: [],
			replies: [{ session: "customer", url: "https://stage.example.test/" }],
		};
		await invoke(
			"browser_open",
			{
				url: "",
				app: "",
				endpoint: "",
				stage: "qa-ava",
				stageApp: "customer",
				stageRole: "",
				path: "",
				session: "customer",
				viewport: { width: 1280, height: 900 },
			},
			server,
		);
		expect(server.calls[0]?.body).toEqual({
			stage: "qa-ava",
			stageApp: "customer",
			session: "customer",
			viewport: { width: 1280, height: 900 },
		});
		const click: FakeServer = { calls: [], replies: [{ action: "click" }] };
		await invoke("browser_click", { ref: "", selector: "#go" }, click);
		expect(click.calls[0]?.body).toEqual({ action: "click", selector: "#go" });
	});

	test("a stage open sends the stage, its app key and a path instead of a url", async () => {
		const server: FakeServer = {
			calls: [],
			replies: [
				{ session: "default", url: "https://grid-int.example.test/orders" },
			],
		};
		await invoke(
			"browser_open",
			{ stage: "grid-int", stageApp: "web", path: "/orders" },
			server,
		);
		expect(server.calls[0]?.body).toEqual({
			stage: "grid-int",
			stageApp: "web",
			path: "/orders",
		});
	});

	test("stage_login sends the role to resolve, never a credential", async () => {
		const server: FakeServer = {
			calls: [],
			replies: [{ login: "ok", url: "https://grid-int.example.test/home" }],
		};
		const { result } = await invoke(
			"stage_login",
			{ session: "clerk", app: "web", role: "clerk" },
			server,
		);
		expect(result.isError).toBeFalsy();
		expect(server.calls[0]?.url).toBe(
			"http://127.0.0.1:4050/api/v1/agent-env/browser/login",
		);
		// The body names a role; the value is resolved server-side and never travels.
		expect(server.calls[0]?.body).toEqual({
			session: "clerk",
			app: "web",
			role: "clerk",
		});
	});

	test("stage_login_wait blocks on the session and never names a credential", async () => {
		const server: FakeServer = {
			calls: [],
			replies: [{ session: "clerk", login: "needs-user" }],
		};
		const { result } = await invoke(
			"stage_login_wait",
			{ session: "clerk", timeoutSec: 120 },
			server,
		);
		expect(result.isError).toBeFalsy();
		expect(server.calls[0]?.url).toBe(
			"http://127.0.0.1:4050/api/v1/agent-env/browser/login-wait",
		);
		expect(server.calls[0]?.body).toEqual({
			session: "clerk",
			timeoutSec: 120,
		});
	});

	test("a fill with a credential reference sends the reference, not a value", async () => {
		const server: FakeServer = { calls: [], replies: [{ action: "fill" }] };
		await invoke(
			"browser_fill",
			{
				ref: "e7",
				credential: { app: "web", role: "clerk", field: "password" },
			},
			server,
		);
		expect(server.calls[0]?.body).toEqual({
			action: "fill",
			ref: "e7",
			credential: { app: "web", role: "clerk", field: "password" },
		});
	});

	test("a screenshot is returned as an image content block with its stored id", async () => {
		const server: FakeServer = {
			calls: [],
			replies: [
				{
					url: "http://app.local/",
					mediaType: "image/jpeg",
					base64: "ZmFrZQ==",
					evidence: { id: "01ABC" },
				},
			],
		};
		const { result } = await invoke(
			"browser_screenshot",
			{ evidence: true, caption: "the bug" },
			server,
		);
		expect(result.isError).toBeFalsy();
		expect(result.output[1]).toEqual({
			type: "image",
			data: "ZmFrZQ==",
			mimeType: "image/jpeg",
		});
		expect(textOf(result.output)).toContain("01ABC");
		expect(server.calls[0]?.body).toEqual({
			evidence: true,
			caption: "the bug",
		});
	});

	test("`view: false` answers with the stored id and the caption the panel shows", async () => {
		const server: FakeServer = {
			calls: [],
			replies: [
				{
					url: "http://app.local/cart",
					evidence: { id: "01ABC", caption: "the empty cart" },
					notice: "the screenshot was stored as evidence and not returned",
				},
			],
		};
		const { result } = await invoke(
			"browser_screenshot",
			{ evidence: true, view: false, caption: "the empty cart" },
			server,
		);
		expect(server.calls[0]?.body).toEqual({
			evidence: true,
			view: false,
			caption: "the empty cart",
		});
		// No image block for a picture this call deliberately did not look at, and
		// the caption is what tells the model which step the id belongs to.
		expect(result.output.map((block) => block.type)).toEqual(["text"]);
		expect(textOf(result.output)).toContain("01ABC");
		expect(textOf(result.output)).toContain("the empty cart");
	});

	test("a server refusal keeps its code and is an error result", async () => {
		const server: FakeServer = {
			calls: [],
			replies: [
				{
					error: {
						code: "app-not-held",
						message: "customer-fe is held by workflow:other",
					},
				},
			],
		};
		const { result } = await invoke(
			"browser_open",
			{ app: "customer-fe", endpoint: "web" },
			server,
		);
		expect(result.isError).toBe(true);
		expect(textOf(result.output)).toContain("app-not-held");
		expect(textOf(result.output)).toContain("workflow:other");
	});

	test("a run without the environment capability is told so, not failed opaquely", async () => {
		const extension = createBrowserExtension(() => ({
			runId: "run-1",
			cwd: "/tmp",
			env: {},
			toolPolicy: "default",
		}));
		const result = await toolOf(extension, "browser_snapshot").execute(
			{},
			{ conversationId: 1 },
			{},
		);
		expect(result.isError).toBe(true);
		expect(textOf(result.output)).toContain("no agent environment capability");
	});

	test("stage_wait refuses an `until` that names more than one condition", async () => {
		// Exactly one condition is the tool's contract: the server would have to pick
		// one of the two, and a wait that quietly ignored `text` would report a page
		// ready on a URL match alone.
		const server: FakeServer = { calls: [], replies: [{}] };
		const { result } = await invoke(
			"stage_wait",
			{ until: { text: "ready", url: "*/done" } },
			server,
		);
		expect(result.isError).toBe(true);
		expect(textOf(result.output)).toContain(
			"exactly one of text, selector, url or mail",
		);
		// Nothing was sent: a refused wait never polls.
		expect(server.calls).toEqual([]);
	});

	test("browser_record_stop defaults to discarding the recording", async () => {
		const server: FakeServer = {
			calls: [],
			replies: [{ session: "default", kept: false }],
		};
		await invoke("browser_record_stop", {}, server);
		expect(server.calls[0]?.body).toEqual({ action: "stop" });
	});

	test("every action tool sends the body its action needs", async () => {
		const cases: Array<{
			readonly tool: string;
			readonly args: Record<string, unknown>;
			readonly body: Record<string, unknown>;
			readonly path: string;
		}> = [
			{
				tool: "browser_press",
				args: { ref: "e1", key: "Enter" },
				body: { action: "press", ref: "e1", key: "Enter" },
				path: "action",
			},
			{
				tool: "browser_select",
				args: { selector: "#size", values: ["a", "b"] },
				body: { action: "select", selector: "#size", values: ["a", "b"] },
				path: "action",
			},
			{
				tool: "browser_hover",
				args: { ref: "e2" },
				body: { action: "hover", ref: "e2" },
				path: "action",
			},
			{
				tool: "browser_wait",
				args: { text: "Ready", timeoutMs: 1_500 },
				body: { text: "Ready", timeoutMs: 1_500 },
				path: "wait",
			},
			{
				tool: "browser_eval",
				args: { code: "return 1", timeoutMs: 2_000 },
				body: { code: "return 1", timeoutMs: 2_000 },
				path: "eval",
			},
			{
				tool: "browser_console",
				args: { level: "error", url: "/api/", limit: 5 },
				body: { level: "error", url: "/api/", limit: 5 },
				path: "console",
			},
			{
				tool: "browser_network",
				args: { status: 500, url: "/api/", limit: 5 },
				body: { status: 500, url: "/api/", limit: 5 },
				path: "network",
			},
			{
				tool: "browser_record_start",
				args: { session: "second" },
				body: { action: "start", session: "second" },
				path: "record",
			},
			{
				tool: "browser_close",
				args: { session: "second" },
				body: { session: "second" },
				path: "close",
			},
			{
				tool: "stage_wait",
				args: { until: { text: "ready" }, timeoutSeconds: 20, reload: true },
				body: {
					until: { text: "ready" },
					reload: true,
					timeoutSeconds: 20,
				},
				path: "stage-wait",
			},
			{
				tool: "stage_step",
				args: {
					label: "the cart is empty",
					expected: "no items",
					captures: { total: "0.00 EUR" },
					session: "second",
				},
				body: {
					label: "the cart is empty",
					expected: "no items",
					captures: { total: "0.00 EUR" },
					session: "second",
				},
				path: "stage-step",
			},
			{
				tool: "stage_journal",
				args: { session: "second", app: "web", limit: 5 },
				body: { session: "second", app: "web", limit: 5 },
				path: "stage-journal",
			},
		];
		for (const entry of cases) {
			const server: FakeServer = { calls: [], replies: [{}] };
			const { result } = await invoke(entry.tool, entry.args, server);
			expect(result.isError).toBeFalsy();
			expect(server.calls[0]?.url).toBe(
				`http://127.0.0.1:4050/api/v1/agent-env/browser/${entry.path}`,
			);
			expect(server.calls[0]?.body).toEqual(entry.body);
		}
	});

	test("browser_snapshot answers with the url, the ref count and the tree", async () => {
		const server: FakeServer = {
			calls: [],
			replies: [
				{
					session: "default",
					url: "http://app.local/",
					snapshot: "tree",
					refs: 3,
				},
			],
		};
		const { result } = await invoke("browser_snapshot", {}, server);
		expect(server.calls[0]?.url).toBe(
			"http://127.0.0.1:4050/api/v1/agent-env/browser/snapshot",
		);
		expect(server.calls[0]?.body).toEqual({});
		expect(textOf(result.output)).toContain("url: http://app.local/");
		expect(textOf(result.output)).toContain("refs: 3");
		expect(textOf(result.output)).toContain("tree");
	});

	test("browser_run_script forwards the code, the save flag and the timeout", async () => {
		const server: FakeServer = {
			calls: [],
			replies: [{ session: "default", url: "http://app.local/", result: 1 }],
		};
		await invoke(
			"browser_run_script",
			{ code: "return 1", save: true, caption: "repro", timeoutMs: 5_000 },
			server,
		);
		expect(server.calls[0]?.body).toEqual({
			code: "return 1",
			save: true,
			caption: "repro",
			timeoutMs: 5_000,
		});
	});

	test("browser_run_script forwards observe without inventing it", async () => {
		const observed: FakeServer = {
			calls: [],
			replies: [{ session: "default", url: "http://app.local/", result: 1 }],
		};
		await invoke(
			"browser_run_script",
			{ code: "return 1", observe: true },
			observed,
		);
		expect(observed.calls[0]?.body).toEqual({
			code: "return 1",
			observe: true,
		});
		const plain: FakeServer = {
			calls: [],
			replies: [{ session: "default", url: "http://app.local/", result: 1 }],
		};
		await invoke("browser_run_script", { code: "return 1" }, plain);
		expect(plain.calls[0]?.body).toEqual({ code: "return 1" });
	});

	test("snapshot options reach the server and the id/timing are in the text view", async () => {
		const server: FakeServer = {
			calls: [],
			replies: [
				{
					session: "default",
					url: "http://app.local/",
					snapshotId: "s2",
					observation: "changed: none",
					refs: 2,
					mode: "ai",
					timing: {
						mode: "ai",
						snapshotMs: 1,
						actionMs: 0,
						observeMs: 0,
						totalMs: 1,
						chars: 20,
						refs: 2,
						changed: false,
						truncated: false,
					},
				},
			],
		};
		const { result } = await invoke(
			"browser_snapshot",
			{ within: "e1", depth: 3, maxChars: 500 },
			server,
		);
		expect(server.calls[0]?.body).toEqual({
			within: "e1",
			depth: 3,
			maxChars: 500,
		});
		const output = textOf(result.output);
		expect(output).toContain("snapshotId: s2");
		expect(output).toContain("mode: ai");
		expect(output).toContain("timing: mode=ai");
		expect(output).toContain("changed: none");
	});

	test("an action answer is a compact observation, not the delta JSON", async () => {
		const server: FakeServer = {
			calls: [],
			replies: [
				{
					session: "default",
					action: "click",
					url: "http://app.local/cart",
					snapshotId: "s2",
					observation:
						'changed: +1 -0 ~0\n+ [e4] button "Delete"\nurl: http://app.local/cart',
					changed: true,
					snapshotRequired: false,
					delta: {
						added: [{ ref: "e4", role: "button", name: "Delete" }],
						removed: [],
						changed: [],
					},
					deltaTruncated: false,
					mode: "ai",
					timing: {
						mode: "ai",
						snapshotMs: 0,
						actionMs: 8,
						observeMs: 4,
						totalMs: 12,
						chars: 20,
						refs: 5,
						changed: true,
						truncated: false,
						toolMs: 14,
						resultChars: 500,
					},
				},
			],
		};
		const { result } = await invoke(
			"browser_click",
			{ ref: "e1", snapshotId: "s2" },
			server,
		);
		expect(server.calls[0]?.body).toEqual({
			action: "click",
			ref: "e1",
			snapshotId: "s2",
		});
		const output = textOf(result.output);
		expect(output).toContain("snapshotId: s2");
		expect(output).toContain('+ [e4] button "Delete"');
		expect(output).toContain("timing: mode=ai");
		expect(output).toContain("actionMs=8");
		expect(output).not.toContain('"delta"');
		expect(output).not.toContain('"added"');
	});

	test("browser_find is one match per line and never the node map", async () => {
		const server: FakeServer = {
			calls: [],
			replies: [
				{
					session: "default",
					snapshotId: "s1",
					total: 2,
					truncated: false,
					matches: [
						{ ref: "e1", role: "button", name: "Save" },
						{ ref: "f1e2", role: "textbox", name: "Card" },
					],
					mode: "ai",
					timing: {
						mode: "ai",
						snapshotMs: 0,
						actionMs: 0,
						observeMs: 1,
						totalMs: 1,
						chars: 40,
						refs: 2,
						changed: false,
						truncated: false,
					},
				},
			],
		};
		const { result } = await invoke(
			"browser_find",
			{ query: "card", role: "textbox", within: "e1", limit: 5 },
			server,
		);
		expect(server.calls[0]?.body).toEqual({
			query: "card",
			role: "textbox",
			within: "e1",
			limit: 5,
		});
		const output = textOf(result.output);
		expect(output).toContain("matches: 2 of 2");
		expect(output).toContain('- [e1] button "Save"');
		expect(output).toContain('- [f1e2] textbox "Card"');
		expect(output).not.toContain('"matches"');
	});
});

describe("stage_blocks and stage_run", () => {
	test("stage_blocks asks for the compact catalog and prints one line per block", async () => {
		const server: FakeServer = {
			calls: [],
			replies: [
				{
					version: 1,
					mode: "compact",
					total: 1,
					blocks: [
						{
							id: "crm.ui.open",
							version: "1.0.0",
							app: "crm",
							title: "Open an application path",
							description: "Navigates within the application.",
							effects: ["read"],
							idempotent: true,
							requires: [],
							provides: [],
						},
					],
				},
			],
		};
		const { result } = await invoke(
			"stage_blocks",
			{ app: "crm", effect: "read" },
			server,
		);
		expect(result.isError).toBeFalsy();
		const call = server.calls[0];
		expect(call?.url).toBe(
			"http://127.0.0.1:4050/api/v1/agent-env/browser/stage-blocks",
		);
		expect(call?.body).toEqual({ app: "crm", effect: "read" });
		const text = textOf(result.output);
		expect(text).toContain("mode: compact");
		expect(text).toContain(
			"crm.ui.open@1.0.0 crm [read] Open an application path",
		);
		expect(text).toContain("idempotent: yes");
	});

	test("stage_blocks with an id prints the schema the planner needs", async () => {
		const server: FakeServer = {
			calls: [],
			replies: [
				{
					version: 1,
					mode: "full",
					total: 1,
					blocks: [
						{
							id: "crm.ui.open",
							version: "1.0.0",
							app: "crm",
							title: "Open an application path",
							description: "Navigates within the application.",
							effects: ["read"],
							idempotent: true,
							requires: [],
							provides: [],
							params: { type: "object" },
							returns: { type: "object" },
							examples: [{ path: "/" }],
							digest: "sha256:abc",
						},
					],
				},
			],
		};
		const { result } = await invoke(
			"stage_blocks",
			{ id: "crm.ui.open" },
			server,
		);
		const text = textOf(result.output);
		expect(text).toContain("schema:");
		expect(text).toContain('"path":"/"');
	});

	test("stage_run sends the plan and prints the compact ledger", async () => {
		const server: FakeServer = {
			calls: [],
			replies: [
				{
					planId: "plan-1",
					flowId: "customer-address",
					revision: 3,
					inputsHash: "sha256:abc",
					stage: "crm-int",
					status: "passed",
					durationMs: 42,
					versions: { "crm.ui.open": "1.0.0" },
					steps: [
						{
							index: 0,
							routeStepId: "open",
							block: "crm.ui.open",
							version: "1.0.0",
							app: "crm",
							status: "passed",
							durationMs: 30,
							retries: 0,
							journalIds: [1],
							evidenceIds: [],
						},
					],
				},
			],
		};
		const plan = { steps: [{ block: "crm.ui.open", args: { path: "/" } }] };
		const { result } = await invoke(
			"stage_run",
			{ plan, session: "default" },
			server,
		);
		expect(result.isError).toBeFalsy();
		const call = server.calls[0];
		expect(call?.url).toBe(
			"http://127.0.0.1:4050/api/v1/agent-env/browser/stage-run",
		);
		expect(call?.body).toMatchObject({ plan, session: "default" });
		const text = textOf(result.output);
		expect(text).toContain("planId: plan-1");
		expect(text).toContain("status: passed");
		expect(text).toContain("passed [0] open crm.ui.open@1.0.0 30ms journal=1");
	});

	test("stage_run dry run prints issue codes and derived inputs", async () => {
		const server: FakeServer = {
			calls: [],
			replies: [
				{
					planId: "plan-1",
					inputsHash: "sha256:abc",
					stage: "unopened",
					status: "failed",
					durationMs: 0,
					versions: {},
					steps: [],
					dryRun: {
						ok: false,
						issues: [
							{
								code: "block-unknown",
								message: "block crm.nope is not registered",
							},
						],
						versions: {},
						inputSchema: {
							type: "object",
							properties: { path: { type: "string" } },
						},
					},
				},
			],
		};
		const { result } = await invoke(
			"stage_run",
			{ plan: { steps: [{ block: "crm.nope" }] }, dryRun: true },
			server,
		);
		const text = textOf(result.output);
		expect(text).toContain("dryRun: refused");
		expect(text).toContain("issue: block-unknown");
		expect(text).toContain("input path:");
	});
});

describe("stage_flows and stage_replay", () => {
	test("stage_flows sends filters and prints hashes and inputs without values", async () => {
		const server: FakeServer = {
			calls: [],
			replies: [
				{
					version: 1,
					total: 1,
					issues: [],
					flows: [
						{
							flowId: "customer-address",
							title: "Customer address",
							stage: "crm-int",
							applications: ["crm"],
							roles: ["clerk"],
							routeHash: "sha256:route",
							specHash: "sha256:spec",
							inputSchema: {
								type: "object",
								properties: { path: { type: "string" } },
							},
							blockVersions: { "crm.ui.open": "1.0.0" },
						},
					],
				},
			],
		};
		const { result } = await invoke(
			"stage_flows",
			{ stage: "crm-int", query: "customer", limit: 10 },
			server,
		);
		expect(result.isError).toBeFalsy();
		expect(server.calls[0]?.url).toBe(
			"http://127.0.0.1:4050/api/v1/agent-env/browser/stage-flows",
		);
		expect(server.calls[0]?.body).toEqual({
			stage: "crm-int",
			query: "customer",
			limit: 10,
		});
		const text = textOf(result.output);
		expect(text).toContain("customer-address [crm-int] crm roles=clerk");
		expect(text).toContain("routeHash: sha256:route");
		expect(text).toContain('input path: {"type":"string"}');
	});

	test("stage_replay without a flow id lists flows instead of starting one", async () => {
		const server: FakeServer = {
			calls: [],
			replies: [{ version: 1, total: 0, flows: [], issues: [] }],
		};
		const { result } = await invoke(
			"stage_replay",
			{ stage: "crm-int" },
			server,
		);
		expect(result.isError).toBeFalsy();
		expect(server.calls[0]?.url).toBe(
			"http://127.0.0.1:4050/api/v1/agent-env/browser/stage-flows",
		);
		expect(textOf(result.output)).toContain("total: 0");
	});

	test("stage_replay dry run validates inputs without opening a browser", async () => {
		const server: FakeServer = {
			calls: [],
			replies: [
				{
					flowId: "customer-address",
					planId: "plan-1",
					revision: 3,
					inputsHash: "sha256:inputs",
					routeHash: "sha256:route",
					specHash: "sha256:spec",
					stage: "crm-int",
					status: "failed",
					durationMs: 0,
					steps: [],
					dryRun: {
						eligible: false,
						inputs: { path: 42 },
						inputSchema: {
							type: "object",
							properties: { path: { type: "string" } },
						},
						issues: [
							{
								code: "flow-inputs-invalid",
								message: "path must be a string",
							},
						],
					},
				},
			],
		};
		const { result } = await invoke(
			"stage_replay",
			{
				flowId: "customer-address",
				dryRun: true,
				inputs: { path: "/customers/C-2002" },
			},
			server,
		);
		expect(result.isError).toBeFalsy();
		expect(server.calls[0]?.url).toBe(
			"http://127.0.0.1:4050/api/v1/agent-env/browser/stage-replay",
		);
		expect(server.calls[0]?.body).toEqual({
			flowId: "customer-address",
			dryRun: true,
			inputs: { path: "/customers/C-2002" },
		});
		const text = textOf(result.output);
		expect(text).toContain("dryRun: not eligible");
		expect(text).toContain("issue: flow-inputs-invalid");
		expect(text).not.toContain("approved");
		expect(text).toContain('inputs: {"path":42}');
		expect(text).toContain('input path: {"type":"string"}');
	});

	test("stage_replay prints the ledger, failure and heal packet", async () => {
		const server: FakeServer = {
			calls: [],
			replies: [
				{
					flowId: "customer-address",
					planId: "plan-1",
					revision: 3,
					inputsHash: "sha256:inputs",
					routeHash: "sha256:route",
					specHash: "sha256:spec",
					stage: "crm-int",
					status: "failed",
					durationMs: 120,
					blockVersions: { "crm.ui.open": "1.0.0" },
					steps: [
						{
							index: 0,
							routeStepId: "open",
							block: "crm.ui.open",
							version: "1.0.0",
							status: "failed",
							durationMs: 100,
							journalIds: [4],
							evidenceIds: ["ev-1"],
							error: "marker missing",
						},
					],
					failure: {
						index: 0,
						routeStepId: "open",
						block: "crm.ui.open",
						version: "1.0.0",
						message: "marker missing",
						retryable: false,
					},
					heal: {
						routeStepId: "open",
						block: "crm.ui.open",
						evidenceId: "ev-1",
						retryable: false,
					},
				},
			],
		};
		const { result } = await invoke(
			"stage_replay",
			{ flowId: "customer-address" },
			server,
		);
		const text = textOf(result.output);
		expect(text).toContain(
			"failed [0] open crm.ui.open@1.0.0 100ms journal=4 evidence=ev-1",
		);
		expect(text).toContain("failure: marker missing");
		expect(text).toContain("heal: open crm.ui.open");
	});

	test("stage_replay with a suite id runs the suite and prints the aggregate ledger", async () => {
		const server: FakeServer = {
			calls: [],
			replies: [
				{
					suiteId: "crm-regression",
					stage: "crm-int",
					parallel: true,
					stopOnFailure: false,
					status: "failed",
					durationMs: 450,
					resultEvidenceId: "ev-suite",
					entries: [
						{
							id: "approved",
							flowId: "customer-address",
							status: "passed",
							inputsHash: "sha256:approved",
							evidenceIds: ["ev-1", "ev-2"],
						},
						{
							id: "unapproved",
							flowId: "customer-address",
							status: "refused",
							code: "flow-not-eligible",
							error: "the supplied inputs do not match the manifest schema",
						},
					],
				},
			],
		};
		const { result } = await invoke(
			"stage_replay",
			{ suiteId: "crm-regression" },
			server,
		);
		expect(server.calls[0]?.body).toMatchObject({
			suiteId: "crm-regression",
		});
		expect(server.calls[0]?.body).not.toHaveProperty("flowId");
		const text = textOf(result.output);
		expect(text).toContain("suiteId: crm-regression");
		expect(text).toContain("status: failed");
		expect(text).toContain("parallel: yes, stopOnFailure: no");
		expect(text).toContain("resultEvidenceId: ev-suite");
		expect(text).toContain(
			"passed approved (customer-address) inputsHash=sha256:approved evidence=ev-1,ev-2",
		);
		expect(text).toContain("refused unapproved (customer-address)");
		expect(text).toContain("code: flow-not-eligible");
	});
});
