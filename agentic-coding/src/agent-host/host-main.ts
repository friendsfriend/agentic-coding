// Entry point of the hidden `agentic-coding agent host --workflow-dir DIR`
// internal mode (durable-agent-host spec; `src/cli.ts` lazily imports this
// module so no other command mode loads pi-durable/pi-ai). Resolves this
// workflow's host layout and `agentHost` settings, opens the harness, and
// serves the control socket until shut down or signalled.
import fs from "node:fs";
import path from "node:path";
import { piAgentDir } from "./credentials.ts";
import { DurableHost } from "./host.ts";
import { hostLayout } from "./layout.ts";
import {
	type AgentHostSettings,
	type GlobalPiSettings,
	seedAgentHostSettings,
} from "./settings.ts";

function readJsonFile(filePath: string): Record<string, unknown> | undefined {
	try {
		const parsed = JSON.parse(fs.readFileSync(filePath, "utf8"));
		return parsed && typeof parsed === "object" && !Array.isArray(parsed)
			? (parsed as Record<string, unknown>)
			: undefined;
	} catch {
		return undefined;
	}
}

/** Resolve `agentHost` from the application configuration, seeding it once
 * from the matching keys of the global pi `settings.json` when absent
 * (durable-agent-configuration: "Durable agent settings section"). The seeded
 * value is persisted back into the configuration file so later durable use
 * picks it up without reseeding, and a user's later edit of the global pi
 * default is never applied over an owned section. */
export function loadAgentHostSettings(
	configPath: string,
	globalSettingsPath: string,
): AgentHostSettings {
	const config = readJsonFile(configPath) ?? {};
	const existing = config.agentHost as AgentHostSettings | undefined;
	if (existing) return existing;
	const global = readJsonFile(globalSettingsPath) as
		| GlobalPiSettings
		| undefined;
	const seeded = seedAgentHostSettings(existing, global);
	if (Object.keys(seeded).length > 0) {
		try {
			fs.mkdirSync(path.dirname(configPath), { recursive: true });
			fs.writeFileSync(
				configPath,
				JSON.stringify({ ...config, agentHost: seeded }, null, 2),
			);
		} catch {
			/* seeding is a one-time convenience; an unwritable config still runs with the seeded value in memory */
		}
	}
	return seeded;
}

export interface AgentHostMainOptions {
	readonly configPath: string;
	readonly globalSettingsPath: string;
}

export async function runAgentHost(
	argv: readonly string[],
	options: AgentHostMainOptions,
): Promise<DurableHost> {
	const dirIndex = argv.indexOf("--workflow-dir");
	const workflowDir = dirIndex >= 0 ? argv[dirIndex + 1] : undefined;
	if (!workflowDir) throw new Error("agent host requires --workflow-dir DIR");
	const layout = hostLayout(path.resolve(workflowDir));
	const settings = loadAgentHostSettings(
		options.configPath,
		options.globalSettingsPath,
	);
	const host = await DurableHost.open({
		layout,
		settings,
		globalAgentDir: piAgentDir(),
		// Test-only hook (unified-application-distribution: "Compiled executable
		// hosts an agent"), gated behind an explicit env var so production use
		// never takes it: lets a compiled-binary smoke test complete a model
		// turn without a configured provider credential. Dynamically imported
		// so the ordinary host path never loads it.
		...(process.env.AGENT_HOST_TEST_FAUX_PROVIDER === "1"
			? await testFauxModels()
			: {}),
	});
	await host.listen();
	return host;
}

async function testFauxModels(): Promise<{
	models: import("@earendil-works/pi-ai").Models;
}> {
	const {
		createModels,
		fauxAssistantMessage,
		fauxProvider,
		fauxText,
		fauxToolCall,
	} = await import("@earendil-works/pi-ai");
	const faux = fauxProvider();
	const models = createModels();
	models.setProvider(faux.provider);
	// A crash-resume smoke test needs a specific, slow tool call (e.g. a bash
	// sleep) instead of the default instant `read`; `AGENT_HOST_TEST_FAUX_TOOL`
	// carries it as JSON `{ name, args }` so that test owns its own timing
	// without changing the default faux script every other test relies on.
	const override = process.env.AGENT_HOST_TEST_FAUX_TOOL;
	const toolCall: { name: string; args: Record<string, string | number> } =
		override
			? JSON.parse(override)
			: { name: "read", args: { path: "README.md" } };
	faux.setResponses([
		fauxAssistantMessage([fauxToolCall(toolCall.name, toolCall.args)], {
			stopReason: "toolUse",
		}),
	]);
	// The follow-up generation after the tool result also needs a scripted
	// response; queue it immediately since the test harness has no later
	// opportunity to call `setResponses` on this process's faux provider. A
	// resumed, previously-interrupted tool call re-enters this same generation
	// step, so the same queued text answers it too.
	faux.appendResponses([fauxAssistantMessage([fauxText("done")])]);
	return { models };
}

/** Process entry point: resolves the real config/global-settings paths and
 * keeps the process alive until signalled or the host shuts itself down. */
export async function main(argv: readonly string[]): Promise<void> {
	const { CONFIG } = await import("../workflow/paths.ts");
	const { piSettingsPath } = await import("../workflow/pi-tools.ts");
	let host: DurableHost;
	try {
		host = await runAgentHost(argv, {
			configPath: CONFIG,
			globalSettingsPath: piSettingsPath(),
		});
	} catch (error) {
		console.error(error instanceof Error ? error.message : String(error));
		process.exit(1);
	}
	const shutdown = () => {
		void host.shutdown().finally(() => process.exit(0));
	};
	process.on("SIGTERM", shutdown);
	process.on("SIGINT", shutdown);
}
