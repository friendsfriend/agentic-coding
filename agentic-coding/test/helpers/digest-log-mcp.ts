import fs from "node:fs";
import { createServer } from "node:http";
import path from "node:path";
/** Synthetic receipt/NDJSON transport. No account, config or credentials are loaded. */
export async function fakeDigestLogMcp(root: string, nominalDue: number) {
	const calls: { name: string; args: Record<string, unknown> }[] = [];
	const server = createServer((request, response) => {
		if (request.method !== "POST") {
			response.writeHead(request.method === "DELETE" ? 200 : 405).end();
			return;
		}
		let body = "";
		request.setEncoding("utf8");
		request.on("data", (value) => {
			body += value;
		});
		request.on("end", () => {
			const message = JSON.parse(body) as {
				id?: number;
				method: string;
				params?: { name?: string; arguments?: Record<string, unknown> };
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
					serverInfo: { name: "synthetic-production", version: "1" },
				};
			if (message.method === "tools/list")
				result = {
					tools: [
						{
							name: "azure_monitor_query",
							description: "Synthetic read-only telemetry query",
							inputSchema: {
								type: "object",
								properties: {
									query: { type: "string" },
									duration: { type: "string" },
								},
								required: ["query"],
							},
						},
						{
							name: "read_azure_results",
							description: "Synthetic private receipt reader",
							inputSchema: {
								type: "object",
								properties: {
									filePath: { type: "string" },
									offset: { type: "integer" },
									limit: { type: "integer" },
								},
								required: ["filePath"],
							},
						},
					],
				};
			if (message.method === "tools/call") {
				const name = message.params?.name ?? "missing",
					args = message.params?.arguments ?? {};
				calls.push({ name, args });
				const text =
					name === "azure_monitor_query"
						? "✅ Query complete — 1 rows written to file.\n\nFile:    /tmp/mapi-azure-results/query-123.ndjson\nRows:    1\nColumns: service, signature, count, first, last, severity"
						: `(rows 1–1 of 1 — end of file)\n\n${JSON.stringify({ service: "synthetic-production", signature: "SyntheticFailure", count: 9, first: new Date(nominalDue - 1000).toISOString(), last: new Date(nominalDue - 500).toISOString(), severity: 3 })}`;
				result = { content: [{ type: "text", text }] };
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
				"tools-azure": {
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
