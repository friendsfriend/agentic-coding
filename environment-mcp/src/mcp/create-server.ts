import { McpServer } from "@modelcontextprotocol/server";
import { DependencyBindingRefusal } from "../domain/dependency-binding.ts";
import { OperationRefusal } from "../domain/operation.ts";
import type { EnvironmentCapabilities } from "../interface/capabilities.ts";
import { mcpToolSurface } from "./tool-surface.ts";

/** MCP entry point over the shared capability registry. */
export function createMcpServer(capabilities: EnvironmentCapabilities) {
	const server = new McpServer({ name: "environment-mcp", version: "0.1.0" });
	for (const tool of mcpToolSurface(capabilities)) {
		server.registerTool(tool.name, tool.config, async (input, extra) => {
			try {
				const structuredContent = await capabilities.invoke(tool.name, input, {
					signal: extra.mcpReq.signal,
				});
				return {
					content: [
						{ type: "text" as const, text: JSON.stringify(structuredContent) },
					],
					structuredContent,
				};
			} catch (error) {
				const code =
					error instanceof OperationRefusal ||
					error instanceof DependencyBindingRefusal
						? error.code
						: "operation-unavailable";
				return {
					isError: true,
					content: [
						{
							type: "text" as const,
							text: `Environment request refused: ${code}`,
						},
					],
				};
			}
		});
	}
	return server;
}
