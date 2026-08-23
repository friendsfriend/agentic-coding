import { createHash } from "node:crypto";
import { loadAssignments } from "./agent-extensions.ts";
import type {
	AdapterCapability,
	ResolvedProfile,
	RuntimeId,
	WorkflowRouting,
} from "./contracts.ts";
import type { CompiledWorkflowDefinition } from "./registry.ts";
import { stableJson } from "./registry.ts";

export interface ProfileConfig {
	runtime: RuntimeId;
	executable?: string;
	model?: string;
	agent?: string;
	thinking?: string;
	tools?: string[];
	extensions?: string[];
	capabilities?: AdapterCapability[];
}
export interface AgentsConfig {
	default_profile: string;
	profiles: Record<string, ProfileConfig>;
	routes?: Record<string, string>;
	role_routes?: Record<string, Record<string, string>>;
	definition_defaults?: Record<string, string>;
}
const RUNTIME_OPTIONS: Record<string, Set<string>> = {
	pi: new Set([
		"runtime",
		"executable",
		"model",
		"thinking",
		"tools",
		"extensions",
		"capabilities",
	]),
	opencode: new Set([
		"runtime",
		"executable",
		"model",
		"agent",
		"tools",
		"capabilities",
	]),
	"opencode-v2": new Set([
		"runtime",
		"executable",
		"model",
		"agent",
		"tools",
		"capabilities",
	]),
};
const DEFAULT_CAPABILITIES: AdapterCapability[] = [
	"interactive",
	"prompt",
	"persistent-session",
	"run-environment",
	"observe",
	"shell",
	"edit",
	"runtime-bridge",
];
export function parseAgentsConfig(
	value: unknown,
	legacy?: {
		models?: Record<string, string>;
		thinking?: Record<string, string>;
	},
): AgentsConfig {
	if (!value || typeof value !== "object" || Array.isArray(value)) {
		const model = legacy?.models?.worker_default;
		return {
			default_profile: "pi-default",
			profiles: {
				"pi-default": {
					runtime: "pi",
					...(model ? { model } : {}),
					thinking: legacy?.thinking?.worker_default,
				},
			},
		};
	}
	const input = value as Record<string, unknown>;
	if (
		typeof input.default_profile !== "string" ||
		!input.profiles ||
		typeof input.profiles !== "object" ||
		Array.isArray(input.profiles)
	)
		throw new Error("agents.default_profile and agents.profiles are required");
	const profiles = input.profiles as Record<string, ProfileConfig>;
	for (const [name, profile] of Object.entries(profiles)) {
		if (
			!profile ||
			typeof profile !== "object" ||
			!RUNTIME_OPTIONS[profile.runtime]
		)
			throw new Error(`invalid runtime in profile ${name}`);
		for (const key of Object.keys(profile))
			if (!RUNTIME_OPTIONS[profile.runtime]?.has(key))
				throw new Error(
					`unsupported ${profile.runtime} option in profile ${name}: ${key}`,
				);
	}
	if (!profiles[input.default_profile])
		throw new Error(`unknown default profile: ${input.default_profile}`);
	return input as unknown as AgentsConfig;
}
function executable(runtime: RuntimeId, configured?: string): string {
	return configured ?? (runtime === "opencode-v2" ? "opencode2" : runtime);
}
export function resolveProfile(
	name: string,
	config: AgentsConfig,
): ResolvedProfile {
	const profile = config.profiles[name];
	if (!profile) throw new Error(`unknown agent profile: ${name}`);
	const capabilities = [
		...new Set(profile.capabilities ?? DEFAULT_CAPABILITIES),
	];
	const tools = [...(profile.tools ?? [])];
	const assigned =
		profile.runtime === "pi"
			? loadAssignments()
					.extensions.filter((item) => item.profiles.includes(name))
					.map((item) => item.source)
			: [];
	const unsigned = {
		name,
		runtime: profile.runtime,
		executable: executable(profile.runtime, profile.executable),
		...(profile.model ? { model: profile.model } : {}),
		...(profile.agent ? { agent: profile.agent } : {}),
		...(profile.thinking ? { thinking: profile.thinking } : {}),
		tools: Object.freeze(tools),
		extensions: Object.freeze([
			...new Set([...(profile.extensions ?? []), ...assigned]),
		]),
		readOnly: false,
		capabilities: Object.freeze(capabilities),
	};
	return Object.freeze({
		...unsigned,
		digest: createHash("sha256").update(stableJson(unsigned)).digest("hex"),
	});
}
export function profileFor(
	stepId: string,
	role: string | undefined,
	definition: CompiledWorkflowDefinition,
	config: AgentsConfig,
): ResolvedProfile {
	const name =
		(role && config.role_routes?.[stepId]?.[role]) ??
		config.routes?.[stepId] ??
		config.definition_defaults?.[definition.id] ??
		definition.defaultProfile ??
		config.default_profile;
	return resolveProfile(name, config);
}
export function resolveRouting(
	definition: CompiledWorkflowDefinition,
	rolesByStep: Record<string, string[]>,
	config: AgentsConfig,
): WorkflowRouting {
	const routes: WorkflowRouting["routes"][number][] = [];
	for (const stepId of definition.steps) {
		if (!(stepId in rolesByStep)) continue;
		const roles = rolesByStep[stepId] ?? [];
		if (!roles.length)
			routes.push({
				stepId,
				profile: profileFor(stepId, undefined, definition, config),
			});
		else
			for (const role of roles)
				routes.push({
					stepId,
					role,
					profile: profileFor(stepId, role, definition, config),
				});
	}
	return { defaultProfile: config.default_profile, routes };
}
export function preflightProfile(
	profile: ResolvedProfile,
	requirements: readonly AdapterCapability[],
): void {
	const executable = profile.executable;
	const resolved = executable.startsWith("/")
		? executable
		: Bun.which(executable);
	if (!resolved)
		throw new Error(
			`configured runtime executable not found for profile ${profile.name}: ${executable}`,
		);
	validateProfileRequirements(profile, requirements);
}
export function validateProfileRequirements(
	profile: ResolvedProfile,
	requirements: readonly AdapterCapability[],
): void {
	// read-only is vestigial: kept in pinned step definitions for digest stability,
	// never enforced (all agents must be able to write outputs and hand off).
	const missing = requirements.filter(
		(item) => item !== "read-only" && !profile.capabilities.includes(item),
	);
	if (missing.length)
		throw new Error(
			`profile ${profile.name} (${profile.runtime}) lacks capabilities: ${missing.join(", ")}`,
		);
}
