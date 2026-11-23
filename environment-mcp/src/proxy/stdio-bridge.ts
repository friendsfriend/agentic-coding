import {
	Client,
	StreamableHTTPClientTransport,
} from "@modelcontextprotocol/client";
import { Server } from "@modelcontextprotocol/server";
import { StdioServerTransport } from "@modelcontextprotocol/server/stdio";

/** Local stdio adapter for hosts (for example OpenCode) that cannot configure a
 * remote MCP bearer header. It forwards the remote shared-server tool list and
 * calls; it creates no environment authority, state or cleanup capability. */
export async function runStdioBridge(options: {
	url: string;
	token: string;
}): Promise<void> {
	const client = new Client({
		name: "environment-mcp-stdio-bridge",
		version: "0.1.0",
	});
	await client.connect(
		new StreamableHTTPClientTransport(new URL(options.url), {
			requestInit: {
				headers: { authorization: `Bearer ${options.token}` },
			},
		}),
	);
	const server = new Server(
		{ name: "environment-mcp", version: "0.1.0" },
		{ capabilities: { tools: {} } },
	);
	server.setRequestHandler("tools/list", (request) =>
		client.listTools(request.params),
	);
	server.setRequestHandler("tools/call", (request) =>
		client.callTool(request.params),
	);
	const closed = Promise.withResolvers<void>();
	server.onclose = () => closed.resolve();
	const stop = () => {
		void server.close().finally(() => closed.resolve());
	};
	process.once("SIGINT", stop);
	process.once("SIGTERM", stop);
	try {
		await server.connect(
			new StdioServerTransport(undefined, undefined, {
				maxBufferSize: 65536,
			}),
		);
		await closed.promise;
	} finally {
		process.removeListener("SIGINT", stop);
		process.removeListener("SIGTERM", stop);
		await client.close();
	}
}
