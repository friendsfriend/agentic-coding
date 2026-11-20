import {
	StdioServerTransport,
	serveStdio,
} from "@modelcontextprotocol/server/stdio";
import { createNativeCatalog } from "./native-catalog.ts";
import { parseMcpOptions } from "./options.ts";
import { createEnvironmentMcpServer } from "./server.ts";

async function main() {
	const args = process.argv.slice(2);
	if (args[0] === "--serve") {
		const { runEnvironmentDaemon } = await import("./daemon.ts");
		await runEnvironmentDaemon(args);
	} else if (args.length === 1 && args[0] === "--help") {
		process.stderr.write(
			"bun src/mcp/cli.ts --config-dir /absolute/config --repository /absolute/repository [--repository /another/repository]\nbun src/mcp/cli.ts --serve --config-dir /absolute/config --state-dir /absolute/private/state --clients /absolute/clients.json --repository /absolute/repository [--port NUMBER] [--operator-port NUMBER]\nbun src/mcp/cli.ts --connect http://127.0.0.1:PORT/mcp --token-env ENVIRONMENT_MCP_TOKEN\nDefault mode is read-only catalog inspection. Serve owns one shared controller; connect is only a tools bridge.\n",
		);
	} else {
		let bridge:
			| {
					server: () => ReturnType<typeof createEnvironmentMcpServer>;
					close: () => Promise<void>;
			  }
			| undefined;
		let factory: () => ReturnType<typeof createEnvironmentMcpServer>;
		if (args.includes("--connect")) {
			const { bridgeOptions, createEnvironmentBridge } = await import(
				"./bridge.ts"
			);
			const options = bridgeOptions(args);
			const token = process.env[options.tokenEnv];
			if (!token) throw new Error("Missing bridge credential");
			bridge = await createEnvironmentBridge(options.url, token);
			factory = bridge.server;
		} else {
			const catalog = createNativeCatalog(parseMcpOptions(args));
			factory = () => createEnvironmentMcpServer(catalog);
		}
		const host = serveStdio(factory, {
			transport: new StdioServerTransport(undefined, undefined, {
				maxBufferSize: 65536,
			}),
			onerror: () => process.stderr.write("Environment MCP transport error\n"),
		});
		let closing = false;
		const close = () => {
			if (closing) return;
			closing = true;
			void (async () => {
				try {
					await host.close();
				} finally {
					await bridge?.close();
				}
			})().catch(() => {
				process.stderr.write("Environment MCP shutdown failed\n");
				process.exitCode = 1;
			});
		};
		process.once("SIGINT", close);
		process.once("SIGTERM", close);
		process.stdin.once("end", close);
		if (process.stdin.readableEnded) close();
	}
}
void main().catch(() => {
	process.stderr.write(
		"Environment MCP failed. Check catalog paths, daemon state/client definitions or loopback connection and credential reference. Configuration, credentials and upstream errors are withheld.\n",
	);
	process.exitCode = 1;
});
