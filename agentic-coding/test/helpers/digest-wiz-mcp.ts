import fs from "node:fs";
import { createServer } from "node:http";
import path from "node:path";

/** Loopback-only synthetic MCP; never proxies an account or loads credentials. */
export async function fakeDigestWizMcp(
	root: string,
	pages: readonly unknown[],
) {
	const calls: { tool: string; parameters: Record<string, unknown> }[] = [];
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
				params?: {
					name?: string;
					arguments?: {
						tool_name?: string;
						parameters?: Record<string, unknown>;
					};
				};
			};
			if (message.id === undefined) {
				response.writeHead(202).end();
				return;
			}
			let result: unknown = {};
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
							name: "discover",
							description: "Synthetic read-only finding taxonomy",
							inputSchema: { type: "object", properties: {} },
						},
						{
							name: "execute",
							description: "Synthetic dispatcher; not real Wiz",
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
				const args = message.params?.arguments,
					parameters = args?.parameters ?? {};
				const tool =
					message.params?.name === "discover"
						? "discover"
						: (args?.tool_name ?? "missing");
				calls.push({ tool, parameters });
				const value =
					tool === "discover"
						? {
								domains: ["issues"],
								tools: [
									{
										name: "list_issues",
										parameters: [
											"created_after",
											"created_before",
											"first",
											"after",
										],
									},
								],
							}
						: pages[parameters.after === "page-2" ? 1 : 0];
				result = {
					content: [{ type: "text", text: JSON.stringify(value ?? {}) }],
				};
			}
			response
				.writeHead(200, { "content-type": "application/json" })
				.end(JSON.stringify({ jsonrpc: "2.0", id: message.id, result }));
		});
	});
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	const address = server.address();
	if (!address || typeof address === "string")
		throw new Error("Synthetic MCP bind failed");
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
	return {
		calls,
		close: async () => {
			server.closeAllConnections();
			await new Promise<void>((resolve, reject) =>
				server.close((error) => (error ? reject(error) : resolve())),
			);
		},
	};
}
