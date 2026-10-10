// The `agentic.environment` tool surface (`add-agent-environment-tools`, tasks
// 3.1/3.2): the seven tools every durable run is offered, the owner capability
// they present, and the blocking `env_start` loop — progress, kept position,
// `still-waiting`, `deadlock`, `released-by-developer` and abort — against a
// fake server with an injected clock.
import { describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createModels, fauxProvider } from "@earendil-works/pi-ai";
import { type Extension, MemoryStorage } from "@earendil-works/pi-durable";
import { HostClient } from "../src/agent-host/client.ts";
import { ENVIRONMENT_OWNER_HEADER } from "../src/agent-host/environment-capability.ts";
import { createEnvironmentExtension } from "../src/agent-host/environment-tools.ts";
import { DurableHost } from "../src/agent-host/host.ts";
import { hostLayout } from "../src/agent-host/layout.ts";
import type { RunContextLookup } from "../src/agent-host/tools.ts";

const ENV_TOOLS = [
	"env_list",
	"env_start",
	"env_status",
	"env_stop",
	"env_build",
	"env_test",
	"env_logs",
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
	/** Answers one call per entry; the last entry repeats. */
	readonly replies: unknown[];
	/** Rejects every request, as an aborted or unreachable transport does. */
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
	readonly replay?: "safe" | "unsafe";
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

/** A tool api as the harness builds it, reduced to what these tools read. */
function apiOf(progress: string[], onOutput?: () => void): unknown {
	return {
		conversationId: 1,
		output: (chunk: string) => {
			progress.push(chunk);
			onOutput?.();
		},
	};
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
	options: {
		now?: () => number;
		progress?: string[];
		context?: unknown;
		onProgress?: () => void;
	} = {},
): Promise<{ text: string; isError: boolean; progress: string[] }> {
	const extension = createEnvironmentExtension(lookup, {
		fetch: fakeFetch(server),
		now: options.now,
		sleep: async () => {},
	});
	const progress = options.progress ?? [];
	const result = await toolOf(extension, name).execute(
		args,
		apiOf(progress, options.onProgress),
		options.context ?? {},
	);
	return {
		text: result.content.map((block) => block.text).join(""),
		isError: result.isError === true,
		progress,
	};
}

describe("environment tool surface", () => {
	test("a read-only run is offered every environment tool and still no write or edit", async () => {
		// A verifier must be able to start and read the app it verifies, so the
		// environment tools are installed for every durable run, read-only runs
		// included — while the read-only policy keeps `write`/`edit` out.
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), "env-tools-"));
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
			for (const name of ENV_TOOLS) expect(readOnly).toContain(name);
			expect(readOnly).not.toContain("write");
			expect(readOnly).not.toContain("edit");
		} finally {
			await host.shutdown();
			fs.rmSync(dir, { recursive: true, force: true });
		}
	});

	test("no environment tool is replayable after an interruption", () => {
		const extension = createEnvironmentExtension(lookup, {
			fetch: fakeFetch({ calls: [], replies: [] }),
		});
		for (const name of ENV_TOOLS)
			expect(toolOf(extension, name).replay).toBeUndefined();
	});

	test("every call presents the owner capability the run was given", async () => {
		const server: FakeServer = { calls: [], replies: [{ apps: [] }] };
		await invoke("env_list", {}, server);
		await invoke("env_status", { app: "shop" }, server);
		await invoke("env_logs", { app: "shop", tail: 5 }, server);
		await invoke("env_stop", { app: "shop" }, server);
		await invoke("env_build", { app: "shop" }, server);
		await invoke("env_test", { app: "shop" }, server);
		expect(server.calls.map((call) => call.url)).toEqual([
			"http://127.0.0.1:4050/api/v1/agent-env/list",
			"http://127.0.0.1:4050/api/v1/agent-env/status?app=shop",
			"http://127.0.0.1:4050/api/v1/agent-env/logs?app=shop&tail=5",
			"http://127.0.0.1:4050/api/v1/agent-env/stop",
			"http://127.0.0.1:4050/api/v1/agent-env/build",
			"http://127.0.0.1:4050/api/v1/agent-env/test",
		]);
		for (const call of server.calls) {
			expect(call.owner).toBe("workflow:wf-alpha");
			expect(call.authorization).toBe("Bearer capability-for-wf-alpha");
		}
		expect(server.calls[3]?.body).toEqual({ app: "shop" });
	});
});

describe("env_start waits for a held app", () => {
	test("a held app is waited out and reported as progress, then the start is returned", async () => {
		const server: FakeServer = {
			calls: [],
			replies: [
				{
					outcome: "waiting",
					apps: ["customer-mw"],
					positions: { "customer-mw": 1 },
					holders: { "customer-mw": "workflow:b" },
				},
				{
					outcome: "started",
					owner: "workflow:wf-alpha",
					apps: [
						{
							app: "customer-mw",
							endpoints: { http: "http://127.0.0.1:8080" },
						},
					],
				},
			],
		};
		const result = await invoke("env_start", { apps: "customer-mw" }, server);
		expect(result.isError).toBe(false);
		expect(result.text).toContain('"outcome": "started"');
		expect(result.text).toContain("http://127.0.0.1:8080");
		// The wait is visible while it happens, with the position and the holder.
		expect(result.progress.join("")).toContain(
			"waiting for customer-mw, position 1, held by workflow:b",
		);
		// Re-polling keeps the same request: the queue entry is the position.
		expect(server.calls.map((call) => call.body?.apps)).toEqual([
			["customer-mw"],
			["customer-mw"],
		]);
		expect(server.calls[0]?.body?.waitSec).toBe(300);
	});

	test("the timeout returns still-waiting with the current position instead of blocking forever", async () => {
		const server: FakeServer = {
			calls: [],
			replies: [
				{
					outcome: "waiting",
					apps: ["customer-mw"],
					positions: { "customer-mw": 2 },
					holders: { "customer-mw": "workflow:b" },
				},
			],
		};
		// A clock that jumps a minute per read gets past a one-second timeout on
		// the first poll, so the loop is exercised without waiting.
		let ticks = 0;
		const result = await invoke(
			"env_start",
			{ apps: ["customer-mw"], timeoutSec: 1 },
			server,
			{ now: () => ticks++ * 60_000 },
		);
		expect(result.isError).toBe(false);
		expect(result.text).toContain('"outcome": "still-waiting"');
		expect(result.text).toContain('"customer-mw": 2');
		expect(result.text).toContain("call env_start again");
		expect(server.calls.length).toBe(1);
	});

	test("a deadlock is answered immediately, with the way out", async () => {
		const server: FakeServer = {
			calls: [],
			replies: [
				{
					outcome: "deadlock",
					message: "deadlock: workflow:wf-alpha -> workflow:b",
				},
			],
		};
		const result = await invoke("env_start", { apps: ["customer-mw"] }, server);
		expect(result.isError).toBe(true);
		expect(result.text).toContain("deadlock");
		expect(result.text).toContain("workflow:wf-alpha -> workflow:b");
		// The one answer the agent must act on says how to leave it.
		expect(result.text).toContain("Stop an app you hold");
		expect(server.calls.length).toBe(1);
	});

	test("a cancelled wait is reported as the tool's own outcome", async () => {
		const server: FakeServer = {
			calls: [],
			replies: [
				{ outcome: "cancelled", owner: "workflow:wf-alpha", apps: ["shop"] },
			],
		};
		const result = await invoke("env_start", { apps: ["shop"] }, server);
		expect(result.isError).toBe(true);
		expect(result.text).toBe("env_start: cancelled");
	});

	test("an abort while the request is in flight is not a raw transport message", async () => {
		const controller = new AbortController();
		controller.abort();
		const result = await invoke(
			"env_start",
			{ apps: ["shop"] },
			{ calls: [], replies: [], fail: true },
			{ context: { abortSignal: controller.signal } },
		);
		expect(result.isError).toBe(true);
		expect(result.text).toBe("env_start: cancelled");
	});

	test("the target, profile and runtime the caller named reach the server", async () => {
		const server: FakeServer = {
			calls: [],
			replies: [{ outcome: "started", owner: "workflow:wf-alpha", apps: [] }],
		};
		await invoke(
			"env_start",
			{
				apps: ["shop"],
				target: "app/shop/run/docker/default",
				profile: "dev",
				runtime: "shell",
			},
			server,
		);
		expect(server.calls[0]?.body).toMatchObject({
			apps: ["shop"],
			target: "app/shop/run/docker/default",
			profile: "dev",
			runtime: "shell",
		});
	});

	test("a developer release is surfaced instead of restarting the app", async () => {
		const server: FakeServer = {
			calls: [],
			replies: [
				{
					outcome: "released-by-developer",
					notice: "the developer released these apps",
				},
			],
		};
		const result = await invoke("env_start", { apps: ["shop"] }, server);
		expect(result.isError).toBe(true);
		expect(result.text).toContain("the developer released these apps");
		expect(server.calls.length).toBe(1);
	});

	test("an abort stops the loop instead of re-polling", async () => {
		const controller = new AbortController();
		const server: FakeServer = {
			calls: [],
			replies: [
				{
					outcome: "waiting",
					positions: { shop: 1 },
					holders: { shop: "workflow:b" },
				},
			],
		};
		const result = await invoke("env_start", { apps: ["shop"] }, server, {
			context: { abortSignal: controller.signal },
			// A developer cancels the wait as soon as it reports progress, which is
			// the moment the loop would otherwise re-poll.
			onProgress: () => controller.abort(),
		});
		expect(server.calls.length).toBe(1);
		expect(result.isError).toBe(true);
		expect(result.text).toContain("env_start: cancelled");
	});

	test("a request without a capability is refused before any call", async () => {
		const extension = createEnvironmentExtension(() => ({
			runId: "run-1",
			cwd: "/tmp",
			env: { HERDR_WORKFLOW_ID: "wf-alpha" },
		}));
		const result = await toolOf(extension, "env_start").execute(
			{ apps: ["shop"] },
			apiOf([]),
			{},
		);
		expect(result.isError).toBe(true);
		expect(result.content[0]?.text).toContain(
			"no agent environment capability",
		);
	});

	test("replicas beyond one copy is refused instead of silently ignored", async () => {
		const server: FakeServer = { calls: [], replies: [{ outcome: "started" }] };
		const result = await invoke(
			"env_start",
			{ apps: ["shop"], replicas: 2 },
			server,
		);
		expect(result.isError).toBe(true);
		expect(result.text).toContain("replicas is not supported");
		expect(server.calls.length).toBe(0);
	});
});
