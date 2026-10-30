import { expect, test } from "bun:test";
import fs from "node:fs";
import { createServer } from "node:http";
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
import { CODEMODE_TOOL_NAME } from "../src/agent-host/codemode.ts";
import { DurableHost } from "../src/agent-host/host.ts";
import { hostLayout } from "../src/agent-host/layout.ts";

test("reviewed Wiz reads work but direct and codemode MCP mutation dispatch never reaches the fake provider", async () => {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "digest-mcp-")),
		calls: string[] = [];
	const priorPiDir = process.env.PI_CODING_AGENT_DIR;
	process.env.PI_CODING_AGENT_DIR = root;
	const server = createServer((request, response) => {
		if (request.method !== "POST") {
			response.writeHead(request.method === "DELETE" ? 200 : 405).end();
			return;
		}
		let body = "";
		request.setEncoding("utf8");
		request.on("data", (value: string) => {
			body += value;
		});
		request.on("end", () => {
			const message = JSON.parse(body) as {
				id?: number;
				method: string;
				params?: { arguments?: { tool_name?: string } };
			};
			if (message.id === undefined) {
				response.writeHead(202).end();
				return;
			}
			let result: unknown;
			if (message.method === "initialize")
				result = {
					protocolVersion: "2025-03-26",
					capabilities: { tools: {} },
					serverInfo: { name: "synthetic-wiz", version: "1" },
				};
			else if (message.method === "tools/list")
				result = {
					tools: [
						{
							name: "execute",
							description: "Synthetic Wiz dispatcher",
							inputSchema: {
								type: "object",
								properties: {
									tool_name: { type: "string" },
									parameters: { type: "object" },
								},
								required: ["tool_name"],
							},
						},
					],
				};
			else if (message.method === "tools/call") {
				calls.push(message.params?.arguments?.tool_name ?? "missing");
				result = {
					content: [{ type: "text", text: "Synthetic issues page only" }],
				};
			}
			response.writeHead(200, { "content-type": "application/json" }).end(
				JSON.stringify({
					jsonrpc: "2.0",
					id: message.id,
					result: result ?? {},
				}),
			);
		});
	});
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	const address = server.address();
	if (!address || typeof address === "string")
		throw new Error("Synthetic MCP bind failed.");
	fs.writeFileSync(
		path.join(root, "mcp.json"),
		JSON.stringify({
			mcpServers: {
				wiz: {
					url: `http://127.0.0.1:${address.port}/mcp`,
					exposure: "direct",
				},
			},
		}),
	);
	fs.writeFileSync(
		path.join(root, "settings.json"),
		JSON.stringify({ defaultTools: ["+codemode"] }),
	);
	const env = path.join(root, "run.env");
	fs.writeFileSync(env, "");
	const faux = fauxProvider(),
		models = createModels();
	models.setProvider(faux.provider);
	const host = await DurableHost.open({
		layout: hostLayout(root),
		globalAgentDir: root,
		session: true,
		settings: { localPiTools: { enabled: true } },
		storage: new MemoryStorage(),
		models,
	});
	try {
		await host.ensureRun({
			runId: "pi-durable-mcp-policy",
			name: "pi-durable-mcp-policy",
			cwd: root,
			runEnvPath: env,
			toolPolicy: "collection",
			model: `${faux.getModel().provider}/${faux.getModel().id}`,
		});
		faux.setResponses([
			fauxAssistantMessage(
				[
					fauxToolCall("mcp__wiz__execute", {
						tool_name: "list_issues",
						parameters: {},
					}),
				],
				{ stopReason: "toolUse" },
			),
			fauxAssistantMessage(
				[
					fauxToolCall("mcp__wiz__execute", {
						tool_name: "delete_issue",
						parameters: {},
					}),
				],
				{ stopReason: "toolUse" },
			),
			fauxAssistantMessage(
				[
					fauxToolCall(CODEMODE_TOOL_NAME, {
						code: `try { await tools.mcp__wiz__execute({ tool_name: "delete_issue", parameters: {} }); } catch {} return "mutation attempted only against fake provider";`,
					}),
				],
				{ stopReason: "toolUse" },
			),
			fauxAssistantMessage([
				fauxText("Synthetic partial digest; mutations were not executed."),
			]),
		]);
		await host.submit("pi-durable-mcp-policy", "Synthetic only", "fake-input");
		for (
			let index = 0;
			index < 150 &&
			(await host.status("pi-durable-mcp-policy")).status !== "idle";
			index++
		)
			await new Promise((resolve) => setTimeout(resolve, 20));
		expect(calls).toEqual(["list_issues"]);
		expect(
			JSON.stringify(await host.entriesForTest("pi-durable-mcp-policy")),
		).toContain("not allowed by the run policy");
	} finally {
		await host.shutdown();
		server.closeAllConnections();
		await new Promise<void>((resolve) => server.close(() => resolve()));
		fs.rmSync(root, { force: true, recursive: true });
		if (priorPiDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
		else process.env.PI_CODING_AGENT_DIR = priorPiDir;
	}
}, 30_000);
