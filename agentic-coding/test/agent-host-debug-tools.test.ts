// The `agentic.debug` tool surface (`add-agent-debug-tools`, tasks 2.1-2.3):
// the three tools every durable run is offered, the owner capability they
// present, the paths and bodies they send, and how a refusal reaches the model.
import { describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createModels, fauxProvider } from "@earendil-works/pi-ai";
import { type Extension, MemoryStorage } from "@earendil-works/pi-durable";
import { HostClient } from "../src/agent-host/client.ts";
import { createDebugExtension } from "../src/agent-host/debug-tools.ts";
import { ENVIRONMENT_OWNER_HEADER } from "../src/agent-host/environment-capability.ts";
import { DurableHost } from "../src/agent-host/host.ts";
import { hostLayout } from "../src/agent-host/layout.ts";
import type { RunContextLookup } from "../src/agent-host/tools.ts";
import {
	AGENT_DB_QUERY_PATH,
	AGENT_HTTP_REQUEST_PATH,
	AGENT_OTEL_QUERY_PATH,
} from "../src/server/protocol.ts";

const DEBUG_TOOLS = ["otel_query", "db_query", "http_request"];

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
	/** Answers one call per entry; the last entry repeats. */
	readonly replies: unknown[];
	readonly fail?: boolean;
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
		if (server.fail) throw new Error("The operation was aborted.");
		const index = Math.min(server.calls.length - 1, server.replies.length - 1);
		const reply = server.replies[index] ?? {};
		if (typeof reply === "object" && reply !== null && "error" in reply)
			return Response.json({ ok: false, error: reply.error }, { status: 409 });
		return Response.json({ ok: true, value: reply });
	}) as unknown as typeof fetch;
}

interface Executable {
	readonly name: string;
	execute(
		args: unknown,
		api: unknown,
		context: unknown,
	): Promise<{
		content: Array<{ type: string; text: string }>;
		isError?: boolean;
	}>;
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
): Promise<{ text: string; isError: boolean; value: unknown }> {
	const extension = createDebugExtension(lookup, { fetch: fakeFetch(server) });
	const result = await toolOf(extension, name).execute(args, {}, {});
	const text = result.content.map((block) => block.text).join("");
	return {
		text,
		isError: result.isError === true,
		value: server.replies.length ? server.replies[0] : undefined,
	};
}

describe("debug tool surface", () => {
	test("a read-only run is offered every debug tool and still no write or edit", async () => {
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), "debug-tools-"));
		const layout = hostLayout(dir);
		const faux = fauxProvider();
		const models = createModels();
		models.setProvider(faux.provider);
		const host = await DurableHost.open({
			layout,
			settings: {},
			globalAgentDir: dir,
			storage: new MemoryStorage(),
			models,
		});
		await host.listen();
		try {
			const runEnvPath = path.join(dir, "run.env");
			fs.writeFileSync(runEnvPath, "");
			const client = new HostClient(layout.socketPath, 10_000);
			const offered = async (runId: string) => {
				await host.ensureRun({
					runId,
					name: runId,
					cwd: dir,
					runEnvPath,
					toolPolicy: "read-only",
				});
				let frame: unknown;
				const stop = await client.watch(runId, (value) => {
					frame = value;
				});
				stop();
				const docs =
					typeof frame === "object" && frame !== null
						? ((frame as { docs?: Record<string, unknown> }).docs ?? {})
						: {};
				const agent = (docs["pi.agent"] ?? {}) as { tools?: unknown };
				return Array.isArray(agent.tools) ? [...agent.tools] : undefined;
			};
			const readOnly = await offered("read-only-run");
			for (const name of DEBUG_TOOLS) expect(readOnly).toContain(name);
			expect(readOnly).not.toContain("write");
			expect(readOnly).not.toContain("edit");
		} finally {
			await host.shutdown();
			fs.rmSync(dir, { recursive: true, force: true });
		}
	});

	test("every call presents the owner capability and the tool's own path", async () => {
		const server: FakeServer = { calls: [], replies: [{ traces: [] }] };
		await invoke("otel_query", { app: "shop", limit: 5 }, server);
		await invoke("db_query", { infra: "orders-db", sql: "SELECT 1" }, server);
		await invoke("http_request", { app: "shop", endpoint: "api" }, server);
		expect(server.calls.map((call) => call.url)).toEqual([
			`http://127.0.0.1:4050${AGENT_OTEL_QUERY_PATH}`,
			`http://127.0.0.1:4050${AGENT_DB_QUERY_PATH}`,
			`http://127.0.0.1:4050${AGENT_HTTP_REQUEST_PATH}`,
		]);
		for (const call of server.calls) {
			expect(call.method).toBe("POST");
			expect(call.owner).toBe("workflow:wf-alpha");
			expect(call.authorization).toBe("Bearer capability-for-wf-alpha");
		}
		expect(server.calls[0]?.body).toEqual({ app: "shop", limit: 5 });
		expect(server.calls[1]?.body).toEqual({
			infra: "orders-db",
			sql: "SELECT 1",
		});
		expect(server.calls[2]?.body).toEqual({ app: "shop", endpoint: "api" });
	});

	test("http_request sends headers as the bounded pairs the contract takes", async () => {
		const server: FakeServer = { calls: [], replies: [{ status: 200 }] };
		await invoke(
			"http_request",
			{
				app: "shop",
				endpoint: "api",
				method: "POST",
				path: "/orders",
				headers: { accept: "application/json", "x-trace": "1" },
				body: "{}",
			},
			server,
		);
		expect(server.calls[0]?.body).toEqual({
			app: "shop",
			endpoint: "api",
			method: "POST",
			path: "/orders",
			headers: [
				{ name: "accept", value: "application/json" },
				{ name: "x-trace", value: "1" },
			],
			body: "{}",
		});
	});

	test("a refusal reaches the model with the server's code", async () => {
		const server: FakeServer = {
			calls: [],
			replies: [
				{
					error: {
						code: "app-not-held",
						message:
							"shop is held by workflow:other; this run does not hold it.",
					},
				},
			],
		};
		const result = await invoke(
			"http_request",
			{ app: "shop", endpoint: "api" },
			server,
		);
		expect(result.isError).toBe(true);
		expect(result.text).toContain("workflow:other");
		expect(result.text).toContain("[app-not-held]");
	});

	test("a large answer is truncated rather than flooding the session", async () => {
		const server: FakeServer = {
			calls: [],
			replies: [{ body: "z".repeat(60_000) }],
		};
		const result = await invoke(
			"http_request",
			{ app: "shop", endpoint: "api" },
			server,
		);
		expect(result.isError).toBe(false);
		expect(result.text.length).toBeLessThan(41_000);
		expect(result.text).toContain("truncated");
	});

	test("a run without the environment capability is told so, not crashed", async () => {
		const extension = createDebugExtension(() => ({
			runId: "run-1",
			cwd: "/tmp",
			env: {},
		}));
		const result = await toolOf(extension, "otel_query").execute({}, {}, {});
		expect(result.isError).toBe(true);
		expect(result.content[0]?.text).toContain(
			"no agent environment capability",
		);
	});
});
