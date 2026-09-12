#!/usr/bin/env bun
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Command } from "commander";
import {
	getEmbeddedServerPath,
	resolveServerBinary,
	startManagedServer,
} from "./server-lifecycle";
import { configureOpenTuiConsoleEnv } from "./tui/startup-env";
import { APP_VERSION } from "./version";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

async function importTuiApp() {
	configureOpenTuiConsoleEnv();
	return await import("./tui/app-opentui");
}

const program = new Command();

program
	.name("devenv")
	.description("DevEnv - Development Environment CLI")
	.version(APP_VERSION);

program
	.command("spawn", { isDefault: true })
	.description("Start Go backend server and OpenTUI frontend (default command)")
	.option("-p, --port <port>", "Backend server port", "4050")
	.action(async (options) => {
		const port = options.port || "4050";
		const { startTUI } = await importTuiApp();
		const { initializeLogging, getLogger } = await import("@devenv/core");

		initializeLogging();
		const logger = getLogger();
		logger.write("INFO", `[SPAWN] Starting managed server on port ${port}`);

		let managedServer: Awaited<ReturnType<typeof startManagedServer>> | null =
			null;
		const cleanup = () => {
			if (managedServer) void managedServer.stop(500);
		};
		process.on("SIGINT", cleanup);
		process.on("SIGTERM", cleanup);
		process.on("exit", cleanup);

		try {
			managedServer = await startManagedServer(port);
			logger.write("INFO", `[SPAWN] Server ready at ${managedServer.url}`);
			await startTUI(managedServer.url, { managedServer });
		} catch (error) {
			console.error(error instanceof Error ? error.message : String(error));
			process.exitCode = 1;
		} finally {
			process.off("SIGINT", cleanup);
			process.off("SIGTERM", cleanup);
			process.off("exit", cleanup);
			if (managedServer) await managedServer.stop(2000);
			try {
				process.stdin.pause();
			} catch {}
			const exitCode = process.exitCode || 0;
			const forceExit = setTimeout(() => process.exit(exitCode), 250);
			forceExit.unref?.();
		}
	});

program
	.command("attach <url>")
	.description("Attach TUI to a running DevEnv server")
	.action(async (url) => {
		const { startTUI } = await importTuiApp();
		const { initializeLogging, getLogger } = await import("@devenv/core");

		initializeLogging();
		getLogger().write("INFO", `[ATTACH] Connecting to server at: ${url}`);
		await startTUI(url);
	});

program
	.command("server")
	.description("Start only the Go backend server")
	.option("-p, --port <port>", "Server port", "4050")
	.action(async (options) => {
		const port = options.port || "4050";
		const { serverBinaryPath, isEmbedded, isDevMode } =
			await resolveServerBinary();

		console.log("Starting DevEnv server...");
		const projectRoot = path.resolve(__dirname, "../../../../..");
		let serverProcess: ReturnType<typeof Bun.spawn>;
		if (isDevMode) {
			serverProcess = Bun.spawn(
				["go", "run", "main.go", "server", "--port", port],
				{
					cwd: path.join(projectRoot, "server"),
					stdout: "inherit",
					stderr: "inherit",
				},
			);
		} else {
			if (!serverBinaryPath) throw new Error("Server binary not found");
			serverProcess = Bun.spawn([serverBinaryPath, "server", "--port", port], {
				stdout: "inherit",
				stderr: "inherit",
			});
		}

		await serverProcess.exited;

		if (isEmbedded && serverBinaryPath) {
			try {
				const fs = await import("node:fs");
				const path = await import("node:path");
				await fs.promises.rm(path.dirname(serverBinaryPath), {
					recursive: true,
					force: true,
				});
			} catch {}
		}

		process.exitCode = serverProcess.exitCode || 0;
	});

// Keep embedded helper referenced so build-time injection remains reachable in single-file builds.
void getEmbeddedServerPath;

program.parse();
