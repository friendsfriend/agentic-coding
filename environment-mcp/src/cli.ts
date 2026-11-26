#!/usr/bin/env bun
import { StdioServerTransport } from "@modelcontextprotocol/server/stdio";
import { parseConnectOptions } from "./cli/connect-options.ts";
import { parseDoctorOptions } from "./cli/doctor-options.ts";
import { parseServerOptions } from "./cli/options.ts";
import { parseSharedServerOptions } from "./cli/shared-options.ts";
import { parseUiOptions } from "./cli/ui-options.ts";
import { createDoctorReport } from "./configuration/doctor.ts";
import { loadSecretSource } from "./configuration/secrets.ts";
import { readV2Configuration } from "./configuration/v2-configuration.ts";
import { createCapabilities } from "./interface/capabilities.ts";
import { createMcpServer } from "./mcp/create-server.ts";
import { createCatalogService } from "./services/catalog-service.ts";
import { createGitActionService } from "./services/git-action-service.ts";
import { createGitStatusService } from "./services/git-status-service.ts";
import { startSharedServer } from "./services/shared-server.ts";

if (process.argv.slice(2).length === 1 && process.argv[2] === "--help") {
	process.stderr.write(
		"environment-mcp --config /absolute/manifest.json\nenvironment-mcp --format v2-catalog --config /absolute/environments.json --repository /absolute/repo [--repository ...]\nenvironment-mcp --serve --config /absolute/manifest.json --state-dir /absolute/private-state --clients /absolute/clients.json [--port N] [--idle-timeout-sec N]\nenvironment-mcp --ui --url http://127.0.0.1:PORT/mcp --token-env ENV_NAME [--title TEXT]\nCatalog/dependency review only; no applications or coding-agent host are started.\n",
	);
} else if (process.argv[2] === "--serve") {
	try {
		const shared = await startSharedServer(
			parseSharedServerOptions(process.argv.slice(2)),
		);
		const stopped = Promise.withResolvers<void>();
		const stop = () => {
			void shared.stop().then(stopped.resolve, stopped.reject);
		};
		process.once("SIGINT", stop);
		process.once("SIGTERM", stop);
		process.stderr.write(`Environment MCP: ${shared.url}\n`);
		try {
			await stopped.promise;
		} finally {
			process.removeListener("SIGINT", stop);
			process.removeListener("SIGTERM", stop);
			await shared.stop();
		}
	} catch {
		process.stderr.write(
			"Shared environment MCP failed; verify explicit configuration, private state and credential references. Details withheld.\n",
		);
		process.exitCode = 1;
	}
} else if (process.argv[2] === "--doctor") {
	try {
		const options = parseDoctorOptions(process.argv.slice(2));
		const report = createDoctorReport(readV2Configuration(options.configDir), {
			secrets: loadSecretSource(options.configDir),
		});
		process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
	} catch {
		process.stderr.write(
			"Environment configuration doctor failed; verify the absolute config directory and repository authorization. Details withheld.\n",
		);
		process.exitCode = 1;
	}
} else if (process.argv[2] === "--connect") {
	try {
		const options = parseConnectOptions(process.argv.slice(2));
		const { runStdioBridge } = await import("./proxy/stdio-bridge.ts");
		await runStdioBridge(options);
	} catch {
		process.stderr.write(
			"Environment stdio bridge failed; verify the loopback MCP URL and private credential. Details withheld.\n",
		);
		process.exitCode = 1;
	}
} else if (process.argv[2] === "--ui") {
	try {
		const options = parseUiOptions(process.argv.slice(2));
		const [{ createHttpUiCapabilityApi }, { runEnvironmentTui }] =
			await Promise.all([
				import("./ui/http-capability-api.ts"),
				import("./ui/opentui.ts"),
			]);
		await runEnvironmentTui(
			createHttpUiCapabilityApi({
				url: options.url,
				token: options.token,
			}),
			{ title: options.title },
		);
	} catch {
		process.stderr.write(
			"Environment UI failed; verify the loopback URL and credential reference. Details withheld.\n",
		);
		process.exitCode = 1;
	}
} else {
	try {
		const catalog = createCatalogService(
			parseServerOptions(process.argv.slice(2)),
		);
		const server = createMcpServer(
			createCapabilities({
				catalog,
				repositories: catalog.list({ offset: 0, limit: 1 }).repositories,
				git: createGitStatusService(),
				gitActions: createGitActionService(),
			}),
		);
		process.once("SIGINT", () => {
			void server.close();
		});
		process.once("SIGTERM", () => {
			void server.close();
		});
		await server.connect(
			new StdioServerTransport(undefined, undefined, { maxBufferSize: 65536 }),
		);
	} catch {
		process.stderr.write(
			"Environment MCP startup failed; check configuration, format and explicit repository paths. Details withheld.\n",
		);
		process.exitCode = 1;
	}
}
