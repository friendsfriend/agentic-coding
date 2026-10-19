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
	"browser_click",
	"browser_fill",
	"browser_press",
	"browser_select",
	"browser_hover",
	"browser_wait",
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
	): Promise<{ content: ContentBlock[]; isError?: boolean }>;
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
});

async function invoke(
	name: string,
	args: unknown,
	server: FakeServer,
): Promise<{ result: { content: ContentBlock[]; isError?: boolean } }> {
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
		expect(result.content[1]).toEqual({
			type: "image",
			data: "ZmFrZQ==",
			mimeType: "image/jpeg",
		});
		expect(textOf(result.content)).toContain("01ABC");
		expect(server.calls[0]?.body).toEqual({
			evidence: true,
			caption: "the bug",
		});
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
		expect(textOf(result.content)).toContain("app-not-held");
		expect(textOf(result.content)).toContain("workflow:other");
	});

	test("a run without the environment capability is told so, not failed opaquely", async () => {
		const extension = createBrowserExtension(() => ({
			runId: "run-1",
			cwd: "/tmp",
			env: {},
		}));
		const result = await toolOf(extension, "browser_snapshot").execute(
			{},
			{ conversationId: 1 },
			{},
		);
		expect(result.isError).toBe(true);
		expect(textOf(result.content)).toContain("no agent environment capability");
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
		expect(textOf(result.content)).toContain("url: http://app.local/");
		expect(textOf(result.content)).toContain("refs: 3");
		expect(textOf(result.content)).toContain("tree");
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
});
