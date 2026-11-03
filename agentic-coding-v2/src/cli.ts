import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { openNodeJsonlStorage } from "@earendil-works/pi-durable/storage/jsonl/node";
import { defaultConfigDir, loadConfig } from "./config.ts";
import { acquireLock } from "./lock.ts";
import { Runtime } from "./runtime.ts";
import { serve } from "./server.ts";

async function main() {
	const args = process.argv.slice(2);
	if (args.includes("--help")) {
		console.log(
			"agentic-coding-v2 [--config-dir PATH] [--state-dir PATH] [--port NUMBER]\nIndependent local skill-task host. No legacy runs or schedules are migrated.\nDefault config: ~/.config/agentic-coding-v2/config.json (respects XDG_CONFIG_HOME and AGENTIC_CODING_V2_CONFIG_DIR).\nUser skills: CONFIG_DIR/skills/<name>/SKILL.md. System skills are embedded.\nDefault state: ~/.local/share/agentic-coding-v2",
		);
		return;
	}
	const option = (name: string) => {
		const index = args.indexOf(name);
		if (index < 0) return undefined;
		const value = args[index + 1];
		if (!value || value.startsWith("--"))
			throw new Error(`Missing value for ${name}`);
		return value;
	};
	for (let index = 0; index < args.length; index += 2)
		if (!["--config-dir", "--state-dir", "--port"].includes(args[index]))
			throw new Error(`Unknown option ${args[index]}`);
	const stateDir = path.resolve(
		option("--state-dir") ??
			path.join(os.homedir(), ".local/share/agentic-coding-v2"),
	);
	const configDir = path.resolve(option("--config-dir") ?? defaultConfigDir());
	const port = Number(option("--port") ?? 0);
	if (!Number.isInteger(port) || port < 0 || port > 65535)
		throw new Error("Invalid port");
	const release = acquireLock(stateDir);
	let app: Runtime | null = null;
	let host: ReturnType<typeof serve> | null = null;
	let timer: ReturnType<typeof setInterval> | null = null;
	try {
		const config = loadConfig(stateDir, process.cwd(), configDir);
		const agentDir =
			process.env.PI_CODING_AGENT_DIR ?? path.join(os.homedir(), ".pi/agent");
		const models = await ModelRuntime.create({
			authPath: path.join(agentDir, "auth.json"),
			modelsPath: path.join(agentDir, "models.json"),
			modelsStore: {
				read: async () => undefined,
				write: async () => {},
				delete: async () => {},
			},
			refreshOnCreate: false,
			allowModelNetwork: false,
		});
		if (models.getError())
			throw new Error(
				"Pi model configuration could not be loaded; inspect your models.json",
			);
		fs.mkdirSync(path.join(stateDir, "native"), {
			recursive: true,
			mode: 0o700,
		});
		app = await Runtime.open(
			config,
			models,
			await openNodeJsonlStorage(path.join(stateDir, "native"), context, {
				fsync: true,
			}),
		);
		host = serve(app, port);
		console.log(
			`agentic-coding-v2\n${host.url}\nKeep this private URL local. State: ${stateDir}\nConfig: ${configDir}\nNo browser is opened automatically. Ctrl+C stops the host; pending work resumes on the next start.`,
		);
		const running = app;
		timer = setInterval(() => {
			void running
				.tick()
				.catch((error) =>
					console.error(
						"Reconciliation failed:",
						error instanceof Error ? error.message : String(error),
					),
				);
		}, 1000);
		await new Promise<void>((resolve) => {
			process.once("SIGINT", resolve);
			process.once("SIGTERM", resolve);
		});
	} finally {
		if (timer) clearInterval(timer);
		if (host) await host.stop();
		if (app) await app.close();
		release();
	}
}
await main().catch((error) => {
	console.error(error instanceof Error ? error.message : String(error));
	process.exitCode = 1;
});
