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
export const BUILTIN_PRESET_NAME = "use-default-model";

export interface PresetConfig {
	description?: string;
	runtime?: RuntimeId;
	default_profile?: string;
	steps?: Record<string, string>;
	roles?: Record<string, Record<string, string>>;
}
export interface AgentsConfig {
	default_profile?: string;
	profiles: Record<string, ProfileConfig>;
	routes?: Record<string, string>;
	role_routes?: Record<string, Record<string, string>>;
	definition_defaults?: Record<string, string>;
	presets?: Record<string, PresetConfig>;
}
/** A selected preset as passed into per-start routing resolution. */
export interface RoutingPreset {
	name: string;
	runtime?: RuntimeId;
	default_profile?: string;
	steps?: Record<string, string>;
	roles?: Record<string, Record<string, string>>;
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
		if (model || legacy?.thinking?.worker_default) {
			return {
				default_profile: "pi-default",
				profiles: {
					"pi-default": {
						runtime: "pi",
						...(model ? { model } : {}),
						thinking: legacy?.thinking?.worker_default,
					},
				},
				presets: { [BUILTIN_PRESET_NAME]: { runtime: "pi" } },
			};
		}
		return {
			profiles: {},
			presets: { [BUILTIN_PRESET_NAME]: { runtime: "pi" } },
		};
	}
	const input = value as Record<string, unknown>;
	if (
		input.default_profile !== undefined &&
		typeof input.default_profile !== "string"
	)
		throw new Error("agents.default_profile must be a string");
	if (
		input.profiles !== undefined &&
		(!input.profiles ||
			typeof input.profiles !== "object" ||
			Array.isArray(input.profiles))
	)
		throw new Error("agents.profiles must be a table of profiles");
	const profiles = (input.profiles ?? {}) as Record<string, ProfileConfig>;
	if (Object.hasOwn(profiles, BUILTIN_PRESET_NAME))
		throw new Error(`reserved agent profile name: ${BUILTIN_PRESET_NAME}`);
	for (const [name, profile] of Object.entries(profiles)) {
		if (
			!profile ||
			typeof profile !== "object" ||
			!Object.hasOwn(RUNTIME_OPTIONS, String(profile.runtime))
		)
			throw new Error(`invalid runtime in profile ${name}`);
		for (const key of Object.keys(profile))
			if (!RUNTIME_OPTIONS[profile.runtime]?.has(key))
				throw new Error(
					`unsupported ${profile.runtime} option in profile ${name}: ${key}`,
				);
	}
	if (
		input.default_profile !== undefined &&
		!ownProfile(profiles, input.default_profile)
	)
		throw new Error(`unknown default profile: ${input.default_profile}`);
	const presets = validatePresets(input.presets, profiles);
	return {
		...(input.default_profile !== undefined
			? { default_profile: input.default_profile }
			: {}),
		profiles,
		presets,
		...(input.routes ? { routes: input.routes as Record<string, string> } : {}),
		...(input.role_routes
			? {
					role_routes: input.role_routes as Record<
						string,
						Record<string, string>
					>,
				}
			: {}),
		...(input.definition_defaults
			? {
					definition_defaults: input.definition_defaults as Record<
						string,
						string
					>,
				}
			: {}),
	};
}
function validatePresets(
	presets: unknown,
	profiles: Record<string, ProfileConfig>,
): Record<string, PresetConfig> {
	if (presets === undefined)
		return { [BUILTIN_PRESET_NAME]: { runtime: "pi" } };
	if (!presets || typeof presets !== "object" || Array.isArray(presets))
		throw new Error("agents.presets must be a table of presets");
	const parsed = presets as Record<string, PresetConfig>;
	for (const [name, value] of Object.entries(presets)) {
		if (!value || typeof value !== "object" || Array.isArray(value))
			throw new Error(`invalid preset: ${name}`);
		const preset = value as PresetConfig;
		if (
			preset.runtime !== undefined &&
			!Object.hasOwn(RUNTIME_OPTIONS, preset.runtime)
		)
			throw new Error(`invalid runtime in preset ${name}`);
		if (name === BUILTIN_PRESET_NAME) {
			if (Object.keys(preset).some((key) => key !== "runtime"))
				throw new Error(
					`reserved preset ${BUILTIN_PRESET_NAME} may only configure runtime`,
				);
			continue;
		}
		if (
			preset.default_profile !== undefined &&
			!ownProfile(profiles, preset.default_profile)
		)
			throw new Error(
				`preset ${name}: unknown profile in default_profile: ${preset.default_profile}`,
			);
		for (const [stepId, profileName] of Object.entries(preset.steps ?? {}))
			if (!ownProfile(profiles, profileName))
				throw new Error(
					`preset ${name}: unknown profile ${profileName} for step ${stepId}`,
				);
		for (const [stepId, roles] of Object.entries(preset.roles ?? {})) {
			if (!roles || typeof roles !== "object" || Array.isArray(roles))
				throw new Error(
					`preset ${name}: invalid roles table for step ${stepId}`,
				);
			for (const [role, profileName] of Object.entries(roles))
				if (!ownProfile(profiles, profileName))
					throw new Error(
						`preset ${name}: unknown profile ${profileName} for role ${role} of step ${stepId}`,
					);
		}
	}
	if (!Object.hasOwn(parsed, BUILTIN_PRESET_NAME))
		parsed[BUILTIN_PRESET_NAME] = { runtime: "pi" };
	return parsed;
}
/** Own-property profile lookup; inherited prototype names like "constructor"
 * or "toString" must resolve as unknown profiles, never as configs. */
function ownProfile(
	profiles: Record<string, ProfileConfig>,
	name: string,
): ProfileConfig | undefined {
	return Object.hasOwn(profiles, name) ? profiles[name] : undefined;
}
/** Own-property record lookup for any config table (presets, steps, roles). */
function ownValue<T>(
	record: Record<string, T> | undefined,
	key: string,
): T | undefined {
	if (!record || typeof record !== "object") return undefined;
	return Object.hasOwn(record, key) ? record[key] : undefined;
}
function executable(runtime: RuntimeId, configured?: string): string {
	return configured ?? (runtime === "opencode-v2" ? "opencode2" : runtime);
}
function builtinRuntime(config: AgentsConfig, override?: RuntimeId): RuntimeId {
	return override ?? config.presets?.[BUILTIN_PRESET_NAME]?.runtime ?? "pi";
}
export function resolveProfile(
	name: string,
	config: AgentsConfig,
	runtimeOverride?: RuntimeId,
): ResolvedProfile {
	const builtin = name === BUILTIN_PRESET_NAME;
	const profile = builtin
		? { runtime: builtinRuntime(config, runtimeOverride) }
		: ownProfile(config.profiles, name);
	if (!profile) throw new Error(`unknown agent profile: ${name}`);
	const capabilities = [
		...new Set(profile.capabilities ?? DEFAULT_CAPABILITIES),
	];
	const tools = [...(profile.tools ?? [])];
	const assigned =
		!builtin && profile.runtime === "pi"
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
/** Resolve a named preset from parsed agents config for per-start use. */
export function resolvePreset(
	config: AgentsConfig,
	name: string,
): RoutingPreset {
	const preset = ownValue(config.presets, name);
	if (!preset) throw new Error(`unknown agent preset: ${name}`);
	return {
		name,
		...(preset.runtime ? { runtime: preset.runtime } : {}),
		...(preset.default_profile
			? { default_profile: preset.default_profile }
			: {}),
		...(preset.steps ? { steps: preset.steps } : {}),
		...(preset.roles ? { roles: preset.roles } : {}),
	};
}
/** Fail startup when a selected preset leaves an agent step unresolvable. */
export function validatePresetCoverage(
	preset: RoutingPreset,
	definition: CompiledWorkflowDefinition,
	agentSteps: readonly string[],
	config: AgentsConfig,
): void {
	for (const stepId of agentSteps) {
		const resolvable =
			ownValue(preset.steps, stepId) ||
			Object.keys(ownValue(preset.roles, stepId) ?? {}).length > 0 ||
			preset.default_profile ||
			ownValue(config.presets, BUILTIN_PRESET_NAME) ||
			ownValue(config.routes, stepId) ||
			Object.keys(ownValue(config.role_routes, stepId) ?? {}).length > 0 ||
			ownValue(config.definition_defaults, definition.id) ||
			definition.defaultProfile ||
			config.default_profile;
		if (!resolvable)
			throw new Error(
				`preset ${preset.name} does not cover required step: ${stepId}`,
			);
	}
}
export function profileFor(
	stepId: string,
	role: string | undefined,
	definition: CompiledWorkflowDefinition,
	config: AgentsConfig,
	preset?: RoutingPreset,
): ResolvedProfile {
	const name =
		(role && ownValue(ownValue(preset?.roles, stepId), role)) ??
		ownValue(preset?.steps, stepId) ??
		preset?.default_profile ??
		(role && ownValue(ownValue(config.role_routes, stepId), role)) ??
		ownValue(config.routes, stepId) ??
		ownValue(config.definition_defaults, definition.id) ??
		definition.defaultProfile ??
		config.default_profile ??
		BUILTIN_PRESET_NAME;
	return resolveProfile(
		name,
		config,
		name === BUILTIN_PRESET_NAME ? preset?.runtime : undefined,
	);
}
export function resolveRouting(
	definition: CompiledWorkflowDefinition,
	rolesByStep: Record<string, string[]>,
	config: AgentsConfig,
	preset?: RoutingPreset,
): WorkflowRouting {
	const routes: WorkflowRouting["routes"][number][] = [];
	for (const stepId of definition.steps) {
		if (!(stepId in rolesByStep)) continue;
		const roles = rolesByStep[stepId] ?? [];
		if (!roles.length)
			routes.push({
				stepId,
				profile: profileFor(stepId, undefined, definition, config, preset),
			});
		else
			for (const role of roles)
				routes.push({
					stepId,
					role,
					profile: profileFor(stepId, role, definition, config, preset),
				});
	}
	return {
		defaultProfile: config.default_profile ?? BUILTIN_PRESET_NAME,
		routes,
	};
}
export function preflightProfile(
	profile: ResolvedProfile,
	requirements: readonly AdapterCapability[],
): void {
	const bin = profile.executable;
	const resolved = bin.startsWith("/") ? bin : Bun.which(bin);
	if (!resolved)
		throw new Error(
			`configured runtime executable not found for profile ${profile.name}: ${bin}`,
		);
	validateProfileRequirements(profile, requirements);
	assertModelAvailable(profile);
}

/** How long runtime model enumerations stay cached per executable. */
const MODEL_CACHE_TTL_MS = 30_000;
const modelCache = new Map<string, { models: Set<string>; at: number }>();
/** Forget cached model enumerations (e.g. before the editor re-enumerates). */
export function clearModelCache(): void {
	modelCache.clear();
}
/** Parse `pi --list-models` table output into `provider/model` ids. */
export function parsePiModels(output: string): string[] {
	const models: string[] = [];
	for (const raw of output.split("\n")) {
		const line = raw.trim();
		if (!line || !/[a-z0-9]/i.test(line)) continue;
		const columns = line.split(/\s{2,}|\t+|\s+/).filter(Boolean);
		if (columns.length < 2) continue;
		if (/^provider$/i.test(columns[0])) continue;
		models.push(`${columns[0]}/${columns[1]}`);
	}
	return models;
}
/** Parse `<exe> models` line output (`provider/model`) into ids. */
export function parseOpenCodeModels(output: string): string[] {
	return output
		.split("\n")
		.map((line) => line.trim())
		.filter((line) => line.includes("/") && !/^provider/i.test(line));
}
/** Enumerate a runtime's available models; cached per process per executable.
 * Fails closed with the command error when the runtime cannot enumerate. */
export function runtimeModels(
	executable: string,
	runtime: RuntimeId,
): Set<string> {
	const cached = modelCache.get(executable);
	if (cached && Date.now() - cached.at < MODEL_CACHE_TTL_MS)
		return cached.models;
	const args =
		runtime === "pi" ? [executable, "--list-models"] : [executable, "models"];
	let result: ReturnType<typeof Bun.spawnSync>;
	try {
		result = Bun.spawnSync(args, { stdout: "pipe", stderr: "pipe" });
	} catch (error) {
		// Missing/unrunnable executable: fail closed like a non-zero exit.
		throw new Error(
			`model enumeration failed (${args.join(" ")}): ${(
				error instanceof Error ? error.message : String(error)
			).trim()}`,
		);
	}
	if (result.exitCode !== 0)
		throw new Error(
			`model enumeration failed (${args.join(" ")}): ${(
				(result.stderr ?? "").toString() ||
					(result.stdout ?? "").toString() ||
					"command failed"
			).trim()}`,
		);
	const stdout = (result.stdout ?? "").toString();
	const models =
		runtime === "pi" ? parsePiModels(stdout) : parseOpenCodeModels(stdout);
	const available = new Set(models);
	modelCache.set(executable, { models: available, at: Date.now() });
	return available;
}
/** Fail closed when a profile's configured model is not offered by its runtime. */
export function assertModelAvailable(profile: ResolvedProfile): void {
	if (!profile.model) return;
	const available = runtimeModels(profile.executable, profile.runtime);
	// pi models may carry a :<thinking> suffix; availability is about the base id.
	const candidate =
		profile.runtime === "pi"
			? profile.model.replace(/:[^:]+$/, "")
			: profile.model;
	if (available.has(candidate)) return;
	const sample = [...available].slice(0, 8);
	const suffix = sample.length
		? `available: ${sample.join(", ")}${available.size > sample.length ? ", …" : ""}`
		: "runtime reported no models";
	throw new Error(
		`profile ${profile.name}: unknown model ${profile.model} for runtime ${profile.runtime} (${suffix})`,
	);
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
