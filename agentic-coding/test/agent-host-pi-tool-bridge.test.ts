import { afterEach, expect, test } from "bun:test";
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
import {
	defineTool,
	MemoryStorage,
	type Registry,
} from "@earendil-works/pi-durable";
import { TOOL_SEARCH_TOOL_NAME } from "@earendil-works/pi-durable/tool-search";
import { Type } from "typebox";
import { CODEMODE_TOOL_NAME } from "../src/agent-host/codemode.ts";
import { DurableHost } from "../src/agent-host/host.ts";
import { hostLayout } from "../src/agent-host/layout.ts";
import { piExtensionToolName } from "../src/agent-host/pi-tool-bridge.ts";
import { buildAgentSessionView } from "../src/tui/dash/agent-session.ts";

const roots: string[] = [];
const originalPiAgentDir = process.env.PI_CODING_AGENT_DIR;
afterEach(() => {
	for (const root of roots.splice(0))
		fs.rmSync(root, { recursive: true, force: true });
	if (originalPiAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
	else process.env.PI_CODING_AGENT_DIR = originalPiAgentDir;
});

function tempDir(): string {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "local-pi-bridge-"));
	roots.push(dir);
	return dir;
}

function setGlobalPiDir(dir: string): void {
	process.env.PI_CODING_AGENT_DIR = dir;
}

function writeRunEnv(dir: string): string {
	const file = path.join(dir, "run.env");
	fs.writeFileSync(file, "");
	return file;
}

function writeExtension(
	dir: string,
	source: string,
	fileName = "fixture.ts",
): string {
	const extensionDir = path.join(dir, "extensions");
	fs.mkdirSync(extensionDir, { recursive: true });
	const extensionPath = path.join(extensionDir, fileName);
	fs.writeFileSync(extensionPath, source);
	return extensionPath;
}

async function mockHttpMcp(): Promise<{
	url: string;
	requests: () => number;
	close: () => Promise<void>;
}> {
	let requestCount = 0;
	const server = createServer((request, response) => {
		if (request.method === "DELETE") {
			response.writeHead(200).end();
			return;
		}
		let body = "";
		request.setEncoding("utf8");
		request.on("data", (chunk: string) => {
			body += chunk;
		});
		request.on("end", () => {
			requestCount += 1;
			let message: {
				id?: number | string;
				method?: string;
				params?: Record<string, unknown>;
			};
			try {
				message = JSON.parse(body) as typeof message;
			} catch {
				response.writeHead(400).end();
				return;
			}
			if (message.method === "notifications/initialized") {
				response.writeHead(202).end();
				return;
			}
			const result =
				message.method === "initialize"
					? {
							protocolVersion: "2025-03-26",
							capabilities: { tools: {} },
							serverInfo: { name: "local-http-fixture", version: "1" },
						}
					: message.method === "tools/list"
						? {
								tools: [
									{
										name: "http_echo",
										description: "Echoes a local HTTP MCP message",
										inputSchema: {
											type: "object",
											properties: { text: { type: "string" } },
											required: ["text"],
										},
									},
									{
										name: "http_structured",
										description: "Returns an MCP structured result",
										inputSchema: { type: "object", properties: {} },
										outputSchema: {
											type: "object",
											properties: { value: { type: "string" } },
											required: ["value"],
										},
									},
									{
										name: "http_image",
										description: "Returns an MCP image result",
										inputSchema: { type: "object", properties: {} },
									},
									{
										name: "http_error",
										description: "Returns an MCP error result",
										inputSchema: { type: "object", properties: {} },
									},
								],
							}
						: message.method === "tools/call"
							? {
									content:
										message.params?.name === "http_image"
											? [
													{
														type: "image",
														data: "aGVsbG8=",
														mimeType: "image/png",
													},
												]
											: [
													{
														type: "text",
														text:
															message.params?.name === "http_structured"
																? "http-structured"
																: message.params?.name === "http_error"
																	? "http-error-detail"
																	: `http:${String(message.params?.arguments && (message.params.arguments as Record<string, unknown>).text)}`,
													},
												],
									...(message.params?.name === "http_structured"
										? { structuredContent: { value: "structured-value" } }
										: {}),
									...(message.params?.name === "http_error"
										? { isError: true }
										: {}),
								}
							: undefined;
			if (message.id === undefined) {
				response.writeHead(202).end();
				return;
			}
			if (result === undefined) {
				response.writeHead(200, { "content-type": "application/json" }).end(
					JSON.stringify({
						jsonrpc: "2.0",
						id: message.id,
						error: { code: -32601, message: "not found" },
					}),
				);
				return;
			}
			response
				.writeHead(200, {
					"content-type": "application/json",
					"mcp-session-id": "local-fixture-session",
					"mcp-protocol-version": "2025-03-26",
				})
				.end(JSON.stringify({ jsonrpc: "2.0", id: message.id, result }));
		});
	});
	await new Promise<void>((resolve, reject) => {
		server.once("error", reject);
		server.listen(0, "127.0.0.1", resolve);
	});
	const address = server.address();
	if (!address || typeof address === "string")
		throw new Error("local mock MCP server did not bind a TCP port");
	return {
		url: `http://127.0.0.1:${address.port}/mcp`,
		requests: () => requestCount,
		close: () =>
			new Promise<void>((resolve, reject) =>
				server.close((error) => (error ? reject(error) : resolve())),
			),
	};
}

async function mockAuthRequiredMcp(): Promise<{
	url: string;
	requests: () => number;
	close: () => Promise<void>;
}> {
	let requestCount = 0;
	const server = createServer((_request, response) => {
		requestCount += 1;
		response
			.writeHead(401, { "www-authenticate": 'Bearer realm="local-fixture"' })
			.end();
	});
	await new Promise<void>((resolve, reject) => {
		server.once("error", reject);
		server.listen(0, "127.0.0.1", resolve);
	});
	const address = server.address();
	if (!address || typeof address === "string")
		throw new Error("local mock auth MCP server did not bind a TCP port");
	return {
		url: `http://127.0.0.1:${address.port}/mcp`,
		requests: () => requestCount,
		close: () =>
			new Promise<void>((resolve, reject) =>
				server.close((error) => (error ? reject(error) : resolve())),
			),
	};
}

function extensionSource(eventsPath: string): string {
	return `
import { Type } from "typebox";
import fs from "node:fs";

export default (pi) => {
  pi.on("session_start", () => fs.appendFileSync(${JSON.stringify(eventsPath)}, "session-start\\n"));
  pi.on("session_shutdown", () => fs.appendFileSync(${JSON.stringify(eventsPath)}, "session-shutdown\\n"));
  pi.registerTool({
    name: "bridge_echo",
    label: "Bridge echo",
    description: "Echo input and the active working directory.",
    parameters: Type.Object({ value: Type.String() }),
    outputSchema: Type.Object({ value: Type.String() }),
    async execute(_id, params, signal, onUpdate, ctx) {
      onUpdate?.({ content: [{ type: "text", text: "progress-started" }], details: { phase: "started" } });
      await new Promise((resolve) => setTimeout(resolve, 50));
      fs.appendFileSync(${JSON.stringify(eventsPath)}, "echo\\n");
      return {
        content: [
          { type: "text", text: ctx.cwd + ":" + params.value },
          { type: "image", data: "aGVsbG8=", mimeType: "image/png", altText: "fixture" }
        ],
        details: { cwd: ctx.cwd },
        structuredContent: { value: params.value }
      };
    }
  });
  pi.registerTool({
    name: "bridge_deferred",
    description: "Deferred fixture tool for native codemode discovery.",
    exposure: "deferred",
    defaultActive: false,
    parameters: Type.Object({ value: Type.String() }),
    async execute(_id, params) {
      return { content: [{ type: "text", text: "deferred:" + params.value }] };
    }
  });
  pi.registerTool({
    name: "bridge_model_only",
    exposure: "model-only",
    parameters: Type.Object({}),
    async execute() {
      return { content: [{ type: "text", text: "model-only-result" }] };
    }
  });
  pi.registerTool({
    name: "bridge_hidden",
    exposure: "hidden",
    parameters: Type.Object({}),
    async execute() {
      return { content: [{ type: "text", text: "hidden-result" }] };
    }
  });
  pi.registerTool({
    name: "bridge_error",
    description: "Return an explicitly structured error.",
    parameters: Type.Object({}),
    outputSchema: Type.Object({ reason: Type.String() }),
    async execute() {
      return {
        content: [{ type: "text", text: "expected error" }],
        details: { safe: "detail" },
        structuredContent: { reason: "fixture" },
        isError: true
      };
    }
  });
  pi.registerTool({
    name: "bridge_wait",
    description: "Wait until the durable caller cancels this invocation.",
    parameters: Type.Object({}),
    async execute(_id, _params, signal) {
      fs.appendFileSync(${JSON.stringify(eventsPath)}, "started\\n");
      await new Promise((resolve, reject) => {
        if (signal?.aborted) {
          fs.appendFileSync(${JSON.stringify(eventsPath)}, "aborted\\n");
          reject(new Error("cancelled"));
          return;
        }
        signal?.addEventListener("abort", () => {
          fs.appendFileSync(${JSON.stringify(eventsPath)}, "aborted\\n");
          reject(new Error("cancelled"));
        }, { once: true });
      });
      return { content: [{ type: "text", text: "unexpected" }] };
    }
  });
};
`;
}

function boundedResultExtensionSource(): string {
	return `
export default (pi) => {
  pi.registerTool({
    name: "bridge_oversized_content",
    parameters: { type: "object", properties: {}, additionalProperties: false },
    async execute() {
      return { content: Array.from({ length: 257 }, () => ({ type: "text", text: "x" })) };
    }
  });
  pi.registerTool({
    name: "bridge_deep_structured",
    parameters: { type: "object", properties: {}, additionalProperties: false },
    async execute() {
      let value = "deep";
      for (let index = 0; index < 20; index += 1) value = { nested: value };
      return { content: [{ type: "text", text: "bounded" }], structuredContent: value };
    }
  });
};
`;
}

function cancellationResistantExtensionSource(
	eventsPath: string,
	releasePath: string,
): string {
	return `
import fs from "node:fs";
export default (pi) => {
  pi.on("session_shutdown", () => fs.appendFileSync(${JSON.stringify(eventsPath)}, "session-shutdown\\n"));
  pi.registerTool({
    name: "bridge_late_result",
    parameters: { type: "object", properties: {}, additionalProperties: false },
    async execute(_id, _params, signal) {
      fs.appendFileSync(${JSON.stringify(eventsPath)}, "started\\n");
      signal?.addEventListener("abort", () => {
        fs.appendFileSync(${JSON.stringify(eventsPath)}, "aborted\\n");
      }, { once: true });
      await new Promise((resolve) => {
        const poll = () => {
          if (fs.existsSync(${JSON.stringify(releasePath)})) resolve();
          else setTimeout(poll, 10);
        };
        poll();
      });
      fs.appendFileSync(${JSON.stringify(eventsPath)}, "resolved\\n");
      return { content: [{ type: "text", text: "late-success" }] };
    }
  });
};
`;
}

function nestedProbeExtensionSource(): string {
	return `
import { Type } from "typebox";
export default (pi) => {
  pi.registerTool({
    name: "nested_probe",
    parameters: Type.Object({ readPath: Type.String() }),
    async execute(_id, params, _signal, _onUpdate, ctx) {
      try {
        const available = ctx.tools.map((tool) => tool.name);
        const read = await ctx.executeTool("read", { path: params.readPath });
        const readText = read.result.content
          .filter((part) => part.type === "text")
          .map((part) => part.text)
          .join("\\n");
        return {
          content: [{
            type: "text",
            text: "readable=" + available.includes("read") + "; writable=" + available.includes("write") + "; content=" + readText
          }]
        };
      } catch (error) {
        return {
          content: [{ type: "text", text: "probe-error=" + (error instanceof Error ? error.message : String(error)) }],
          isError: true
        };
      }
    }
  });
};
`;
}

function orchestratorProbeExtensionSource(): string {
	return `
import { Type } from "typebox";
export default (pi) => {
  pi.registerTool({
    name: "policy_probe",
    parameters: Type.Object({ allowedName: Type.String(), deniedName: Type.String() }),
    async execute(_id, params, _signal, _onUpdate, ctx) {
      const names = ctx.tools.map((tool) => tool.name);
      const allowed = await ctx.executeTool(params.allowedName, { value: "nested" });
      const denied = await ctx.executeTool(params.deniedName, {});
      const allowedText = allowed.result.content
        .filter((part) => part.type === "text")
        .map((part) => part.text)
        .join("\\n");
      return {
        content: [{
          type: "text",
          text: "allowed-visible=" + names.includes(params.allowedName) + "; denied-visible=" + names.includes(params.deniedName) + "; allowed-error=" + allowed.isError + "; denied-error=" + denied.isError + "; result=" + allowedText
        }]
      };
    }
  });
};
`;
}

async function openHost(
	dir: string,
	restrictedAllow = { readOnly: [] as string[], orchestrator: [] as string[] },
	localPiToolsEnabled: boolean | undefined = true,
	orchestrator = false,
) {
	setGlobalPiDir(dir);
	const faux = fauxProvider();
	const models = createModels();
	models.setProvider(faux.provider);
	const logs: string[] = [];
	const host = await DurableHost.open({
		layout: hostLayout(dir),
		settings: {
			...(localPiToolsEnabled === undefined
				? {}
				: {
						localPiTools: {
							enabled: localPiToolsEnabled,
							restrictedAllow,
							replaySafe: [],
						},
					}),
		},
		globalAgentDir: dir,
		storage: new MemoryStorage(),
		models,
		...(orchestrator ? { orchestrator: true } : {}),
		log: (line) => logs.push(line),
	});
	return { host, faux, logs };
}

async function settle(host: DurableHost, runId: string): Promise<void> {
	let status = await host.status(runId);
	for (let index = 0; index < 150 && status.status !== "idle"; index += 1) {
		await new Promise((resolve) => setTimeout(resolve, 20));
		status = await host.status(runId);
	}
}

function toolReplay(host: DurableHost, name: string): string | undefined {
	const registry = (host as unknown as { registry: Registry }).registry;
	return registry
		.snapshot()
		.tools()
		.find(({ tool }) => tool.name === name)?.tool.replay;
}

function toolResultFailed(entries: readonly unknown[], name: string): boolean {
	for (const value of [...entries].reverse()) {
		if (typeof value !== "object" || value === null) continue;
		const entry = value as {
			kind?: string;
			model?: ReadonlyArray<{ toolName?: string; isError?: boolean }>;
		};
		if (entry.kind === "pi.tool-result" && entry.model?.[0]?.toolName === name)
			return entry.model[0].isError === true;
	}
	return false;
}

function toolResult(entries: readonly unknown[], name: string): string {
	for (const value of [...entries].reverse()) {
		if (typeof value !== "object" || value === null) continue;
		const entry = value as {
			kind?: string;
			model?: ReadonlyArray<{
				toolName?: string;
				content?: ReadonlyArray<{ type?: string; text?: string }>;
				isError?: boolean;
			}>;
		};
		if (entry.kind !== "pi.tool-result" || entry.model?.[0]?.toolName !== name)
			continue;
		return (
			entry.model[0].content
				?.flatMap((part) =>
					part.type === "text" && typeof part.text === "string"
						? [part.text]
						: [],
				)
				.join("\\n") ?? ""
		);
	}
	return "";
}

test("bridges user extensions to direct calls and native codemode without loading project files", async () => {
	const globalDir = tempDir();
	const projectDir = tempDir();
	const eventPath = path.join(globalDir, "events.log");
	const extensionPath = writeExtension(globalDir, extensionSource(eventPath));
	const projectExtension = writeExtension(
		projectDir,
		`
export default (pi) => pi.registerTool({
  name: "project_only",
  parameters: { type: "object", properties: {}, additionalProperties: false },
  async execute() { return { content: [{ type: "text", text: "project leaked" }] }; }
});
`,
	);
	fs.mkdirSync(path.join(projectDir, ".pi"), { recursive: true });
	fs.cpSync(
		path.dirname(projectExtension),
		path.join(projectDir, ".pi", "extensions"),
		{ recursive: true },
	);
	const projectMcpStarted = path.join(projectDir, "project-mcp-started");
	fs.writeFileSync(
		path.join(projectDir, ".pi", "mcp.json"),
		JSON.stringify({
			mcpServers: {
				project: {
					command: process.execPath,
					args: [
						"-e",
						`require("node:fs").writeFileSync(${JSON.stringify(projectMcpStarted)}, "started")`,
					],
				},
			},
		}),
	);
	fs.writeFileSync(
		path.join(globalDir, "settings.json"),
		JSON.stringify({ defaultTools: ["+codemode"] }),
	);
	fs.writeFileSync(path.join(projectDir, "note.txt"), "nested native read");
	const { host, faux, logs } = await openHost(globalDir);
	const directName = piExtensionToolName(extensionPath, "bridge_echo");
	const runEnvPath = writeRunEnv(projectDir);
	try {
		const directConversation = await host.ensureRun({
			runId: "bridge-direct",
			name: "bridge-worker",
			cwd: projectDir,
			runEnvPath,
			toolPolicy: "default",
			model: `${faux.getModel().provider}/${faux.getModel().id}`,
		});
		expect(fs.existsSync(projectMcpStarted)).toBe(false);
		const progressFrames: Array<{
			output: readonly string[];
			phase: unknown;
		}> = [];
		const stopWatching = await host.watchRun("bridge-direct", (value) => {
			const block = buildAgentSessionView(value).find(
				(candidate) =>
					candidate.pending && candidate.toolCall?.name === directName,
			);
			if (block)
				progressFrames.push({
					output: block.detail ?? [],
					phase: block.toolCall?.progress?.phase,
				});
		});
		try {
			faux.setResponses([
				fauxAssistantMessage([fauxToolCall(directName, { value: "direct" })], {
					stopReason: "toolUse",
				}),
				fauxAssistantMessage([fauxText("done")]),
			]);
			await host.submit(
				"bridge-direct",
				"call the local tool",
				"bridge-request",
			);
			await settle(host, "bridge-direct");
		} finally {
			stopWatching();
		}
		expect(
			progressFrames.some(
				(frame) =>
					frame.output.join("\\n").includes("progress-started") &&
					frame.phase === "started",
			),
		).toBe(true);
		const directEntries = await host.entriesForTest("bridge-direct");
		expect(Object.keys(host.toolDescriptionsForTest())).toContain(directName);
		expect(toolReplay(host, directName)).toBe("unsafe");
		expect(logs).not.toContain("local Pi bridge session initialization failed");
		const directText = toolResult(directEntries, directName);
		expect(directText).toContain(`${projectDir}:direct`);
		expect(JSON.stringify(directEntries)).toContain("image/png");
		expect(JSON.stringify(directEntries)).toContain('"value":"direct"');
		expect(fs.readFileSync(eventPath, "utf8")).toContain("echo");
		const modelOnlyName = piExtensionToolName(
			extensionPath,
			"bridge_model_only",
		);
		const hiddenName = piExtensionToolName(extensionPath, "bridge_hidden");
		expect(Object.keys(host.toolDescriptionsForTest())).toContain(
			modelOnlyName,
		);
		expect(Object.keys(host.toolDescriptionsForTest())).not.toContain(
			hiddenName,
		);
		faux.setResponses([
			fauxAssistantMessage([fauxToolCall(modelOnlyName, {})], {
				stopReason: "toolUse",
			}),
			fauxAssistantMessage([fauxText("done")]),
		]);
		await host.submit(
			"bridge-direct",
			"call the model-only tool",
			"bridge-model-only",
		);
		await settle(host, "bridge-direct");
		expect(
			toolResult(await host.entriesForTest("bridge-direct"), modelOnlyName),
		).toContain("model-only-result");
		faux.setResponses([
			fauxAssistantMessage(
				[
					fauxToolCall(CODEMODE_TOOL_NAME, {
						code: `try { return await tools.${modelOnlyName}({}); } catch { return "model-only-not-callable"; }`,
					}),
				],
				{ stopReason: "toolUse" },
			),
			fauxAssistantMessage([fauxText("done")]),
		]);
		await host.submit(
			"bridge-direct",
			"verify model-only tool is unavailable to codemode",
			"bridge-model-only-codemode",
		);
		await settle(host, "bridge-direct");
		expect(
			toolResult(
				await host.entriesForTest("bridge-direct"),
				CODEMODE_TOOL_NAME,
			),
		).toContain("model-only-not-callable");
		expect(Object.keys(host.toolDescriptionsForTest())).not.toContain(
			piExtensionToolName(
				path.join(projectDir, ".pi", "extensions", "fixture.ts"),
				"project_only",
			),
		);

		const errorName = piExtensionToolName(extensionPath, "bridge_error");
		faux.setResponses([
			fauxAssistantMessage([fauxToolCall(errorName, {})], {
				stopReason: "toolUse",
			}),
			fauxAssistantMessage([fauxText("done")]),
		]);
		await host.submit("bridge-direct", "call error fixture", "bridge-error");
		await settle(host, "bridge-direct");
		const errorEntries = await host.entriesForTest("bridge-direct");
		expect(toolResult(errorEntries, errorName)).toContain("expected error");
		expect(JSON.stringify(errorEntries)).toContain('"safe":"detail"');
		expect(JSON.stringify(errorEntries)).toContain('"isError":true');

		faux.setResponses([
			fauxAssistantMessage(
				[
					fauxToolCall(CODEMODE_TOOL_NAME, {
						code: `const found = await searchTools("deferred fixture"); if (!found.some((tool) => tool.name === "${piExtensionToolName(extensionPath, "bridge_deferred")}")) throw new Error("not discovered"); const structured = await tools.${directName}({ value: "codemode-structured" }); if (structured.value !== "codemode-structured") throw new Error("structured output missing"); let modelOnlyDenied = false; try { await tools.${modelOnlyName}({}); } catch { modelOnlyDenied = true; } if (!modelOnlyDenied) throw new Error("model-only tool became callable"); let hiddenDenied = false; try { await tools.${hiddenName}({}); } catch { hiddenDenied = true; } if (!hiddenDenied) throw new Error("hidden tool became callable"); return await tools.${piExtensionToolName(extensionPath, "bridge_deferred")}({ value: "codemode" });`,
					}),
				],
				{ stopReason: "toolUse" },
			),
			fauxAssistantMessage([fauxText("done")]),
		]);
		await host.submit(
			"bridge-direct",
			"call through codemode",
			"bridge-codemode",
		);
		await settle(host, "bridge-direct");
		const codemodeEntries = await host.entriesForTest("bridge-direct");
		expect(toolResult(codemodeEntries, CODEMODE_TOOL_NAME)).toContain(
			"deferred:codemode",
		);

		const deferredName = piExtensionToolName(extensionPath, "bridge_deferred");
		expect(toolReplay(host, deferredName)).toBe("unsafe");
		faux.setResponses([
			fauxAssistantMessage(
				[
					fauxToolCall(TOOL_SEARCH_TOOL_NAME, {
						query: "deferred fixture tool",
					}),
				],
				{ stopReason: "toolUse" },
			),
			fauxAssistantMessage(
				[fauxToolCall(deferredName, { value: "model-search" })],
				{ stopReason: "toolUse" },
			),
			fauxAssistantMessage([fauxText("done")]),
		]);
		await host.submit(
			"bridge-direct",
			"find and call the deferred integration",
			"bridge-tool-search",
		);
		await settle(host, "bridge-direct");
		const searchedEntries = await host.entriesForTest("bridge-direct");
		expect(toolResult(searchedEntries, deferredName)).toContain(
			"deferred:model-search",
		);

		const reboundDir = tempDir();
		await host.stopRun("bridge-direct");
		const rebound = await host.ensureRun({
			runId: "bridge-rebound",
			name: "bridge-worker",
			cwd: reboundDir,
			runEnvPath: writeRunEnv(reboundDir),
			toolPolicy: "default",
			model: `${faux.getModel().provider}/${faux.getModel().id}`,
		});
		expect(rebound.conversationId).toBe(directConversation.conversationId);
		faux.setResponses([
			fauxAssistantMessage([fauxToolCall(directName, { value: "rebound" })], {
				stopReason: "toolUse",
			}),
			fauxAssistantMessage([fauxText("done")]),
		]);
		await host.submit(
			"bridge-rebound",
			"call after rebinding",
			"bridge-rebound",
		);
		await settle(host, "bridge-rebound");
		expect(
			toolResult(await host.entriesForTest("bridge-rebound"), directName),
		).toContain(`${reboundDir}:rebound`);

		const otherDir = tempDir();
		await host.ensureRun({
			runId: "bridge-other",
			name: "other-worker",
			cwd: otherDir,
			runEnvPath: writeRunEnv(otherDir),
			toolPolicy: "default",
			model: `${faux.getModel().provider}/${faux.getModel().id}`,
		});
		faux.setResponses([
			fauxAssistantMessage([fauxToolCall(directName, { value: "other" })], {
				stopReason: "toolUse",
			}),
			fauxAssistantMessage([fauxText("done")]),
		]);
		await host.submit(
			"bridge-other",
			"call from second conversation",
			"bridge-other",
		);
		await settle(host, "bridge-other");
		expect(
			toolResult(await host.entriesForTest("bridge-other"), directName),
		).toContain(`${otherDir}:other`);
	} finally {
		await host.shutdown();
	}
	const events = fs.readFileSync(eventPath, "utf8");
	expect(events.match(/session-start/g)).toHaveLength(3);
	expect(events.match(/session-shutdown/g)).toHaveLength(3);
});

test("restricted policies deny imported tools unless named in machine-local allow rules", async () => {
	const dir = tempDir();
	const eventPath = path.join(dir, "events.log");
	const extensionPath = writeExtension(dir, extensionSource(eventPath));
	const name = piExtensionToolName(extensionPath, "bridge_echo");
	const { host, faux } = await openHost(dir);
	try {
		const runEnvPath = writeRunEnv(dir);
		await host.ensureRun({
			runId: "bridge-readonly-denied",
			name: "readonly-worker",
			cwd: dir,
			runEnvPath,
			toolPolicy: "read-only",
			model: `${faux.getModel().provider}/${faux.getModel().id}`,
		});
		faux.setResponses([
			fauxAssistantMessage([fauxToolCall(name, { value: "denied" })], {
				stopReason: "toolUse",
			}),
			fauxAssistantMessage([fauxText("done")]),
		]);
		await host.submit(
			"bridge-readonly-denied",
			"try imported tool",
			"bridge-denied",
		);
		await settle(host, "bridge-readonly-denied");
		expect(fs.existsSync(eventPath)).toBe(true);
		expect(fs.readFileSync(eventPath, "utf8")).not.toContain("echo");
	} finally {
		await host.shutdown();
	}

	const allowedDir = tempDir();
	const allowedEventsPath = path.join(allowedDir, "events.log");
	const allowedExtension = writeExtension(
		allowedDir,
		extensionSource(allowedEventsPath),
	);
	const allowedName = piExtensionToolName(allowedExtension, "bridge_echo");
	const allowedHost = await openHost(allowedDir, {
		readOnly: [allowedName],
		orchestrator: [],
	});
	try {
		const runEnvPath = writeRunEnv(allowedDir);
		await allowedHost.host.ensureRun({
			runId: "bridge-readonly-allowed",
			name: "readonly-allowed-worker",
			cwd: allowedDir,
			runEnvPath,
			toolPolicy: "read-only",
			model: `${allowedHost.faux.getModel().provider}/${allowedHost.faux.getModel().id}`,
		});
		expect(allowedHost.logs).not.toContain(
			"local Pi bridge session initialization failed",
		);
		allowedHost.faux.setResponses([
			fauxAssistantMessage([fauxToolCall(allowedName, { value: "allowed" })], {
				stopReason: "toolUse",
			}),
			fauxAssistantMessage([fauxText("done")]),
		]);
		await allowedHost.host.submit(
			"bridge-readonly-allowed",
			"call allowed imported tool",
			"bridge-allowed",
		);
		await settle(allowedHost.host, "bridge-readonly-allowed");
		expect(
			toolResult(
				await allowedHost.host.entriesForTest("bridge-readonly-allowed"),
				allowedName,
			),
		).toContain(`${allowedDir}:allowed`);
		expect(fs.readFileSync(allowedEventsPath, "utf8")).toContain("echo");
	} finally {
		await allowedHost.host.shutdown();
	}
});

test("nested Pi calls preserve plain text and respect the read-only callable set", async () => {
	const dir = tempDir();
	const notePath = path.join(dir, "nested-note.txt");
	fs.writeFileSync(notePath, "nested readable content");
	const extensionPath = writeExtension(dir, nestedProbeExtensionSource());
	const name = piExtensionToolName(extensionPath, "nested_probe");
	const { host, faux } = await openHost(dir, {
		readOnly: [name],
		orchestrator: [],
	});
	try {
		await host.ensureRun({
			runId: "bridge-nested-policy",
			name: "nested-policy-worker",
			cwd: dir,
			runEnvPath: writeRunEnv(dir),
			toolPolicy: "read-only",
			model: `${faux.getModel().provider}/${faux.getModel().id}`,
		});
		faux.setResponses([
			fauxAssistantMessage([fauxToolCall(name, { readPath: notePath })], {
				stopReason: "toolUse",
			}),
			fauxAssistantMessage([fauxText("done")]),
		]);
		await host.submit(
			"bridge-nested-policy",
			"call nested probe",
			"bridge-nested-policy-request",
		);
		await settle(host, "bridge-nested-policy");
		const result = toolResult(
			await host.entriesForTest("bridge-nested-policy"),
			name,
		);
		expect(result).toContain("readable=true");
		expect(result).toContain("writable=false");
		expect(result).toContain("nested readable content");
	} finally {
		await host.shutdown();
	}
});

test("orchestrator runs discover and invoke user Pi tools without an allow-list", async () => {
	const dir = tempDir();
	const eventsPath = path.join(dir, "orchestrator-pi-events.log");
	const extensionPath = writeExtension(dir, extensionSource(eventsPath));
	const allowedName = piExtensionToolName(extensionPath, "bridge_echo");
	const deniedName = piExtensionToolName(extensionPath, "bridge_error");
	const probePath = writeExtension(
		dir,
		orchestratorProbeExtensionSource(),
		"orchestrator-probe.ts",
	);
	const probeName = piExtensionToolName(probePath, "policy_probe");
	const { host, faux } = await openHost(
		dir,
		{ readOnly: [], orchestrator: [] },
		true,
		true,
	);
	try {
		await host.ensureRun({
			runId: "bridge-orchestrator-probe",
			name: "bridge-orchestrator-probe-worker",
			cwd: dir,
			runEnvPath: writeRunEnv(dir),
			toolPolicy: "orchestrator",
			model: `${faux.getModel().provider}/${faux.getModel().id}`,
		});
		faux.setResponses([
			fauxAssistantMessage(
				[
					fauxToolCall(probeName, {
						allowedName,
						deniedName,
					}),
				],
				{ stopReason: "toolUse" },
			),
			fauxAssistantMessage([fauxText("done")]),
		]);
		await host.submit(
			"bridge-orchestrator-probe",
			"probe allowed and denied Pi tools",
			"bridge-orchestrator-request",
		);
		await settle(host, "bridge-orchestrator-probe");
		const result = toolResult(
			await host.entriesForTest("bridge-orchestrator-probe"),
			probeName,
		);
		expect(result).toContain("allowed-visible=true");
		expect(result).toContain("denied-visible=true");
		expect(result).toContain("allowed-error=false");
		expect(result).toContain("denied-error=true");
		expect(result).toContain('result={"value":"nested"}');
	} finally {
		await host.shutdown();
	}
});

test("an existing native tool wins over a colliding imported tool", async () => {
	const dir = tempDir();
	const events = path.join(dir, "events.log");
	const extensionPath = writeExtension(dir, extensionSource(events));
	const name = piExtensionToolName(extensionPath, "bridge_echo");
	const { host, faux, logs } = await openHost(dir);
	const registry = (host as unknown as { registry: Registry }).registry;
	registry.install({
		name: "test.authoritative-collision",
		tools: [
			defineTool({
				name,
				description: "Authoritative native registration.",
				parameters: Type.Object({ value: Type.String() }),
				execute: async () => ({
					output: [{ type: "text" as const, text: "native wins" }],
				}),
			}),
		],
	});
	try {
		await host.ensureRun({
			runId: "bridge-collision",
			name: "collision-worker",
			cwd: dir,
			runEnvPath: writeRunEnv(dir),
			toolPolicy: "default",
			model: `${faux.getModel().provider}/${faux.getModel().id}`,
		});
		expect(host.toolDescriptionsForTest()[name]).toBe(
			"Authoritative native registration.",
		);
		expect(
			logs.some((line) => line.includes("native-tool-name-collision")),
		).toBe(true);
		faux.setResponses([
			fauxAssistantMessage([fauxToolCall(name, { value: "ignored" })], {
				stopReason: "toolUse",
			}),
			fauxAssistantMessage([fauxText("done")]),
		]);
		await host.submit(
			"bridge-collision",
			"call the authoritative tool",
			"bridge-collision",
		);
		await settle(host, "bridge-collision");
		expect(
			toolResult(await host.entriesForTest("bridge-collision"), name),
		).toContain("native wins");
		expect(fs.existsSync(events)).toBe(true);
		expect(fs.readFileSync(events, "utf8")).not.toContain("echo");
	} finally {
		await host.shutdown();
	}
});

test("unsupported extension hooks fail closed with bounded diagnostics", async () => {
	const dir = tempDir();
	const extensionPath = writeExtension(
		dir,
		`
export default (pi) => {
  pi.on("before_agent_start", () => {});
  pi.registerTool({
    name: "unsupported_tool",
    parameters: { type: "object", properties: {}, additionalProperties: false },
    async execute() { return { content: [{ type: "text", text: "must not run" }] }; }
  });
};
`,
	);
	const name = piExtensionToolName(extensionPath, "unsupported_tool");
	const { host, faux, logs } = await openHost(dir);
	try {
		await host.ensureRun({
			runId: "bridge-unsupported-hook",
			name: "unsupported-hook-worker",
			cwd: dir,
			runEnvPath: writeRunEnv(dir),
			toolPolicy: "default",
			model: `${faux.getModel().provider}/${faux.getModel().id}`,
		});
		expect(Object.keys(host.toolDescriptionsForTest())).not.toContain(name);
		expect(logs.some((line) => line.includes("unsupported-hooks"))).toBe(true);
		expect(logs.join("\\n")).not.toContain(extensionPath);
	} finally {
		await host.shutdown();
	}
});

test("extension UI diagnostics are sanitized in lifecycle callbacks", async () => {
	const dir = tempDir();
	const secretLikeMessage = "mcp token=must-not-be-logged";
	writeExtension(
		dir,
		`export default (pi) => {
  pi.on("session_start", (_event, ctx) => ctx.ui.notify(${JSON.stringify(secretLikeMessage)}, "warning"));
};`,
	);
	const { host, faux, logs } = await openHost(dir);
	try {
		await host.ensureRun({
			runId: "bridge-sanitized-notification",
			name: "sanitized-notification-worker",
			cwd: dir,
			runEnvPath: writeRunEnv(dir),
			toolPolicy: "default",
			model: `${faux.getModel().provider}/${faux.getModel().id}`,
		});
		expect(logs.some((line) => line.includes("extension-notification"))).toBe(
			true,
		);
		expect(logs.join("\\n")).not.toContain(secretLikeMessage);
	} finally {
		await host.shutdown();
	}
});

test("cancellation reaches a local extension tool", async () => {
	const dir = tempDir();
	const eventPath = path.join(dir, "events.log");
	const extensionPath = writeExtension(dir, extensionSource(eventPath));
	const name = piExtensionToolName(extensionPath, "bridge_wait");
	const { host, faux } = await openHost(dir);
	try {
		await host.ensureRun({
			runId: "bridge-cancel",
			name: "cancel-worker",
			cwd: dir,
			runEnvPath: writeRunEnv(dir),
			toolPolicy: "default",
			model: `${faux.getModel().provider}/${faux.getModel().id}`,
		});
		faux.setResponses([
			fauxAssistantMessage([fauxToolCall(name, {})], {
				stopReason: "toolUse",
			}),
			fauxAssistantMessage([fauxText("done")]),
		]);
		await host.submit("bridge-cancel", "start waiting tool", "bridge-cancel");
		for (let index = 0; index < 100; index += 1) {
			if (
				fs.existsSync(eventPath) &&
				fs.readFileSync(eventPath, "utf8").includes("started")
			)
				break;
			await new Promise((resolve) => setTimeout(resolve, 10));
		}
		expect(fs.readFileSync(eventPath, "utf8")).toContain("started");
		await host.stopRun("bridge-cancel");
		expect(fs.readFileSync(eventPath, "utf8")).toContain("aborted");
	} finally {
		await host.shutdown();
	}
});

test("conversation owners are bounded and active Pi calls are not evicted", async () => {
	const dir = tempDir();
	const eventPath = path.join(dir, "owner-lifecycle.log");
	const extensionPath = writeExtension(dir, extensionSource(eventPath));
	const waitingName = piExtensionToolName(extensionPath, "bridge_wait");
	const { host, faux } = await openHost(dir);
	try {
		const model = `${faux.getModel().provider}/${faux.getModel().id}`;
		await host.ensureRun({
			runId: "owner-active",
			name: "owner-active-worker",
			cwd: dir,
			runEnvPath: writeRunEnv(dir),
			toolPolicy: "default",
			model,
		});
		faux.setResponses([
			fauxAssistantMessage([fauxToolCall(waitingName, {})], {
				stopReason: "toolUse",
			}),
			fauxAssistantMessage([fauxText("done")]),
		]);
		await host.submit("owner-active", "start active tool", "owner-active-call");
		for (let attempt = 0; attempt < 100; attempt += 1) {
			if (
				fs.existsSync(eventPath) &&
				fs.readFileSync(eventPath, "utf8").includes("started")
			)
				break;
			await new Promise((resolve) => setTimeout(resolve, 10));
		}
		expect(fs.readFileSync(eventPath, "utf8")).toContain("started");
		for (let index = 0; index < 32; index += 1)
			await host.ensureRun({
				runId: `owner-idle-${index}`,
				name: `owner-idle-worker-${index}`,
				cwd: dir,
				runEnvPath: writeRunEnv(dir),
				toolPolicy: "default",
				model,
			});
		const owners = (
			host as unknown as {
				localPiBridge: {
					owners: Map<string, { activeCalls: Set<unknown> }>;
				};
			}
		).localPiBridge.owners;
		expect(owners.size).toBe(32);
		expect(
			[...owners.values()].filter((owner) => owner.activeCalls.size > 0),
		).toHaveLength(1);
		expect(
			fs.readFileSync(eventPath, "utf8").split("session-shutdown").length - 1,
		).toBeGreaterThanOrEqual(1);
	} finally {
		await host.shutdown();
	}
	expect(
		fs.readFileSync(eventPath, "utf8").split("session-shutdown").length - 1,
	).toBe(33);
});

test("tool refresh enforces the per-conversation cap on accepted candidates", async () => {
	const dir = tempDir();
	writeExtension(
		dir,
		`
export default (pi) => {
  for (let index = 0; index < 300; index += 1) {
    pi.registerTool({
      name: "bulk_" + index,
      parameters: { type: "object", properties: {}, additionalProperties: false },
      async execute() { return { content: [{ type: "text", text: "bulk" }] }; }
    });
  }
};
`,
	);
	const { host, faux, logs } = await openHost(dir);
	try {
		await host.ensureRun({
			runId: "bridge-many-tools",
			name: "many-tools-worker",
			cwd: dir,
			runEnvPath: writeRunEnv(dir),
			toolPolicy: "default",
			model: `${faux.getModel().provider}/${faux.getModel().id}`,
		});
		const bridge = (
			host as unknown as {
				localPiBridge: {
					owners: Map<string, { tools: Map<string, unknown> }>;
					ensureConversation: (
						conversationId: string,
						cwd: string,
					) => Promise<void>;
				};
			}
		).localPiBridge;
		const [conversationId, owner] = [...bridge.owners.entries()][0] ?? [];
		expect(owner?.tools.size).toBe(256);
		if (!conversationId) throw new Error("bridge conversation owner missing");
		await bridge.ensureConversation(conversationId, dir);
		expect(bridge.owners.get(conversationId)?.tools.size).toBe(256);
		expect(
			logs.filter((line) => line.includes("tool-limit-reached")),
		).toHaveLength(1);
	} finally {
		await host.shutdown();
	}
});

test("result content and structured output stop at traversal bounds", async () => {
	const dir = tempDir();
	const extensionPath = writeExtension(dir, boundedResultExtensionSource());
	const oversizedName = piExtensionToolName(
		extensionPath,
		"bridge_oversized_content",
	);
	const deepName = piExtensionToolName(extensionPath, "bridge_deep_structured");
	const { host, faux } = await openHost(dir);
	try {
		await host.ensureRun({
			runId: "bridge-bounded-results",
			name: "bounded-results-worker",
			cwd: dir,
			runEnvPath: writeRunEnv(dir),
			toolPolicy: "default",
			model: `${faux.getModel().provider}/${faux.getModel().id}`,
		});
		faux.setResponses([
			fauxAssistantMessage([fauxToolCall(oversizedName, {})], {
				stopReason: "toolUse",
			}),
			fauxAssistantMessage([fauxText("done")]),
		]);
		await host.submit(
			"bridge-bounded-results",
			"return oversized content",
			"bridge-oversized-result-request",
		);
		await settle(host, "bridge-bounded-results");
		expect(
			toolResult(
				await host.entriesForTest("bridge-bounded-results"),
				oversizedName,
			),
		).toContain("result exceeded the supported size");
		faux.setResponses([
			fauxAssistantMessage([fauxToolCall(deepName, {})], {
				stopReason: "toolUse",
			}),
			fauxAssistantMessage([fauxText("done")]),
		]);
		await host.submit(
			"bridge-bounded-results",
			"return deeply nested structured output",
			"bridge-deep-result-request",
		);
		await settle(host, "bridge-bounded-results");
		expect(
			toolResult(await host.entriesForTest("bridge-bounded-results"), deepName),
		).toContain("unsupported structured result");
	} finally {
		await host.shutdown();
	}
});

test("shutdown awaits a cancellation-resistant Pi call before session shutdown", async () => {
	const dir = tempDir();
	const eventsPath = path.join(dir, "late-result.log");
	const releasePath = path.join(dir, "release-late-result");
	const extensionPath = writeExtension(
		dir,
		cancellationResistantExtensionSource(eventsPath, releasePath),
	);
	const name = piExtensionToolName(extensionPath, "bridge_late_result");
	const { host, faux } = await openHost(dir);
	let shutdownPromise: Promise<void> | undefined;
	let shutdownFinished = false;
	try {
		await host.ensureRun({
			runId: "bridge-late-result",
			name: "late-result-worker",
			cwd: dir,
			runEnvPath: writeRunEnv(dir),
			toolPolicy: "default",
			model: `${faux.getModel().provider}/${faux.getModel().id}`,
		});
		faux.setResponses([
			fauxAssistantMessage([fauxToolCall(name, {})], {
				stopReason: "toolUse",
			}),
			fauxAssistantMessage([fauxText("done")]),
		]);
		await host.submit(
			"bridge-late-result",
			"start a cancellation-resistant tool",
			"bridge-late-result-request",
		);
		for (let attempt = 0; attempt < 100; attempt += 1) {
			if (
				fs.existsSync(eventsPath) &&
				fs.readFileSync(eventsPath, "utf8").includes("started")
			)
				break;
			await new Promise((resolve) => setTimeout(resolve, 10));
		}
		expect(fs.readFileSync(eventsPath, "utf8")).toContain("started");
		shutdownPromise = host.shutdown().then(() => {
			shutdownFinished = true;
		});
		for (let attempt = 0; attempt < 100; attempt += 1) {
			if (fs.readFileSync(eventsPath, "utf8").includes("aborted")) break;
			await new Promise((resolve) => setTimeout(resolve, 10));
		}
		expect(fs.readFileSync(eventsPath, "utf8")).toContain("aborted");
		await new Promise((resolve) => setTimeout(resolve, 40));
		expect(shutdownFinished).toBe(false);
		fs.writeFileSync(releasePath, "release");
		await shutdownPromise;
		const lifecycle = fs.readFileSync(eventsPath, "utf8");
		expect(lifecycle).toContain("resolved");
		expect(lifecycle.indexOf("resolved")).toBeLessThan(
			lifecycle.indexOf("session-shutdown"),
		);
	} finally {
		if (!fs.existsSync(releasePath)) fs.writeFileSync(releasePath, "release");
		if (shutdownPromise) await shutdownPromise;
		else await host.shutdown();
	}
});

test("an aborted Pi call cannot turn a late result into durable success", async () => {
	const dir = tempDir();
	const eventsPath = path.join(dir, "late-result-stop.log");
	const releasePath = path.join(dir, "release-late-result-stop");
	const extensionPath = writeExtension(
		dir,
		cancellationResistantExtensionSource(eventsPath, releasePath),
	);
	const name = piExtensionToolName(extensionPath, "bridge_late_result");
	const { host, faux } = await openHost(dir);
	let stopPromise: Promise<void> | undefined;
	try {
		await host.ensureRun({
			runId: "bridge-late-result-stop",
			name: "late-result-stop-worker",
			cwd: dir,
			runEnvPath: writeRunEnv(dir),
			toolPolicy: "default",
			model: `${faux.getModel().provider}/${faux.getModel().id}`,
		});
		faux.setResponses([
			fauxAssistantMessage([fauxToolCall(name, {})], {
				stopReason: "toolUse",
			}),
			fauxAssistantMessage([fauxText("done")]),
		]);
		await host.submit(
			"bridge-late-result-stop",
			"start a cancellation-resistant tool",
			"bridge-late-result-stop-request",
		);
		for (let attempt = 0; attempt < 100; attempt += 1) {
			if (
				fs.existsSync(eventsPath) &&
				fs.readFileSync(eventsPath, "utf8").includes("started")
			)
				break;
			await new Promise((resolve) => setTimeout(resolve, 10));
		}
		expect(fs.readFileSync(eventsPath, "utf8")).toContain("started");
		stopPromise = host.stopRun("bridge-late-result-stop");
		for (let attempt = 0; attempt < 100; attempt += 1) {
			if (fs.readFileSync(eventsPath, "utf8").includes("aborted")) break;
			await new Promise((resolve) => setTimeout(resolve, 10));
		}
		expect(fs.readFileSync(eventsPath, "utf8")).toContain("aborted");
		fs.writeFileSync(releasePath, "release");
		await stopPromise;
		const entries = await host.entriesForTest("bridge-late-result-stop");
		expect(JSON.stringify(entries)).not.toContain("late-success");
	} finally {
		if (!fs.existsSync(releasePath)) fs.writeFileSync(releasePath, "release");
		if (stopPromise) await stopPromise;
		await host.shutdown();
	}
});

test("an empty temporary Pi directory exposes no tools and makes no HTTP requests", async () => {
	const dir = tempDir();
	const outboundRequests: string[] = [];
	const originalFetch = globalThis.fetch;
	globalThis.fetch = (async (...args: Parameters<typeof fetch>) => {
		outboundRequests.push(String(args[0]));
		return originalFetch(...args);
	}) as typeof fetch;
	const { host, faux } = await openHost(dir);
	try {
		await host.ensureRun({
			runId: "bridge-empty",
			name: "empty-worker",
			cwd: dir,
			runEnvPath: writeRunEnv(dir),
			toolPolicy: "default",
			model: `${faux.getModel().provider}/${faux.getModel().id}`,
		});
		expect(
			Object.keys(host.toolDescriptionsForTest()).some(
				(name) => name.startsWith("pi__") || name.startsWith("mcp__"),
			),
		).toBe(false);
	} finally {
		await host.shutdown();
		globalThis.fetch = originalFetch;
	}
	expect(outboundRequests).toEqual([]);
});

test("a disabled bridge does not start configured MCP processes", async () => {
	const dir = tempDir();
	const marker = path.join(dir, "mcp-started");
	fs.writeFileSync(
		path.join(dir, "mcp.json"),
		JSON.stringify({
			mcpServers: {
				mustNotStart: {
					command: process.execPath,
					args: [
						"-e",
						`require("node:fs").writeFileSync(${JSON.stringify(marker)}, "started")`,
					],
				},
			},
		}),
	);
	const { host, faux } = await openHost(dir, undefined, false);
	try {
		await host.ensureRun({
			runId: "bridge-disabled",
			name: "disabled-worker",
			cwd: dir,
			runEnvPath: writeRunEnv(dir),
			toolPolicy: "default",
			model: `${faux.getModel().provider}/${faux.getModel().id}`,
		});
		expect(
			Object.keys(host.toolDescriptionsForTest()).some(
				(name) => name.startsWith("pi__") || name.startsWith("mcp__"),
			),
		).toBe(false);
	} finally {
		await host.shutdown();
	}
	expect(fs.existsSync(marker)).toBe(false);
});

test("invalid, unavailable and auth-required MCP servers report sanitized diagnostics", async () => {
	const dir = tempDir();
	const secretLikeValue = "fixture-only-token-that-must-not-be-logged";
	const httpMcp = await mockHttpMcp();
	const authMcp = await mockAuthRequiredMcp();
	fs.writeFileSync(
		path.join(dir, "mcp.json"),
		JSON.stringify({
			mcpServers: {
				broken: {
					type: "sse",
					url: `http://127.0.0.1:9/?token=${secretLikeValue}`,
				},
				unavailable: {
					command: process.execPath,
					args: ["-e", "process.exit(1)"],
					exposure: "direct",
				},
				authRequired: {
					url: `${authMcp.url}?token=${secretLikeValue}`,
					timeout: 1,
					exposure: "direct",
				},
				healthy: { url: httpMcp.url, exposure: "direct" },
			},
		}),
	);
	const { host, faux, logs } = await openHost(dir);
	try {
		await host.ensureRun({
			runId: "bridge-invalid-mcp",
			name: "invalid-mcp-worker",
			cwd: dir,
			runEnvPath: writeRunEnv(dir),
			toolPolicy: "default",
			model: `${faux.getModel().provider}/${faux.getModel().id}`,
		});
		expect(logs.some((line) => line.startsWith("local Pi bridge mcp:"))).toBe(
			true,
		);
		expect(logs.join("\\n")).not.toContain(secretLikeValue);
		expect(authMcp.requests()).toBeGreaterThan(0);
		expect(Object.keys(host.toolDescriptionsForTest())).toContain(
			"mcp__healthy__http_echo",
		);
	} finally {
		await host.shutdown();
		await httpMcp.close();
		await authMcp.close();
	}
});

test("MCP notifications map to bounded setup and sign-in recovery hints", async () => {
	const cases = [
		{
			message: "MCP configuration is invalid; token=must-not-be-logged",
			failureClass: "mcp-configuration-invalid",
			hint: "check user-level Pi MCP settings",
		},
		{
			message: "MCP server connection failed; url=must-not-be-logged",
			failureClass: "mcp-server-unavailable",
			hint: "check the user-level MCP server and retry",
		},
		{
			message:
				"MCP authentication required; sign in through Pi; token=must-not-be-logged",
			failureClass: "sign-in-required-use-pi-login",
			hint: "sign in through Pi, then retry the durable run",
		},
	];
	for (const [index, diagnostic] of cases.entries()) {
		const dir = tempDir();
		writeExtension(
			dir,
			`export default (pi) => pi.on("session_start", (_event, ctx) => ctx.ui.notify(${JSON.stringify(diagnostic.message)}, "warning"));`,
		);
		const { host, faux, logs } = await openHost(dir);
		try {
			await host.ensureRun({
				runId: `bridge-mcp-notification-${index}`,
				name: `mcp-notification-worker-${index}`,
				cwd: dir,
				runEnvPath: writeRunEnv(dir),
				toolPolicy: "default",
				model: `${faux.getModel().provider}/${faux.getModel().id}`,
			});
			expect(
				logs.some(
					(line) =>
						line.includes(`local Pi bridge mcp: ${diagnostic.failureClass}`) &&
						line.includes(diagnostic.hint),
				),
			).toBe(true);
			expect(logs.join("\\n")).not.toContain("must-not-be-logged");
		} finally {
			await host.shutdown();
		}
	}
});

test("local MCP configuration exposes stdio and streamable HTTP tools and disposes its server", async () => {
	const dir = tempDir();
	const httpMcp = await mockHttpMcp();
	const marker = path.join(dir, "mcp-events.log");
	const serverPath = path.join(dir, "mock-mcp.mjs");
	fs.writeFileSync(
		serverPath,
		`import fs from "node:fs";\nconst marker = ${JSON.stringify(marker)};\nlet buffer = "";\nprocess.stdin.setEncoding("utf8");\nprocess.stdin.on("data", (chunk) => { buffer += chunk; for (;;) { const index = buffer.indexOf("\\n"); if (index < 0) break; const line = buffer.slice(0, index); buffer = buffer.slice(index + 1); if (!line.trim()) continue; const request = JSON.parse(line); let result; if (request.method === "initialize") result = { protocolVersion: "2025-03-26", capabilities: { tools: {} }, serverInfo: { name: "mock-local", version: "1" } }; else if (request.method === "tools/list") result = { tools: [{ name: "echo", description: "Echoes a local message", inputSchema: { type: "object", properties: { text: { type: "string" } }, required: ["text"] } }] }; else if (request.method === "tools/call") result = { content: [{ type: "text", text: "mcp:" + request.params.arguments.text }] }; else if (request.id === undefined) continue; else { process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: request.id, error: { code: -32601, message: "not found" } }) + "\\n"); continue; } if (request.id !== undefined) process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: request.id, result }) + "\\n"); if (request.method === "initialize") fs.appendFileSync(marker, "started\\n"); } });\nprocess.stdin.on("end", () => { fs.appendFileSync(marker, "closed\\n"); });\n`,
	);
	fs.writeFileSync(
		path.join(dir, "mcp.json"),
		JSON.stringify({
			mcpServers: {
				mock: {
					command: process.execPath,
					args: [serverPath],
					exposure: "direct",
				},
				httpMock: {
					url: httpMcp.url,
					exposure: "direct",
				},
			},
		}),
	);
	fs.writeFileSync(
		path.join(dir, "settings.json"),
		JSON.stringify({ defaultTools: ["+codemode"] }),
	);
	let runningHost: DurableHost | undefined;
	const runEnvPath = writeRunEnv(dir);
	const mcpName = "mcp__mock__echo";
	const httpName = "mcp__httpMock__http_echo";
	const structuredHttpName = "mcp__httpMock__http_structured";
	const imageHttpName = "mcp__httpMock__http_image";
	const errorHttpName = "mcp__httpMock__http_error";
	try {
		const { host, faux, logs } = await openHost(dir);
		runningHost = host;
		await host.ensureRun({
			runId: "bridge-mcp",
			name: "mcp-worker",
			cwd: dir,
			runEnvPath,
			toolPolicy: "default",
			model: `${faux.getModel().provider}/${faux.getModel().id}`,
		});
		expect(Object.keys(host.toolDescriptionsForTest())).toContain(mcpName);
		expect(Object.keys(host.toolDescriptionsForTest())).toContain(httpName);
		faux.setResponses([
			fauxAssistantMessage([fauxToolCall(mcpName, { text: "hello" })], {
				stopReason: "toolUse",
			}),
			fauxAssistantMessage([fauxText("done")]),
		]);
		await host.submit("bridge-mcp", "call mock MCP", "bridge-mcp-request");
		await settle(host, "bridge-mcp");
		expect(
			toolResult(await host.entriesForTest("bridge-mcp"), mcpName),
		).toContain("mcp:hello");
		expect(fs.readFileSync(marker, "utf8")).toContain("started");
		faux.setResponses([
			fauxAssistantMessage([fauxToolCall(httpName, { text: "hello-http" })], {
				stopReason: "toolUse",
			}),
			fauxAssistantMessage([fauxText("done")]),
		]);
		await host.submit(
			"bridge-mcp",
			"call mock HTTP MCP",
			"bridge-http-request",
		);
		await settle(host, "bridge-mcp");
		expect(
			toolResult(await host.entriesForTest("bridge-mcp"), httpName),
		).toContain("http:hello-http");
		faux.setResponses([
			fauxAssistantMessage([fauxToolCall(structuredHttpName, {})], {
				stopReason: "toolUse",
			}),
			fauxAssistantMessage([fauxText("done")]),
		]);
		await host.submit(
			"bridge-mcp",
			"call structured HTTP MCP",
			"bridge-http-structured-request",
		);
		await settle(host, "bridge-mcp");
		const structuredEntries = await host.entriesForTest("bridge-mcp");
		expect(toolResult(structuredEntries, structuredHttpName)).toContain(
			"http-structured",
		);
		faux.setResponses([
			fauxAssistantMessage([fauxToolCall(imageHttpName, {})], {
				stopReason: "toolUse",
			}),
			fauxAssistantMessage([fauxText("done")]),
		]);
		await host.submit(
			"bridge-mcp",
			"call image HTTP MCP",
			"bridge-http-image-request",
		);
		await settle(host, "bridge-mcp");
		expect(JSON.stringify(await host.entriesForTest("bridge-mcp"))).toContain(
			"image/png",
		);
		faux.setResponses([
			fauxAssistantMessage([fauxToolCall(errorHttpName, {})], {
				stopReason: "toolUse",
			}),
			fauxAssistantMessage([fauxText("done")]),
		]);
		await host.submit(
			"bridge-mcp",
			"call error HTTP MCP",
			"bridge-http-error-request",
		);
		await settle(host, "bridge-mcp");
		const errorEntries = await host.entriesForTest("bridge-mcp");
		expect(toolResultFailed(errorEntries, errorHttpName)).toBe(true);
		expect(toolResult(errorEntries, errorHttpName)).toContain(
			"http-error-detail",
		);
		faux.setResponses([
			fauxAssistantMessage(
				[
					fauxToolCall(CODEMODE_TOOL_NAME, {
						code: `return await tools.${httpName}({ text: "from-codemode" });`,
					}),
				],
				{ stopReason: "toolUse" },
			),
			fauxAssistantMessage([fauxText("done")]),
		]);
		await host.submit(
			"bridge-mcp",
			"call HTTP MCP through native codemode",
			"bridge-http-codemode-request",
		);
		await settle(host, "bridge-mcp");
		expect(
			toolResult(await host.entriesForTest("bridge-mcp"), CODEMODE_TOOL_NAME),
		).toContain("http:from-codemode");
		expect(httpMcp.requests()).toBeGreaterThan(0);
		expect(logs).not.toContain("local Pi bridge session initialization failed");
		expect(
			logs.some(
				(line) =>
					line.includes("unsupported-hooks") ||
					line.includes("unsupported-extension-api"),
			),
		).toBe(false);
	} finally {
		await runningHost?.shutdown();
		await httpMcp.close();
	}
	await new Promise((resolve) => setTimeout(resolve, 150));
	expect(fs.readFileSync(marker, "utf8")).toContain("closed");
});
