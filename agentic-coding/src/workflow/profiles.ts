import { createHash } from "node:crypto";
import type {
	AdapterCapability,
	ResolvedProfile,
	RuntimeId,
	WorkflowRouting,
} from "../contracts/workflow.ts";
import { loadAssignments } from "./agent-extensions.ts";
import type { CompiledWorkflowDefinition } from "./registry.ts";
import { stableJson } from "./registry.ts";

/** Re-exported from the pure classifier protocol so `profiles.ts` never
 * creates a domain->runtime edge. */
export type { ClassificationMode, PoolEntry } from "./classifiers.ts";

import type { ClassificationMode, PoolEntry } from "./classifiers.ts";
import { ROSTER_MAX_PLANNERS, ROSTER_MIN_PLANNERS } from "./classifiers.ts";

/** Recovery hint repeated by every pool/preset configuration error. */
export const SETTINGS_PRESETS_HINT = "Settings → Presets";

/** Classifiable step ids by their declared mode; step knowledge lives in
 * `steps/`, this only names the config keys the preset editor offers. */
export const POOL_STEPS: Readonly<Record<string, ClassificationMode>> =
	Object.freeze({
		"core.plan": "single",
		"fusion.consolidate": "single",
		"fusion.plan": "roster",
		"core.implementation": "single",
		"core.triage": "single",
		"core.verification": "single",
		"core.wiki": "single",
		"core.archive": "single",
	});

/** The removed flat category keys; any occurrence is a hard config break. */
export const REMOVED_PRESET_CATEGORY_KEYS = [
	"easy",
	"medium",
	"hard",
	"critical",
] as const;

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
	/** Per-classifiable-step model pools keyed by step id. */
	pools?: Record<string, PoolEntry[]>;
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
	pools?: Record<string, PoolEntry[]>;
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
	source?: string,
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
	const presets = validatePresets(input.presets, profiles, source);
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
function removedPoolShape(
	name: string,
	preset: Record<string, unknown>,
	source?: string,
): string | undefined {
	const where = source ? ` (${source})` : "";
	const flat = REMOVED_PRESET_CATEGORY_KEYS.filter((key) =>
		Object.hasOwn(preset, key),
	);
	if (flat.length)
		return `preset ${name}${where}: removed model-routing keys (${flat.join(
			", ",
		)}); recreate them as model pools in ${SETTINGS_PRESETS_HINT}`;
	const roles = preset.roles;
	if (
		roles &&
		typeof roles === "object" &&
		!Array.isArray(roles) &&
		Object.hasOwn(roles as Record<string, unknown>, "core.verification")
	)
		return `preset ${name}${where}: roles["core.verification"] was removed; use the core.verification model pool in ${SETTINGS_PRESETS_HINT}`;
	return undefined;
}

function validatePool(
	presetName: string,
	stepId: string,
	value: unknown,
	profiles: Record<string, ProfileConfig>,
	source?: string,
): PoolEntry[] {
	const where = source ? ` (${source})` : "";
	if (!Array.isArray(value))
		throw new Error(
			`preset ${presetName}${where}: pool ${stepId} must be a list of entries; define it in ${SETTINGS_PRESETS_HINT}`,
		);
	const mode = POOL_STEPS[stepId] ?? "single";
	const labels = new Set<string>();
	const entries: PoolEntry[] = [];
	let defaults = 0;
	for (const raw of value) {
		if (!raw || typeof raw !== "object" || Array.isArray(raw))
			throw new Error(
				`preset ${presetName}${where}: pool ${stepId} entry must be an object`,
			);
		const entry = raw as Record<string, unknown>;
		if (typeof entry.label !== "string" || !entry.label.trim())
			throw new Error(
				`preset ${presetName}${where}: pool ${stepId} entry is missing a label`,
			);
		const label = entry.label.trim();
		if (labels.has(label))
			throw new Error(
				`preset ${presetName}${where}: duplicate label ${label} in pool ${stepId}`,
			);
		labels.add(label);
		if (typeof entry.profile !== "string" || !entry.profile.trim())
			throw new Error(
				`preset ${presetName}${where}: pool ${stepId} entry ${label} is missing a profile`,
			);
		if (!ownProfile(profiles, entry.profile))
			throw new Error(
				`preset ${presetName}${where}: unknown profile ${entry.profile} in pool ${stepId} entry ${label}`,
			);
		if (entry.default !== undefined && typeof entry.default !== "boolean")
			throw new Error(
				`preset ${presetName}${where}: pool ${stepId} entry ${label} default must be a boolean`,
			);
		if (entry.default === true) defaults += 1;
		entries.push({
			label,
			profile: entry.profile,
			...(entry.criteria !== undefined ? { criteria: entry.criteria } : {}),
			...(entry.default === true ? { default: true } : {}),
		});
	}
	if (mode === "roster") {
		if (defaults < ROSTER_MIN_PLANNERS || defaults > ROSTER_MAX_PLANNERS)
			throw new Error(
				`preset ${presetName}${where}: pool ${stepId} needs ${ROSTER_MIN_PLANNERS}-${ROSTER_MAX_PLANNERS} entries marked default, found ${defaults}; edit it in ${SETTINGS_PRESETS_HINT}`,
			);
		const defaultProfiles = entries
			.filter((entry) => entry.default)
			.map((entry) => entry.profile);
		if (new Set(defaultProfiles).size !== defaultProfiles.length)
			throw new Error(
				`preset ${presetName}${where}: pool ${stepId} default entries must name distinct profiles; edit it in ${SETTINGS_PRESETS_HINT}`,
			);
	} else if (defaults !== 1) {
		throw new Error(
			`preset ${presetName}${where}: pool ${stepId} needs exactly one entry marked default, found ${defaults}; edit it in ${SETTINGS_PRESETS_HINT}`,
		);
	}
	return entries;
}

function validatePresets(
	presets: unknown,
	profiles: Record<string, ProfileConfig>,
	source?: string,
): Record<string, PresetConfig> {
	if (presets === undefined)
		return { [BUILTIN_PRESET_NAME]: { runtime: "pi" } };
	if (!presets || typeof presets !== "object" || Array.isArray(presets))
		throw new Error("agents.presets must be a table of presets");
	const parsed = presets as Record<string, PresetConfig>;
	for (const [name, value] of Object.entries(presets)) {
		if (!value || typeof value !== "object" || Array.isArray(value))
			throw new Error(`invalid preset: ${name}`);
		const preset = value as PresetConfig & Record<string, unknown>;
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
		const removed = removedPoolShape(name, preset, source);
		if (removed) throw new Error(removed);
		const where = source ? ` (${source})` : "";
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
		const poolTable = preset.pools;
		if (
			!poolTable ||
			typeof poolTable !== "object" ||
			Array.isArray(poolTable) ||
			Object.keys(poolTable).length === 0
		)
			throw new Error(
				`preset ${name}${where}: a custom preset must declare at least one model pool; create one in ${SETTINGS_PRESETS_HINT}`,
			);
		const pools: Record<string, PoolEntry[]> = {};
		for (const [stepId, pool] of Object.entries(poolTable))
			pools[stepId] = validatePool(name, stepId, pool, profiles, source);
		preset.pools = pools;
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
		readOnly: capabilities.includes("read-only"),
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
		...(preset.pools ? { pools: preset.pools } : {}),
	};
}

/** The ordered pool entries a preset declares for a step (empty if none). */
export function poolEntries(
	preset: RoutingPreset | undefined,
	stepId: string,
): readonly PoolEntry[] {
	return ownValue(preset?.pools, stepId) ?? [];
}

/** The entries tagged `default: true` for a step, in pool order. */
export function defaultPoolEntries(
	preset: RoutingPreset | undefined,
	stepId: string,
): readonly PoolEntry[] {
	return poolEntries(preset, stepId).filter((entry) => entry.default === true);
}

/** The tagged-default profile for a single-select pool, if any. */
export function defaultPoolProfile(
	preset: RoutingPreset | undefined,
	stepId: string,
): string | undefined {
	return defaultPoolEntries(preset, stepId)[0]?.profile;
}

/** True when a definition runs a classifier routing pass. */
export function isClassifierRouted(
	definition: CompiledWorkflowDefinition,
): boolean {
	return definition.steps.some(
		(stepId) => stepId === "core.route-plan" || stepId === "core.route-apply",
	);
}

/** Fail startup when a selected preset leaves a required step unresolvable.
 * A classifier-routed definition requires a valid pool for every classifiable
 * step it contains; every other agent step keeps the legacy resolvability
 * rule with the built-in fallback. */
export function validatePresetCoverage(
	preset: RoutingPreset,
	definition: CompiledWorkflowDefinition,
	agentSteps: readonly string[],
	config: AgentsConfig,
): void {
	const routed = isClassifierRouted(definition);
	if (routed)
		for (const stepId of definition.steps) {
			if (!(stepId in POOL_STEPS)) continue;
			const pool = poolEntries(preset, stepId);
			if (pool.length === 0)
				throw new Error(
					`preset ${preset.name} has no model pool for classifiable step ${stepId}; define it in ${SETTINGS_PRESETS_HINT}`,
				);
		}
	for (const stepId of agentSteps) {
		if (routed && stepId in POOL_STEPS) continue;
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
		defaultPoolProfile(preset, stepId) ??
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
/** Tools a read-only run must never be handed; the adapters translate the
 * resolved profile into the runtime's own allowlist / permission block. */
const MUTATING_TOOLS = new Set(["edit", "write", "multi_edit", "multiedit"]);
/** Pi's read-only surface: `read` for evidence, `bash` for the focused checks
 * and the `agentic-coding workflow handoff` CLI, plus the two injected
 * workflow-extension conversation tools the pinned protocol names and a
 * verifier may need (`developer_question`, `agent_ask`). None of them edit the
 * repository; `write`/`edit` stay excluded. */
const READ_ONLY_PI_TOOLS = ["read", "bash", "developer_question", "agent_ask"];
/** Read-only launch policy for a step that declares the `read-only`
 * requirement (`core.verification`): no edit/write tools and no shell/edit
 * capability, so the adapter launches the runtime without them (pi `--tools`,
 * opencode permission block). `bash` and the workflow-extension question tools
 * deliberately stay: verifiers must run focused checks, ask the developer, and
 * dispatch their own handoff. */
export function asReadOnlyProfile(profile: ResolvedProfile): ResolvedProfile {
	const capabilities = [
		...new Set([
			...profile.capabilities.filter(
				(capability) => capability !== "shell" && capability !== "edit",
			),
			"read-only" as const,
		]),
	];
	const declared = profile.tools.filter(
		(tool) => !MUTATING_TOOLS.has(tool.toLowerCase()),
	);
	// pi's `--tools` is a strict allowlist over built-in *and* extension tools,
	// so a declared list would otherwise hide `developer_question`/`agent_ask`
	// (or drop bash, the handoff path) from a verifier.
	const tools =
		profile.runtime === "pi"
			? [...new Set([...declared, ...READ_ONLY_PI_TOOLS])]
			: declared;
	const unsigned = {
		...profile,
		readOnly: true,
		capabilities: Object.freeze(capabilities),
		tools: Object.freeze(tools),
	};
	return Object.freeze({
		...unsigned,
		digest: createHash("sha256").update(stableJson(unsigned)).digest("hex"),
	});
}
/** The ordered `planner-1..N` role names a fusion preset's tagged defaults
 * seed before classification. */
export function fusionPlannerRoleNames(
	preset: RoutingPreset | undefined,
): string[] {
	return defaultPoolEntries(preset, "fusion.plan").map(
		(_, index) => `planner-${index + 1}`,
	);
}

/** Overlay classifier selections onto the pinned routes, replacing every route
 * of each selected step and preserving all other (earlier-pass) routes. */
export function applyRoutingSelections(
	routing: WorkflowRouting,
	config: AgentsConfig,
	selections: readonly CategorySelection[],
): WorkflowRouting {
	let routes: WorkflowRouting["routes"][number][] = [...routing.routes];
	for (const item of selections) {
		const profile = resolveProfile(item.profileName, config);
		let replaced = false;
		routes = routes.map((route) => {
			if (
				route.stepId === item.stepId &&
				(item.role === undefined || route.role === item.role)
			) {
				replaced = true;
				return { ...route, profile };
			}
			return route;
		});
		if (!replaced)
			routes.push({
				stepId: item.stepId,
				...(item.role ? { role: item.role } : {}),
				profile,
			});
	}
	return { ...routing, routes };
}

/** Replace the fusion planner roles with the chosen roster, preserving every
 * other route (including an earlier pass's single-step selections). */
export function applyFusionRoster(
	routing: WorkflowRouting,
	config: AgentsConfig,
	profiles: readonly string[],
): WorkflowRouting {
	const routes = routing.routes.filter(
		(route) => route.stepId !== "fusion.plan",
	);
	for (const [index, name] of profiles.entries())
		routes.push({
			stepId: "fusion.plan",
			role: `planner-${index + 1}`,
			profile: resolveProfile(name, config),
		});
	return { ...routing, routes };
}

/** Apply every read-only step's declared policy to its routed profiles, before
 * the routing is pinned and preflighted. `requirementsFor` is the caller's
 * already-resolved step lookup (the registry owns step semantics), so this
 * stays free of step-identity literals. */
export function enforceReadOnlySteps(
	routing: WorkflowRouting,
	requirementsFor: (stepId: string) => readonly AdapterCapability[],
): WorkflowRouting {
	return {
		...routing,
		routes: routing.routes.map((route) =>
			requirementsFor(route.stepId).includes("read-only")
				? { ...route, profile: asReadOnlyProfile(route.profile) }
				: route,
		),
	};
}
/** A classifier-selected profile to apply to a step's routes. */
export interface CategorySelection {
	readonly stepId: string;
	readonly role?: string;
	readonly profileName: string;
}

/** Collapse a pinned routing back into the role table `resolveRouting` takes,
 * so a mid-workflow re-resolution (classification, preset switch) reuses the
 * already-pinned roles instead of recomputing step knowledge. */
export function rolesByStepFromRouting(
	routing: WorkflowRouting,
): Record<string, string[]> {
	const rolesByStep: Record<string, string[]> = {};
	for (const route of routing.routes) {
		const roles = rolesByStep[route.stepId] ?? [];
		rolesByStep[route.stepId] = roles;
		if (route.role && !roles.includes(route.role)) roles.push(route.role);
	}
	return rolesByStep;
}

export function resolveRouting(
	definition: CompiledWorkflowDefinition,
	rolesByStep: Record<string, string[]>,
	config: AgentsConfig,
	preset?: RoutingPreset,
	selection?: CategorySelection | readonly CategorySelection[],
): WorkflowRouting {
	let routes: WorkflowRouting["routes"][number][] = [];
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
	const selections = selection
		? Array.isArray(selection)
			? selection
			: [selection]
		: [];
	for (const item of selections) {
		const profile = resolveProfile(item.profileName, config);
		let replaced = false;
		// Replace EVERY route of the step (not just the first): one
		// `core.verification` pool selection must cover all verifier roles.
		routes = routes.map((route) => {
			if (
				route.stepId === item.stepId &&
				(item.role === undefined || route.role === item.role)
			) {
				replaced = true;
				return { ...route, profile };
			}
			return route;
		});
		if (!replaced)
			routes.push({
				stepId: item.stepId,
				...(item.role ? { role: item.role } : {}),
				profile,
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
	// `core.verification` declares `read-only`; routing applies that policy to
	// its profiles (`enforceReadOnlySteps`) before preflight, so a writable
	// verifier profile fails closed here instead of launching read-write.
	const missing = requirements.filter(
		(item) => !profile.capabilities.includes(item),
	);
	if (missing.length)
		throw new Error(
			`profile ${profile.name} (${profile.runtime}) lacks capabilities: ${missing.join(", ")}`,
		);
}
