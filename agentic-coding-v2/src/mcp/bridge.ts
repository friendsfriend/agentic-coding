import {
	Client,
	StreamableHTTPClientTransport,
} from "@modelcontextprotocol/client";
import {
	fromJsonSchema,
	isCallToolResult,
	type JsonSchemaType,
	McpServer,
} from "@modelcontextprotocol/server";

export function bridgeOptions(args: string[]) {
	const options = new Map<string, string>();
	for (let index = 0; index < args.length; index += 2) {
		const key = args[index];
		const value = args[index + 1];
		if (
			!["--connect", "--token-env"].includes(key) ||
			!value ||
			options.has(key)
		)
			throw new Error("Invalid bridge options");
		options.set(key, value);
	}
	const url = new URL(options.get("--connect") ?? "");
	const tokenEnv = options.get("--token-env") ?? "";
	if (
		url.protocol !== "http:" ||
		url.hostname !== "127.0.0.1" ||
		url.pathname !== "/mcp" ||
		url.username ||
		url.password ||
		url.search ||
		url.hash ||
		!/^[A-Z_][A-Z0-9_]{0,127}$/.test(tokenEnv)
	)
		throw new Error("Invalid bridge endpoint");
	return { url, tokenEnv };
}

/** Tools-only bridge. Its lifecycle closes transports, never controller scopes or resources. */
export async function createEnvironmentBridge(url: URL, token: string) {
	// The public helper has the same endpoint restrictions as the CLI parser.
	const endpoint = bridgeOptions([
		"--connect",
		url.href,
		"--token-env",
		"ENVIRONMENT_TOKEN",
	]).url;
	if (!/^[A-Za-z0-9_-]{32,128}$/.test(token))
		throw new Error("Invalid bridge credential");
	const client = new Client({
		name: "environment-stdio-bridge",
		version: "0.1.0",
	});
	try {
		await client.connect(
			new StreamableHTTPClientTransport(endpoint, {
				requestInit: {
					headers: { authorization: `Bearer ${token}` },
					redirect: "error",
				},
			}),
		);
		const { tools } = await client.listTools();
		if (
			tools.length > 16 ||
			Buffer.byteLength(JSON.stringify(tools)) > 65536 ||
			tools.some(
				(tool) =>
					![
						"env_list",
						"env_discover",
						"environment_action",
						"env_result",
						"env_status",
						"env_logs",
						"otel_query",
						"env_http_request",
						"db_query",
						"env_diagnostic_history",
					].includes(tool.name),
			)
		)
			throw new Error("Unsupported environment catalog");
		return {
			server: () => {
				const server = new McpServer({
					name: "environment-stdio-bridge",
					version: "0.1.0",
				});
				for (const tool of tools)
					server.registerTool(
						tool.name,
						{
							description: tool.description,
							// MCP's wire schema type is broader than the validator's type;
							// fromJsonSchema still compiles and validates it at this boundary.
							inputSchema: fromJsonSchema<Record<string, unknown>>(
								tool.inputSchema as JsonSchemaType,
							),
							...(tool.outputSchema
								? {
										outputSchema: fromJsonSchema<Record<string, unknown>>(
											tool.outputSchema,
										),
									}
								: {}),
							annotations: tool.annotations,
						},
						async (input, context) => {
							try {
								const result = await client.callTool(
									{ name: tool.name, arguments: input },
									{ signal: context.mcpReq.signal },
								);
								if (!isCallToolResult(result))
									throw new Error("Invalid environment result");
								return result;
							} catch {
								return {
									isError: true,
									content: [
										{
											type: "text" as const,
											text: "Environment controller unavailable. Inspect durable receipts before retrying; this bridge does not retry calls.",
										},
									],
								};
							}
						},
					);
				return server;
			},
			close: () => client.close(),
		};
	} catch {
		await client.close();
		throw new Error("Environment bridge could not connect");
	}
}
