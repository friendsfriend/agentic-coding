// Effective backend/telemetry values and their controlling source
// (centralize-application-settings, task 2.2/2.3). These settings are decided
// when the owning server starts: Settings shows the effective value, names the
// CLI flag or environment variable that controls it and states that a restart
// is required. Nothing here is written back, so a read-only override can never
// be reported as an effective edit.
//
// Pure: takes the environment and argv so a test can resolve them without a
// running shell.
import { configRootFrom } from "../../config-root.ts";
import type { SettingsEffect } from "./catalog.ts";

export interface BackendSettingValue {
	/** Inventory id this value belongs to. */
	id: string;
	label: string;
	value: string;
	/** Controlling source: a CLI flag, an environment variable or a default. */
	source: string;
	effect: SettingsEffect;
	secret: boolean;
}

/** The receiver/listener flags the shell parses at startup. */
const RECEIVER_FLAGS: ReadonlyArray<{
	flag: string;
	id: string;
	label: string;
}> = [
	{ flag: "--http-port", id: "backend.receivers.http", label: "OTLP HTTP" },
	{ flag: "--grpc-port", id: "backend.receivers.grpc", label: "OTLP gRPC" },
	{ flag: "--zipkin-port", id: "backend.receivers.zipkin", label: "Zipkin" },
	{ flag: "--datadog-port", id: "backend.receivers.datadog", label: "Datadog" },
	{ flag: "--statsd-port", id: "backend.receivers.statsd", label: "StatsD" },
];

/** Read one `--flag value` / `--flag=value` occurrence from argv. */
export function flagValue(
	argv: readonly string[],
	flag: string,
): string | undefined {
	for (let index = 0; index < argv.length; index += 1) {
		if (argv[index] === flag) return argv[index + 1];
		if (argv[index].startsWith(`${flag}=`))
			return argv[index].slice(flag.length + 1);
	}
	return undefined;
}

/** The local UI preferences directory: the shared configuration root. */
export function resolvedConfigDir(env: NodeJS.ProcessEnv = process.env): {
	path: string;
	source: string;
} {
	return configRootFrom(env);
}

export interface BackendContext {
	/** The address this shell talks to; absent when no server is configured. */
	serverUrl?: string;
	/** True when this process started the server it talks to. */
	owned: boolean;
	/** True when the shell attached to a server it does not own. */
	attached: boolean;
}

export function resolveBackendSettings(
	context: BackendContext,
	env: NodeJS.ProcessEnv = process.env,
	argv: readonly string[] = process.argv,
): BackendSettingValue[] {
	const values: BackendSettingValue[] = [];
	const url =
		context.serverUrl ?? env.AGENTIC_DEVENV_URL ?? env.AGENTIC_WORKFLOW_URL;
	values.push({
		id: "backend.endpoint",
		label: "Backend endpoint",
		value: url ?? "(none configured)",
		source: context.serverUrl
			? context.owned
				? "started by this shell"
				: "attached server"
			: env.AGENTIC_DEVENV_URL
				? "AGENTIC_DEVENV_URL"
				: env.AGENTIC_WORKFLOW_URL
					? "AGENTIC_WORKFLOW_URL"
					: "default",
		effect: "restart",
		secret: false,
	});
	const capability = env.AGENTIC_DEVENV_TOKEN ?? env.AGENTIC_WORKFLOW_TOKEN;
	values.push({
		id: "backend.capability",
		label: "Instance capability",
		value: capability ? "present (value not shown)" : "not set",
		source:
			env.AGENTIC_DEVENV_TOKEN !== undefined
				? "AGENTIC_DEVENV_TOKEN"
				: env.AGENTIC_WORKFLOW_TOKEN !== undefined
					? "AGENTIC_WORKFLOW_TOKEN"
					: "generated per instance",
		effect: "restart",
		secret: true,
	});
	for (const receiver of RECEIVER_FLAGS) {
		const raw = flagValue(argv, receiver.flag);
		values.push({
			id: receiver.id,
			label: `Telemetry receiver ${receiver.label}`,
			value: raw ? `port ${raw}` : "disabled",
			source: raw ? `CLI flag ${receiver.flag}` : "default (not started)",
			effect: "restart",
			secret: false,
		});
	}
	const targets = flagValue(argv, "--prom-target");
	values.push({
		id: "backend.telemetry.scrape",
		label: "Prometheus scrape targets",
		value: targets ? targets : "none",
		source: targets ? "CLI flag --prom-target" : "default (not started)",
		effect: "restart",
		secret: false,
	});
	values.push({
		id: "backend.telemetry.scrape-interval",
		label: "Prometheus scrape interval",
		value: `${flagValue(argv, "--prom-interval") ?? "15000"} ms`,
		source: flagValue(argv, "--prom-interval")
			? "CLI flag --prom-interval"
			: "default",
		effect: "restart",
		secret: false,
	});
	values.push({
		id: "backend.telemetry.retention",
		label: "Telemetry persistence",
		value: context.attached
			? "owned by the attached server"
			: "owned by this server",
		source: context.attached ? "attached server" : "shell-owned server",
		effect: "restart",
		secret: false,
	});
	const configDir = resolvedConfigDir(env);
	values.push({
		id: "backend.config-dir",
		label: "Configuration directory",
		value: configDir.path,
		source: configDir.source,
		effect: "restart",
		secret: false,
	});
	return values;
}
