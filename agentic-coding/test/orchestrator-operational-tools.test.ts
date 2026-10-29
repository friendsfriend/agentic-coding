import { expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
	createModels,
	fauxAssistantMessage,
	fauxProvider,
	fauxText,
	fauxToolCall,
} from "@earendil-works/pi-ai";
import { MemoryStorage } from "@earendil-works/pi-durable";
import { HostClient } from "../src/agent-host/client.ts";
import { environmentBindingOf } from "../src/agent-host/environment-capability.ts";
import { DurableHost } from "../src/agent-host/host.ts";
import { hostLayout } from "../src/agent-host/layout.ts";
import { createServerApp } from "../src/server/app.ts";
import {
	createInstanceAuthority,
	orchestratorTokenFor,
} from "../src/server/auth.ts";
import { CredentialRegistry } from "../src/server/credentials.ts";
import { TraceIndex } from "../src/server/debug/trace-index.ts";
import type { App } from "../src/server/environment/config.ts";
import type { EnvironmentAuthority } from "../src/server/environment/private-api.ts";
import { EventBroker } from "../src/server/events.ts";
import type { IntegrationServices } from "../src/server/integrations/routes.ts";

const orchestratorEnv = {
	AGENTIC_ORCHESTRATOR_URL: "http://localhost:4050",
	AGENTIC_ORCHESTRATOR_TOKEN: "orchestrator-capability",
};

test("operational bindings preserve workflow isolation and need a complete capability", () => {
	expect(environmentBindingOf(orchestratorEnv)).toEqual({
		url: orchestratorEnv.AGENTIC_ORCHESTRATOR_URL,
		token: orchestratorEnv.AGENTIC_ORCHESTRATOR_TOKEN,
		owner: "user",
	});
	expect(
		environmentBindingOf({ ...orchestratorEnv, HERDR_WORKFLOW_ID: "alpha" }),
	).toBeUndefined();
	expect(
		environmentBindingOf({
			...orchestratorEnv,
			HERDR_WORKFLOW_ID: "alpha",
			AGENTIC_ENV_URL: "http://workflow",
			AGENTIC_ENV_TOKEN: "workflow-capability",
		}),
	).toEqual({
		url: "http://workflow",
		token: "workflow-capability",
		owner: "workflow:alpha",
	});
	for (const env of [
		{},
		{ AGENTIC_ORCHESTRATOR_URL: "http://localhost" },
		{ AGENTIC_ORCHESTRATOR_TOKEN: "token" },
		{ AGENTIC_ENV_URL: "http://localhost", AGENTIC_ENV_TOKEN: "token" },
	] as Array<Record<string, string>>)
		expect(environmentBindingOf(env)).toBeUndefined();
});

test("the orchestrator can execute operational tools against the authenticated server without a workflow", async () => {
	const dir = fs.mkdtempSync(
		path.join(os.tmpdir(), "orchestrator-operations-"),
	);
	const logPath = path.join(dir, "app.log");
	fs.writeFileSync(
		logPath,
		"application failed: missing local configuration\n",
	);
	const app: App = {
		ident: "shop",
		displayName: "Shop",
		repositoryPath: "https://example.com/shop.git",
		appType: "APP",
		sourceType: "git",
		gitMode: "BRANCH",
		localDirectoryPath: dir,
		branch: "main",
	};
	const touches: string[] = [];
	const authority = createInstanceAuthority(
		"test-operations",
		"test-instance-token",
	);
	const serverApp = createServerApp({
		authority,
		events: new EventBroker(authority.instance),
		credentials: new CredentialRegistry(),
		configDir: dir,
		traceIndex: new TraceIndex(),
		environment: {
			manager: {
				getApps: () => [app],
				getAppByIdent: (ident: string) => (ident === "shop" ? app : undefined),
				getInfraServices: () => [],
			},
		} as unknown as EnvironmentAuthority,
		integrations: {
			instances: {
				slots: async () => [
					{
						app: "shop",
						holder: "workflow:other",
						status: "failed",
						waiters: [],
						endpoints: { api: "http://127.0.0.1:1" },
					},
				],
				runRecord: () => ({ status: "failed", runtime: "shell", logPath }),
				touchOwnedActivity: (owner: string) => touches.push(owner),
			},
		} as unknown as IntegrationServices,
	});
	const server = Bun.serve({
		hostname: "127.0.0.1",
		port: 0,
		fetch: (request) => serverApp.fetch(request),
	});
	const faux = fauxProvider();
	const models = createModels();
	models.setProvider(faux.provider);
	const host = await DurableHost.open({
		layout: hostLayout(dir),
		settings: {},
		globalAgentDir: dir,
		storage: new MemoryStorage(),
		models,
		orchestrator: true,
	});
	try {
		await host.listen();
		const runEnvPath = path.join(dir, "run.env");
		fs.writeFileSync(
			runEnvPath,
			`AGENTIC_ORCHESTRATOR_URL='http://127.0.0.1:${server.port}'\nAGENTIC_ORCHESTRATOR_TOKEN='${orchestratorTokenFor(authority.token)}'\n`,
		);
		await host.ensureRun({
			runId: "orchestrator",
			name: "orchestrator",
			cwd: dir,
			runEnvPath,
			model: `${faux.getModel().provider}/${faux.getModel().id}`,
			toolPolicy: "orchestrator",
		});
		let frame: unknown;
		const stop = await new HostClient(hostLayout(dir).socketPath).watch(
			"orchestrator",
			(value) => {
				frame = value;
			},
		);
		stop();
		const docs = (frame as { docs: Record<string, { tools: string[] }> }).docs;
		const offered = docs["pi.agent"].tools;
		for (const name of [
			"read",
			"write",
			"edit",
			"bash",
			"grep",
			"env_list",
			"env_logs",
			"env_start",
			"env_stop",
			"env_status",
			"env_build",
			"env_test",
			"otel_query",
			"db_query",
			"http_request",
			"browser_open",
			"browser_snapshot",
			"browser_close",
			"stage_info",
			"stage_api_request",
			"stage_login",
			"start_workflow",
			"scheduling",
			"scheduling_destination",
		])
			expect(offered).toContain(name);
		for (const name of ["developer_question", "agent_ask", "debug_request"])
			expect(offered).not.toContain(name);
		const calls: Array<[string, Parameters<typeof fauxToolCall>[1]]> = [
			["env_list", {}],
			["env_logs", { app: "shop" }],
			["otel_query", {}],
			["stage_info", {}],
			["http_request", { app: "shop", endpoint: "api", path: "/" }],
		];
		faux.setResponses([
			...calls.map(([name, args]) =>
				fauxAssistantMessage([fauxToolCall(name, args)], {
					stopReason: "toolUse",
				}),
			),
			fauxAssistantMessage([fauxText("done")]),
		]);
		await host.submit("orchestrator", "inspect this failed app", "inspect-1");
		let results: Array<{ text: string; error: boolean }> = [];
		for (let attempt = 0; attempt < 200; attempt++) {
			results = (await host.entriesForTest("orchestrator")).flatMap((entry) => {
				const record = entry as {
					kind?: string;
					model?: Array<{
						content?: Array<{ type: string; text?: string }>;
						isError?: boolean;
					}>;
				};
				if (record.kind !== "pi.tool-result") return [];
				const message = record.model?.[0];
				return [
					{
						text: (message?.content ?? [])
							.map((block) => block.text ?? "")
							.join(""),
						error: message?.isError === true,
					},
				];
			});
			if (results.length === calls.length) break;
			await Bun.sleep(20);
		}
		expect(results).toHaveLength(calls.length);
		expect(results[0].text).toContain("shop");
		expect(results[1].text).toContain(
			"application failed: missing local configuration",
		);
		expect(results[2].text).toContain("traces");
		for (const result of results.slice(0, 4)) expect(result.error).toBe(false);
		// Access to diagnostics is not permission to query another holder's app.
		expect(results[4].text).toContain("held by workflow:other");
		expect(touches.length).toBeGreaterThan(0);
		expect(touches.every((owner) => owner === "user")).toBe(true);
	} finally {
		await host.shutdown();
		await server.stop(true);
		fs.rmSync(dir, { recursive: true, force: true });
	}
});
