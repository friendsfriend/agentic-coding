// The `agentic.stages` tool every durable run is offered
// (`add-stage-testing-foundation`, task 2.2).
//
// The tool is a read of the server's owner-scoped `/api/v1/agent-env/stages`
// surface. This file drives it against the *real* route handler over a
// throwaway configuration root, so what an agent sees is what the catalog, the
// route and the tool agree on — and the promise in its description is asserted:
// a credential reaches it as the *name* of the `.env` variable, never as a
// value.
// biome-ignore-all lint/suspicious/noTemplateCurlyInString: this file asserts the literal `${VARIABLE}` reference syntax, so every occurrence is intentional fixture text, not a template placeholder.
import { describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { Extension } from "@earendil-works/pi-durable";
import { ENVIRONMENT_OWNER_HEADER } from "../src/agent-host/environment-capability.ts";
import {
	createStageExtension,
	STAGE_EXTENSION,
} from "../src/agent-host/stage-tools.ts";
import type { RunContextLookup } from "../src/agent-host/tools.ts";
import {
	AGENT_STAGE_API_REQUEST_PATH,
	AGENT_STAGE_TOKEN_INFO_PATH,
	AGENT_STAGES_PATH,
} from "../src/server/protocol.ts";
import { stagePaths } from "../src/server/stages/catalog.ts";
import {
	handleStageRoute,
	type StageRouteDeps,
} from "../src/server/stages/routes.ts";

const PASSWORD_SENTINEL = "pw-sentinel-agent-host-do-not-leak";
const USERNAME_SENTINEL = "user-sentinel-agent-host";

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
}

/** One `stage_api_request` / `stage_token_info` call, with its body. */
interface PostedCall {
	readonly url: string;
	readonly method: string;
	readonly owner: string | null;
	readonly authorization: string | null;
	readonly body: unknown;
}

/** A transport that records what the tool sent and answers a fixed envelope,
 * so the tools are tested for what they *send*, not for the route's own
 * behaviour (which `stage-oauth2-routes.test.ts` covers). */
function postedFetch(calls: PostedCall[], value: unknown): typeof fetch {
	return (async (input: RequestInfo | URL, init?: RequestInit) => {
		const headers = new Headers(init?.headers);
		calls.push({
			url: String(input),
			method: init?.method ?? "GET",
			owner: headers.get(ENVIRONMENT_OWNER_HEADER),
			authorization: headers.get("authorization"),
			body:
				init?.body === undefined ? undefined : JSON.parse(String(init.body)),
		});
		return new Response(JSON.stringify({ ok: true, value }), {
			headers: { "content-type": "application/json" },
		});
	}) as unknown as typeof fetch;
}

/** A transport that records what the tool sent and answers the route's refusal
 * envelope, so a test can assert both what the tool sent *and* what it made of
 * an answer that is not a success. */
function refusingFetch(
	calls: PostedCall[],
	error: {
		readonly code: string;
		readonly message: string;
		readonly retryAfterMs?: number;
	},
	status = 400,
): typeof fetch {
	return (async (input: RequestInfo | URL, init?: RequestInit) => {
		const headers = new Headers(init?.headers);
		calls.push({
			url: String(input),
			method: init?.method ?? "GET",
			owner: headers.get(ENVIRONMENT_OWNER_HEADER),
			authorization: headers.get("authorization"),
			body:
				init?.body === undefined ? undefined : JSON.parse(String(init.body)),
		});
		return new Response(JSON.stringify({ ok: false, error }), {
			headers: { "content-type": "application/json" },
			status,
		});
	}) as unknown as typeof fetch;
}

/** The real stage route, behind a recorded transport. */
function routeFetch(
	deps: StageRouteDeps,
	owner: string,
	calls: Call[],
): typeof fetch {
	return (async (input: RequestInfo | URL, init?: RequestInit) => {
		const url = new URL(String(input));
		const headers = new Headers(init?.headers);
		calls.push({
			url: String(input),
			method: init?.method ?? "GET",
			owner: headers.get(ENVIRONMENT_OWNER_HEADER),
			authorization: headers.get("authorization"),
		});
		const response = await handleStageRoute(
			deps,
			new Request(url, init),
			url,
			owner,
		);
		if (!response) throw new Error(`no route for ${url.pathname}`);
		return response;
	}) as unknown as typeof fetch;
}

/** One allowed stage (one credential set, one missing) and one refused file. */
function seeded(): { configDir: string; deps: StageRouteDeps } {
	const configDir = fs.mkdtempSync(path.join(os.tmpdir(), "stage-tool-"));
	const defsDir = stagePaths(configDir).defsDir;
	fs.mkdirSync(defsDir, { recursive: true });
	const definition = {
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
						username: "${GRID_INT_CLERK_USERNAME}",
						password: "${GRID_INT_CLERK_PASSWORD}",
					},
				},
			},
		},
		logins: {
			"web-form": {
				kind: "form",
				steps: [{ fields: [{ credential: "password", label: "Password" }] }],
			},
		},
		allowedOrigins: ["https://login.example.test"],
	};
	fs.writeFileSync(
		path.join(defsDir, "grid-int.json"),
		`${JSON.stringify(definition, null, 2)}\n`,
	);
	fs.writeFileSync(
		path.join(defsDir, "grid-prod.json"),
		`${JSON.stringify(
			{
				...definition,
				ident: "grid-prod",
				displayName: "Grid production",
				environment: "production",
			},
			null,
			2,
		)}\n`,
	);
	fs.writeFileSync(
		path.join(configDir, ".env"),
		`GRID_INT_CLERK_USERNAME=${USERNAME_SENTINEL}\n`,
	);
	return { configDir, deps: { configDir } };
}

interface ContentBlock {
	readonly type: string;
	readonly text?: string;
}

interface Executable {
	readonly name: string;
	readonly description?: string;
	execute(
		args: unknown,
		api: unknown,
		context: unknown,
	): Promise<{ output: ContentBlock[]; isError?: boolean }>;
}

function toolOf(extension: Extension): Executable {
	const tool = (extension.tools ?? [])[0];
	if (!tool) throw new Error("the extension offers no tool");
	return tool as unknown as Executable;
}

function toolNamed(extension: Extension, name: string): Executable {
	const tool = (extension.tools ?? []).find(
		(candidate) => candidate.name === name,
	);
	if (!tool) throw new Error(`the extension offers no tool ${name}`);
	return tool as unknown as Executable;
}

const textOf = (blocks: readonly ContentBlock[]): string =>
	blocks
		.filter((block) => block.type === "text")
		.map((block) => block.text ?? "")
		.join("");

function lookup(env: Record<string, string>): RunContextLookup {
	return () => ({
		runId: "run-1",
		cwd: "/tmp",
		env,
		toolPolicy: "default",
	});
}

describe("stage_info", () => {
	test("every durable run is offered the stage surface, described as value-free", () => {
		const extension = createStageExtension(lookup(RUN_ENV));
		expect(extension.name).toBe(STAGE_EXTENSION);
		expect((extension.tools ?? []).map((tool) => tool.name)).toEqual([
			"stage_info",
			"stage_api_request",
			"stage_token_info",
		]);
		const description = toolOf(extension).description ?? "";
		// The promise the tool is built on, in the text a model reads.
		expect(description).toContain("never returns a secret");
		expect(description).toContain("never as a value");
		// And how to use what it returns.
		expect(description).toContain("browser_open({ stage, stageApp })");
		expect(description).toContain("stage_login({ app, role })");
		// The OAuth 2.0 tools keep the same promise: the token is the server's.
		const api = toolNamed(extension, "stage_api_request").description ?? "";
		expect(api).toContain("Do not send an `Authorization` header");
		expect(api).toContain("the server attaches the role's bearer token");
		const token = toolNamed(extension, "stage_token_info").description ?? "";
		expect(token).toContain("four presentation fields");
		expect(token).toContain("no value");
	});

	test("it reads the owner capability and answers the catalog without a value", async () => {
		const { deps } = seeded();
		const calls: Call[] = [];
		const server = routeFetch(deps, "workflow:wf-alpha", calls);
		const result = await toolOf(
			createStageExtension(lookup(RUN_ENV), { fetch: server }),
		).execute({}, { conversationId: 1 }, {});
		expect(result.isError).toBeUndefined();
		const text = textOf(result.output);

		// The read presented the run's own capability, on the agent surface.
		expect(calls).toHaveLength(1);
		expect(calls[0]?.url).toBe(`http://127.0.0.1:4050${AGENT_STAGES_PATH}`);
		expect(calls[0]?.authorization).toBe("Bearer capability-for-wf-alpha");
		expect(calls[0]?.owner).toBe("workflow:wf-alpha");

		// The structure an agent needs to decide what to drive.
		expect(text).toContain("grid-int");
		expect(text).toContain("Grid integration");
		expect(text).toContain("read-only");
		expect(text).toContain("https://grid-int.example.test");
		expect(text).toContain("clerk");
		expect(text).toContain("web-form");
		expect(text).toContain("https://login.example.test");

		// Credential *presence*: the name to set, and the fact that the other one
		// is there.
		expect(text).toContain("missing GRID_INT_CLERK_PASSWORD");
		expect(text).toContain("set");

		// A refused file is named with its diagnostics, so "my stage is not here"
		// has an answer.
		expect(text).toContain("grid-prod.json");
		expect(text).toContain("production-like");

		// And no value of any kind: not the one the `.env` holds, and the variable
		// it belongs to is named rather than quoted.
		expect(text).not.toContain(PASSWORD_SENTINEL);
		expect(text).not.toContain(USERNAME_SENTINEL);
	});

	test("one stage by ident, and an unknown stage answers the route's own code", async () => {
		const { deps } = seeded();
		const calls: Call[] = [];
		const entity = createStageExtension(lookup(RUN_ENV), {
			fetch: routeFetch(deps, "workflow:wf-alpha", calls),
		});
		const one = await toolOf(entity).execute(
			{ stage: "grid-int" },
			{ conversationId: 1 },
			{},
		);
		expect(one.isError).toBeUndefined();
		expect(calls[0]?.url).toBe(
			`http://127.0.0.1:4050${AGENT_STAGES_PATH}/grid-int`,
		);
		const listed = JSON.parse(textOf(one.output)) as {
			stages: Array<{ ident: string }>;
		};
		expect(listed.stages.map((stage) => stage.ident)).toEqual(["grid-int"]);

		const missing = await toolOf(entity).execute(
			{ stage: "grid-nope" },
			{ conversationId: 1 },
			{},
		);
		expect(missing.isError).toBe(true);
		// The failure carries the route's machine-readable code, so a run can tell
		// a typo from a refused file.
		expect(textOf(missing.output)).toContain("[stage-not-configured]");
	});

	test("a run without an environment capability is told the tool is unavailable", async () => {
		const { env } = { env: { ...RUN_ENV } };
		delete (env as Record<string, string>).AGENTIC_ENV_TOKEN;
		const result = await toolOf(
			createStageExtension(lookup(env as Record<string, string>)),
		).execute({}, { conversationId: 1 }, {});
		expect(result.isError).toBe(true);
		expect(textOf(result.output)).toContain("no agent environment capability");
	});
});

describe("stage_api_request", () => {
	test("it posts the call to the agent surface with the run's own capability", async () => {
		const calls: PostedCall[] = [];
		const server = postedFetch(calls, {
			stage: "grid-int",
			app: "api",
			role: "service",
			method: "GET",
			url: "https://grid-int-api.example.test/v1/requests",
			status: 200,
			headers: { "content-type": "application/json" },
			body: '{"ok":true}',
			truncated: false,
			bytes: 11,
			renewals: 0,
		});
		const result = await toolNamed(
			createStageExtension(lookup(RUN_ENV), { fetch: server }),
			"stage_api_request",
		).execute(
			{
				stage: "grid-int",
				role: "service",
				method: "GET",
				path: "/v1/requests?limit=5",
			},
			{ conversationId: 1 },
			{},
		);
		expect(result.isError).toBeUndefined();
		expect(calls).toHaveLength(1);
		expect(calls[0]?.url).toBe(
			`http://127.0.0.1:4050${AGENT_STAGE_API_REQUEST_PATH}`,
		);
		expect(calls[0]?.method).toBe("POST");
		// The run's own capability authenticates the *tool call*; the role's bearer
		// token is the server's to attach and never travels through here.
		expect(calls[0]?.authorization).toBe("Bearer capability-for-wf-alpha");
		expect(calls[0]?.owner).toBe("workflow:wf-alpha");
		expect(calls[0]?.body).toEqual({
			stage: "grid-int",
			role: "service",
			method: "GET",
			path: "/v1/requests?limit=5",
		});
		// The answer is what the model reads, unchanged.
		expect(textOf(result.output)).toContain('"renewals": 0');
	});

	test("a refused call answers the route's code, and the tool is told what it omitted", async () => {
		const calls: PostedCall[] = [];
		const server = refusingFetch(calls, {
			code: "stage-app-ambiguous",
			message: "two apps",
		});
		const result = await toolNamed(
			createStageExtension(lookup(RUN_ENV), { fetch: server }),
			"stage_api_request",
		).execute(
			{ role: "service", method: "DELETE", path: "/v1/requests/1" },
			{ conversationId: 1 },
			{},
		);
		expect(calls).toHaveLength(1);
		expect(calls[0]?.url).toBe(
			`http://127.0.0.1:4050${AGENT_STAGE_API_REQUEST_PATH}`,
		);
		// What the tool sent is what the model asked for, and the omitted fields are
		// omitted rather than invented.
		expect(calls[0]?.body).toEqual({
			role: "service",
			method: "DELETE",
			path: "/v1/requests/1",
		});
		expect(result.isError).toBe(true);
		expect(textOf(result.output)).toContain("[stage-app-ambiguous]");
	});

	test("query parameters travel as an object, next to the path", async () => {
		const calls: PostedCall[] = [];
		const server = postedFetch(calls, { status: 200, body: "[]" });
		const result = await toolNamed(
			createStageExtension(lookup(RUN_ENV), { fetch: server }),
			"stage_api_request",
		).execute(
			{
				role: "service",
				method: "GET",
				path: "/v1/requests",
				query: { limit: "5" },
			},
			{ conversationId: 1 },
			{},
		);
		expect(result.isError).toBeUndefined();
		expect(calls[0]?.body).toEqual({
			role: "service",
			method: "GET",
			path: "/v1/requests",
			query: { limit: "5" },
		});
	});

	test("a rate limit reaches the model with the wait it has to observe", async () => {
		const calls: PostedCall[] = [];
		const server = refusingFetch(
			calls,
			{
				code: "stage-rate-limit",
				message:
					"stage grid-int allows 60 stage calls per minute in this workflow",
				retryAfterMs: 30_000,
			},
			429,
		);
		const result = await toolNamed(
			createStageExtension(lookup(RUN_ENV), { fetch: server }),
			"stage_api_request",
		).execute(
			{ role: "service", method: "GET", path: "/v1/requests" },
			{ conversationId: 1 },
			{},
		);
		expect(result.isError).toBe(true);
		const text = textOf(result.output);
		expect(text).toContain("[stage-rate-limit]");
		// A limit without its wait is a poll loop; the number the route sent is the
		// one the model has to see (USAB-005).
		expect(text).toContain("retry in 30 s");
	});

	test("a body far above the result bound is cut inside itself, so the envelope still parses", async () => {
		const calls: PostedCall[] = [];
		// Bigger than the whole tool result bound: the body is the only thing a cut
		// may remove, and the fields that say what happened have to survive it
		// (USAB-001).
		const big = "z".repeat(200 * 1024);
		const server = postedFetch(calls, {
			status: 200,
			body: big,
			truncated: false,
			bytes: big.length,
			renewals: 0,
		});
		const result = await toolNamed(
			createStageExtension(lookup(RUN_ENV), { fetch: server }),
			"stage_api_request",
		).execute(
			{ role: "service", method: "GET", path: "/big" },
			{ conversationId: 1 },
			{},
		);
		expect(result.isError).toBeUndefined();
		const text = textOf(result.output);
		expect(text.length).toBeLessThanOrEqual(40_000);
		const parsed = JSON.parse(text) as Record<string, unknown>;
		expect(parsed.status).toBe(200);
		expect(parsed.truncated).toBe(true);
		expect(parsed.bytes).toBe(big.length);
		expect(parsed.renewals).toBe(0);
		expect(String(parsed.body).length).toBeLessThan(big.length);
		expect(String(parsed.body)).toContain("body truncated");
	});
});

describe("stage_token_info", () => {
	test("it posts the target and answers the four fields the server chose to present", async () => {
		const calls: PostedCall[] = [];
		const server = postedFetch(calls, {
			stage: "grid-int",
			app: "api",
			role: "service",
			expiresAt: 1_767_229_200_000,
			scopes: ["grid.read"],
			audience: "https://grid-int-api.example.test",
			issuer: "https://idp.example.test",
		});
		const result = await toolNamed(
			createStageExtension(lookup(RUN_ENV), { fetch: server }),
			"stage_token_info",
		).execute(
			{ stage: "grid-int", role: "service" },
			{ conversationId: 1 },
			{},
		);
		expect(result.isError).toBeUndefined();
		expect(calls[0]?.url).toBe(
			`http://127.0.0.1:4050${AGENT_STAGE_TOKEN_INFO_PATH}`,
		);
		expect(calls[0]?.body).toEqual({ stage: "grid-int", role: "service" });
		const text = textOf(result.output);
		// Epoch milliseconds, exactly as the contract documents it, and nothing the
		// token holds beyond the four presentation fields (USAB-002).
		expect(text).toContain("1767229200000");
		expect(text).toContain("https://idp.example.test");
		expect(text).not.toContain("access");
	});
});
