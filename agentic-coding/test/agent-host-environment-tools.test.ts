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
import { actionProgressResponse } from "../src/server/environment/action-progress-stream.ts";

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
		output: Array<{ type: string; text: string }>;
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
	toolPolicy: "default",
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
		text: result.output.map((block) => block.text).join(""),
		isError: result.isError === true,
		progress,
	};
}

describe("environment tool surface", () => {
	test("build progress uses the authenticated stream and publishes live structured details", async () => {
		let finish: ((value: unknown) => void) | undefined;
		let progressed: (() => void) | undefined;
		const observed = new Promise<void>((resolve) => {
			progressed = resolve;
		});
		const snapshots: unknown[] = [];
		const send = (async (_input: unknown, init?: RequestInit) => {
			const headers = new Headers(init?.headers);
			expect(headers.get("accept")).toBe("application/x-ndjson");
			expect(headers.get(ENVIRONMENT_OWNER_HEADER)).toBe("workflow:wf-alpha");
			expect(headers.get("authorization")).toBe(
				"Bearer capability-for-wf-alpha",
			);
			return actionProgressResponse(
				async (publish) => {
					publish({ output: "first", status: "running" });
					return new Promise((resolve) => {
						finish = resolve;
					});
				},
				(value) => value,
				() => ({ code: "failed", message: "failed" }),
			);
		}) as typeof fetch;
		const extension = createEnvironmentExtension(lookup, { fetch: send });
		const result = toolOf(extension, "env_build").execute(
			{ app: "demo" },
			{
				conversationId: 1,
				details: async (value: unknown) => {
					snapshots.push(value);
					progressed?.();
				},
			},
			{},
		);
		await observed;
		expect(snapshots).toEqual([
			{ view: { output: "first", status: "running" } },
		]);
		finish?.({ output: "first\nlast", status: "completed", exitCode: 0 });
		const completed = await result;
		expect(JSON.parse(completed.output[0]?.text ?? "null")).toMatchObject({
			output: "first\nlast",
			status: "completed",
			exitCode: 0,
		});
	});
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

	test("env_list forwards the detail and the app it was asked about", async () => {
		const server: FakeServer = { calls: [], replies: [{ apps: [] }] };
		await invoke("env_list", { detail: "full" }, server);
		await invoke("env_list", { app: "shop" }, server);
		expect(server.calls.map((call) => call.url)).toEqual([
			"http://127.0.0.1:4050/api/v1/agent-env/list?detail=full",
			"http://127.0.0.1:4050/api/v1/agent-env/list?app=shop",
		]);
	});
});

// `evidence_attach` and `evidence_list` (`add-workflow-evidence-store`, task
// 3.1): the two tools every durable run is offered beside the `env_*` surface,
// the owner capability they present, the run's own working directory a relative
// path is resolved against, and the producing step and role they report.
describe("evidence tools", () => {
	const EVIDENCE_ENV = {
		HERDR_WORKFLOW_ID: "wf-alpha",
		HERDR_RUN_ID: "run-1",
		HERDR_STEP_ID: "core.implementation",
		HERDR_ROLE: "worker",
		AGENTIC_ENV_URL: "http://127.0.0.1:4050",
		AGENTIC_ENV_TOKEN: "capability-for-wf-alpha",
	};
	const evidenceLookup: RunContextLookup = () => ({
		runId: "run-1",
		cwd: "/tmp/evidence-run",
		env: EVIDENCE_ENV,
		toolPolicy: "default",
	});

	async function callEvidence(
		name: string,
		args: unknown,
		server: FakeServer,
	): Promise<{ text: string; isError: boolean }> {
		const extension = createEnvironmentExtension(evidenceLookup, {
			fetch: fakeFetch(server),
		});
		const result = await toolOf(extension, name).execute(args, apiOf([]), {});
		return {
			text: result.output.map((block) => block.text).join(""),
			isError: result.isError === true,
		};
	}

	test("attach reports the entry and names the producing step", async () => {
		const server: FakeServer = {
			calls: [],
			replies: [{ id: "01JCAAAAAAAAAAAAAAAAAAAAAA", kind: "screenshot" }],
		};
		const result = await callEvidence(
			"evidence_attach",
			{
				path: "/tmp/evidence-run/shot.png",
				kind: "screenshot",
				caption: "checkout, empty cart",
			},
			server,
		);
		expect(result.isError).toBe(false);
		expect(result.text).toContain("01JCAAAAAAAAAAAAAAAAAAAAAA");
		expect(server.calls[0]?.url).toBe(
			"http://127.0.0.1:4050/api/v1/agent-env/evidence/attach",
		);
		expect(server.calls[0]?.owner).toBe("workflow:wf-alpha");
		expect(server.calls[0]?.body).toEqual({
			path: "/tmp/evidence-run/shot.png",
			kind: "screenshot",
			caption: "checkout, empty cart",
			step: "core.implementation",
			role: "worker",
		});
	});

	test("a report attach forwards the flag, and an ordinary attach does not", async () => {
		const server: FakeServer = {
			calls: [],
			replies: [{ id: "01JCAAAAAAAAAAAAAAAAAAAAAA", kind: "other" }],
		};
		await callEvidence(
			"evidence_attach",
			{
				path: "/tmp/evidence-run/report.md",
				kind: "other",
				caption: "run report",
				report: true,
			},
			server,
		);
		expect(server.calls[0]?.body).toEqual({
			path: "/tmp/evidence-run/report.md",
			kind: "other",
			caption: "run report",
			step: "core.implementation",
			role: "worker",
			report: true,
		});
		// The flag is absent unless it was set: an allow-list body that always
		// carried `report: false` would make every attachment look like a decision
		// about the run's report.
		await callEvidence(
			"evidence_attach",
			{
				path: "/tmp/evidence-run/notes.md",
				kind: "other",
				caption: "notes",
			},
			server,
		);
		expect(server.calls[1]?.body).not.toHaveProperty("report");
	});

	test("a relative path is resolved against the run's own directory", async () => {
		const server: FakeServer = { calls: [], replies: [{ id: "x" }] };
		await callEvidence(
			"evidence_attach",
			{ path: "artifacts/shot.png", kind: "screenshot", caption: "shot" },
			server,
		);
		expect(server.calls[0]?.body).toMatchObject({
			path: "/tmp/evidence-run/artifacts/shot.png",
		});
	});

	test("a request id narrows where the entry is stored", async () => {
		const server: FakeServer = { calls: [], replies: [{ id: "x" }] };
		await callEvidence(
			"evidence_attach",
			{
				path: "/tmp/evidence-run/trace.zip",
				kind: "trace",
				caption: "trace",
				requestId: "42",
			},
			server,
		);
		expect(server.calls[0]?.body).toMatchObject({ requestId: "42" });
	});

	test("list reads the manifest, narrowed to one request", async () => {
		const server: FakeServer = { calls: [], replies: [{ entries: [] }] };
		const all = await callEvidence("evidence_list", {}, server);
		expect(all.isError).toBe(false);
		expect(server.calls[0]?.url).toBe(
			"http://127.0.0.1:4050/api/v1/agent-env/evidence",
		);
		await callEvidence("evidence_list", { requestId: "42" }, server);
		expect(server.calls[1]?.url).toBe(
			"http://127.0.0.1:4050/api/v1/agent-env/evidence?requestId=42",
		);
	});

	test("a refusal is reported as the tool's own failure", async () => {
		const server: FakeServer = {
			calls: [],
			replies: [
				{
					error: {
						code: "evidence-path",
						message: "resolves outside the workflow's checkout",
					},
				},
			],
		};
		const result = await callEvidence(
			"evidence_attach",
			{ path: "/etc/passwd", kind: "log", caption: "nope" },
			server,
		);
		expect(result.isError).toBe(true);
		expect(result.text).toContain("evidence_attach");
		expect(result.text).toContain("resolves outside");
	});

	test("both evidence tools are not replayable either", () => {
		const extension = createEnvironmentExtension(evidenceLookup, {
			fetch: fakeFetch({ calls: [], replies: [] }),
		});
		for (const name of ["evidence_attach", "evidence_list"])
			expect(toolOf(extension, name).replay).toBeUndefined();
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
			toolPolicy: "default",
		}));
		const result = await toolOf(extension, "env_start").execute(
			{ apps: ["shop"] },
			apiOf([]),
			{},
		);
		expect(result.isError).toBe(true);
		expect(result.output[0]?.text).toContain("no agent environment capability");
	});

	test("strict-schema null start options omit replicas for Docker", async () => {
		const server: FakeServer = { calls: [], replies: [{ outcome: "started" }] };
		const result = await invoke(
			"env_start",
			{
				apps: "shop",
				target: "Mocked",
				profile: null,
				runtime: "docker",
				replicas: null,
				timeoutSec: null,
			},
			server,
		);
		expect(result.isError).toBe(false);
		expect(server.calls[0]?.body).toMatchObject({
			apps: ["shop"],
			target: "Mocked",
			runtime: "docker",
		});
		expect(server.calls[0]?.body).not.toHaveProperty("replicas");
		expect(server.calls[0]?.body).not.toHaveProperty("profile");
	});

	test("a replica count is forwarded to the server, which owns the refusal", async () => {
		// Replicas are a Kubernetes start option: the tool passes the count on and
		// the slot controller decides (it refuses replicas of any other runtime).
		const server: FakeServer = { calls: [], replies: [{ outcome: "started" }] };
		const result = await invoke(
			"env_start",
			{ apps: ["shop"], runtime: "kubernetes", replicas: 2 },
			server,
		);
		expect(result.isError).toBe(false);
		expect(server.calls.length).toBe(1);
		expect(server.calls[0]?.body).toMatchObject({
			apps: ["shop"],
			runtime: "kubernetes",
			replicas: 2,
		});
	});
});
