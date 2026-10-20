// Entry point of the hidden `agentic-coding agent host --workflow-dir DIR`
// internal mode (durable-agent-host spec; `src/cli.ts` lazily imports this
// module so no other command mode loads pi-durable/pi-ai). Resolves this
// workflow's host layout and `agentHost` settings, opens the harness, and
// serves the control socket until shut down or signalled.
import fs from "node:fs";
import path from "node:path";
import {
	type ResolvedCheckpointConfig,
	resolveCheckpointConfig,
} from "../workflow/checkpoint.ts";
import {
	type CompactionConfig,
	type CompactionSource,
	resolveCompactionSection,
} from "../workflow/compaction.ts";
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

/** The configuration file the compaction section is read from: the explicit
 * replacement file when `HERDR_WORKFLOW_CONFIG` names one (that file replaces
 * the whole configuration), otherwise the canonical user-level file the caller
 * resolved. A project overlay is deliberately never consulted: the policy is a
 * user-scope setting, so a repository cannot change how a workflow's own runs
 * compact (design D1). */
export function compactionConfigPath(configPath: string): string {
	return process.env.HERDR_WORKFLOW_CONFIG?.trim() || configPath;
}

/** The effective compaction section of one configuration file, with
 * `agentHost.compaction` taking precedence over `[agents.compaction]`. */
export function loadCompactionSection(
	configPath: string,
	agentHost?: CompactionConfig,
): { config: CompactionConfig; source: CompactionSource } {
	const config = readJsonFile(configPath) ?? {};
	const agents = config.agents;
	const agentsCompaction =
		agents && typeof agents === "object" && !Array.isArray(agents)
			? (agents as Record<string, unknown>).compaction
			: undefined;
	return resolveCompactionSection(agentsCompaction, agentHost);
}

/**
 * Live accessor for the effective compaction section. pi-durable reads
 * `HarnessSettings` at every resolution and never copies them, so the host
 * forwards this as a getter: a Settings save reaches a running conversation
 * without restarting the host (design D4). The file is re-read only when its
 * mtime or size changes, so the per-resolution getter stays a stat plus a pure
 * computation.
 */
export function liveCompactionSection(
	configPath: string,
	agentHost?: CompactionConfig,
): () => CompactionConfig {
	let cached: { key: string; config: CompactionConfig } | undefined;
	return () => {
		// The explicit replacement file wins here too, so a caller cannot read one
		// file while the rest of the configuration layer reads another.
		const file = compactionConfigPath(configPath);
		let key = `missing:${file}`;
		try {
			const stat = fs.statSync(file);
			key = `${file}:${stat.mtimeMs}:${stat.size}`;
		} catch {
			/* an unreadable file is the same as an absent section */
		}
		if (!cached || cached.key !== key)
			cached = {
				key,
				config: loadCompactionSection(file, agentHost).config,
			};
		return cached.config;
	};
}

/** The effective run-progress checkpoint section of one configuration file
 * (`[agents.checkpoint]`, efficiency backlog item 19). The configuration load
 * already refused a malformed section, so this reader is lenient: a mistyped hot
 * edit falls back to the default for that key instead of failing a starting
 * run. */
export function loadCheckpointSection(
	configPath: string,
): ResolvedCheckpointConfig {
	const config = readJsonFile(configPath) ?? {};
	const agents = config.agents;
	const section =
		agents && typeof agents === "object" && !Array.isArray(agents)
			? (agents as Record<string, unknown>).checkpoint
			: undefined;
	return resolveCheckpointConfig(section);
}

/**
 * Live accessor for the effective checkpoint section, for the same reason the
 * compaction section has one: a Settings save reaches the next run start
 * without restarting the host, and the file is re-read only when its mtime or
 * size changes.
 */
export function liveCheckpointSection(
	configPath: string,
): () => ResolvedCheckpointConfig {
	let cached: { key: string; config: ResolvedCheckpointConfig } | undefined;
	return () => {
		const file = compactionConfigPath(configPath);
		let key = `missing:${file}`;
		try {
			const stat = fs.statSync(file);
			key = `${file}:${stat.mtimeMs}:${stat.size}`;
		} catch {
			/* an unreadable file is the same as an absent section */
		}
		if (!cached || cached.key !== key)
			cached = { key, config: loadCheckpointSection(file) };
		return cached.config;
	};
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
		compaction: liveCompactionSection(
			compactionConfigPath(options.configPath),
			settings.compaction,
		),
		// The same user-scope file, read per run start: a checkpoint is a property
		// of the runs a host starts, not of the process it started in.
		checkpoint: liveCheckpointSection(compactionConfigPath(options.configPath)),
		globalAgentDir: piAgentDir(),
		...(argv.includes("--orchestrator") ? { orchestrator: true } : {}),
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
