import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type {
	AdapterCapability,
	ResolvedProfile,
	RuntimeId,
	WorkflowRouting,
} from "../contracts/workflow.ts";
import type { CompiledWorkflowDefinition } from "./registry.ts";
import { stableJson } from "./registry.ts";

/** Re-exported from the pure classifier protocol so `profiles.ts` never
 * creates a domain->runtime edge. */
export type {
	ClassificationMode,
	GatePolicy,
	GateStage,
	PoolEntry,
} from "./classifiers.ts";
export { GATE_POLICIES, GATE_STAGES } from "./classifiers.ts";

import {
	classifierProviderIds,
	DEFAULT_CLASSIFIER_PROVIDER,
	isClassifierProviderId,
} from "./classifier-providers.ts";
import type {
	ClassificationMode,
	GatePolicy,
	GateStage,
	PoolEntry,
} from "./classifiers.ts";
import {
	GATE_POLICIES,
	GATE_STAGES,
	ROSTER_MAX_PLANNERS,
	ROSTER_MIN_PLANNERS,
} from "./classifiers.ts";
import { CLASSIFIABLE_STEPS } from "./steps/index.ts";
import { STEP_ROUTES } from "./steps/routing.ts";

/** Recovery hint repeated by every pool/preset configuration error. */
export const SETTINGS_PRESETS_HINT = "Settings → Presets";

/** Classifiable step ids by their declared mode: the registered step
 * behaviors are the only place that knows, so this is derived rather than kept
 * as a parallel table that can drift (classifier-driven-step-model-selection).
 * These double as the config keys the preset editor offers. */
export const POOL_STEPS: Readonly<Record<string, ClassificationMode>> =
	CLASSIFIABLE_STEPS;

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
	/** Per-stage gate policies; a stage absent here falls back to the global
	 * `agents.gates` table and then to `always`. */
	gates?: Record<string, GatePolicy>;
}
export interface AgentsConfig {
	default_profile?: string;
	profiles: Record<string, ProfileConfig>;
	routes?: Record<string, string>;
	role_routes?: Record<string, Record<string, string>>;
	definition_defaults?: Record<string, string>;
	presets?: Record<string, PresetConfig>;
	/** Global gate policies used by every preset that declares no entry for a
	 * stage. Config-file only: the Settings editor writes the preset table. */
	gates?: Record<string, GatePolicy>;
	/** The selected classifier transport. Absent means the default hosted
	 * provider, so a configuration that says nothing behaves exactly as today. */
	classifier?: ClassifierConfig;
	/** The per-file judgment sweep (`[agents.file_judgment]`). Absent means
	 * disabled, so a configuration that says nothing spends no classifier calls
	 * and writes no artifact. */
	file_judgment?: FileJudgmentConfig;
	/** The Home Orchestrator session's model (`[agents.orchestrator]`). Absent
	 * means the durable host's default model and thinking level. */
	orchestrator?: OrchestratorConfig;
}

/** The Orchestrator chat session's model selection. Both fields are the
 * `provider/modelId` and thinking-level strings a durable run accepts. */
export interface OrchestratorConfig {
	model?: string;
	thinking?: string;
}

/** The per-file judgment sweep (`[agents.file_judgment]`). The provider and the
 * model are NOT here on purpose: they resolve from `[agents.classifier]` and
 * `agents.profiles["jev-classifier"].model` like every other classifier
 * integration, so an operator keeps exactly one model knob. This table carries
 * only the sweep's own bounds. */
export interface FileJudgmentConfig {
	/** Off unless explicitly enabled: an enabled sweep spends one classifier call
	 * per changed file on every verification round and records an evidence
	 * artifact. */
	enabled: boolean;
	/** Above this probability a file is reported as a finding. */
	threshold?: number;
	/** At or above this probability, and at or below `threshold`, a file is
	 * reported as ambiguous instead of being dropped. */
	unsure?: number;
	/** How many classifier calls may be in flight. */
	concurrency?: number;
}
/** The classifier transport selection (`[agents.classifier]`). */
export interface ClassifierConfig {
	provider: string;
	/** Provider-specific options; preserved verbatim, never validated here.
	 * NOTE: options are not keyed by provider, so switching providers carries the
	 * previous provider's table over. No provider reads `options` today; the
	 * first one that does must either ignore unknown keys or the table should be
	 * cleared on switch. */
	options?: Record<string, unknown>;
}
/** A selected preset as passed into per-start routing resolution. */
export interface RoutingPreset {
	name: string;
	runtime?: RuntimeId;
	default_profile?: string;
	steps?: Record<string, string>;
	roles?: Record<string, Record<string, string>>;
	pools?: Record<string, PoolEntry[]>;
	gates?: Record<string, GatePolicy>;
}
/** The one runtime (multiplexer removal): the bundled durable host. A profile
 * may still name an `executable`, which the durable host does not spawn — it is
 * carried for digest/display stability only. */
const RUNTIME_OPTIONS: Record<string, Set<string>> = {
	"pi-durable": new Set([
		"runtime",
		"executable",
		"model",
		"thinking",
		"tools",
		"extensions",
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
						runtime: "pi-durable",
						...(model ? { model } : {}),
						thinking: legacy?.thinking?.worker_default,
					},
				},
				// The built-in preset's own runtime stays unset here too (falls through
				// to `builtinRuntime`'s "pi-durable" default): a legacy TOML migration
				// sets up an explicit "pi-default" named profile for `default_profile`,
				// but a workflow that separately selects `use-default-model` gets the
				// same sitewide default as a fresh installation.
				presets: { [BUILTIN_PRESET_NAME]: {} },
			};
		}
		return {
			profiles: {},
			presets: { [BUILTIN_PRESET_NAME]: {} },
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
		...(input.gates
			? { gates: validateGates(input.gates, "agents.gates", source) }
			: {}),
		...(input.classifier !== undefined
			? {
					classifier: validateClassifier(
						input.classifier,
						"agents.classifier",
						source,
					),
				}
			: {}),
		...(input.orchestrator !== undefined
			? {
					orchestrator: validateOrchestrator(
						input.orchestrator,
						"agents.orchestrator",
						source,
					),
				}
			: {}),
		...(input.file_judgment !== undefined
			? {
					file_judgment: validateFileJudgment(
						input.file_judgment,
						"agents.file_judgment",
						source,
					),
				}
			: {}),
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

function validateGates(
	value: unknown,
	where: string,
	source?: string,
): Record<string, GatePolicy> {
	const location = source ? `${where} (${source})` : where;
	if (!value || typeof value !== "object" || Array.isArray(value))
		throw new Error(`${location} must be a table of stage gate policies`);
	const table = value as Record<string, unknown>;
	const gates: Record<string, GatePolicy> = {};
	for (const [stage, policy] of Object.entries(table)) {
		if (!(GATE_STAGES as readonly string[]).includes(stage))
			throw new Error(
				`${location}: unknown stage gate "${stage}"; expected one of ${GATE_STAGES.join(", ")}`,
			);
		if (
			typeof policy !== "string" ||
			!(GATE_POLICIES as readonly string[]).includes(policy)
		)
			throw new Error(
				`${location}: stage ${stage} has invalid gate policy ${JSON.stringify(policy)}; expected ${GATE_POLICIES.join(" or ")}`,
			);
		gates[stage] = policy as GatePolicy;
	}
	return gates;
}

/** Validate `[agents.orchestrator]`: an optional model and thinking level,
 * both non-empty strings. Unknown keys are refused so a typo is not silently
 * ignored. */
function validateOrchestrator(
	value: unknown,
	where: string,
	source?: string,
): OrchestratorConfig {
	const location = source ? `${where} (${source})` : where;
	if (!value || typeof value !== "object" || Array.isArray(value))
		throw new Error(`${location} must be a table with model and thinking`);
	const table = value as Record<string, unknown>;
	for (const key of Object.keys(table))
		if (key !== "model" && key !== "thinking")
			throw new Error(`${location}: unsupported key ${key}`);
	for (const key of ["model", "thinking"] as const)
		if (
			table[key] !== undefined &&
			(typeof table[key] !== "string" || !(table[key] as string).trim())
		)
			throw new Error(`${location}.${key} must be a non-empty string`);
	return {
		...(table.model !== undefined ? { model: table.model as string } : {}),
		...(table.thinking !== undefined
			? { thinking: table.thinking as string }
			: {}),
	};
}

/** Validate `[agents.classifier]`. The provider id must name a registered
 * provider; an unknown one is a hard config break with the recovery list, in
 * the same style as the stage-gate validation. Provider options are preserved
 * verbatim: only the provider that understands them reads them. */
function validateClassifier(
	value: unknown,
	where: string,
	source?: string,
): ClassifierConfig {
	const location = source ? `${where} (${source})` : where;
	if (!value || typeof value !== "object" || Array.isArray(value))
		throw new Error(`${location} must be a table with a provider id`);
	const table = value as Record<string, unknown>;
	if (!isClassifierProviderId(table.provider))
		throw new Error(
			`${location}: unknown classifier provider ${JSON.stringify(table.provider)}; expected one of ${classifierProviderIds().join(", ")}`,
		);
	if (
		table.options !== undefined &&
		(!table.options ||
			typeof table.options !== "object" ||
			Array.isArray(table.options))
	)
		throw new Error(`${location}.options must be a table`);
	return {
		provider: table.provider,
		...(table.options !== undefined
			? { options: table.options as Record<string, unknown> }
			: {}),
	};
}

function validateFileJudgment(
	value: unknown,
	where: string,
	source?: string,
): FileJudgmentConfig {
	const location = source ? `${where} (${source})` : where;
	if (!value || typeof value !== "object" || Array.isArray(value))
		throw new Error(`${location} must be a table with an \`enabled\` boolean`);
	const table = value as Record<string, unknown>;
	if (typeof table.enabled !== "boolean")
		throw new Error(`${location}.enabled must be a boolean`);
	const probability = (key: string): number | undefined => {
		const raw = table[key];
		if (raw === undefined) return undefined;
		if (typeof raw !== "number" || !Number.isFinite(raw) || raw < 0 || raw > 1)
			throw new Error(
				`${location}.${key} must be a probability between 0 and 1`,
			);
		return raw;
	};
	const threshold = probability("threshold");
	const unsure = probability("unsure");
	// A flag threshold at or below the ambiguity floor would make the `unsure`
	// band empty, which is the one configuration that reads as if it works while
	// silently losing the band's whole purpose.
	if (threshold !== undefined && unsure !== undefined && unsure > threshold)
		throw new Error(
			`${location}.unsure must not be above ${location}.threshold`,
		);
	let concurrency: number | undefined;
	if (table.concurrency !== undefined) {
		if (
			typeof table.concurrency !== "number" ||
			!Number.isInteger(table.concurrency) ||
			table.concurrency < 1
		)
			throw new Error(`${location}.concurrency must be a positive integer`);
		concurrency = table.concurrency;
	}
	return {
		enabled: table.enabled,
		...(threshold !== undefined ? { threshold } : {}),
		...(unsure !== undefined ? { unsure } : {}),
		...(concurrency !== undefined ? { concurrency } : {}),
	};
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
	if (presets === undefined) return { [BUILTIN_PRESET_NAME]: {} };
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
		if (preset.gates !== undefined)
			preset.gates = validateGates(
				preset.gates,
				`preset ${name} gates`,
				source,
			);
	}
	if (!Object.hasOwn(parsed, BUILTIN_PRESET_NAME))
		parsed[BUILTIN_PRESET_NAME] = {};
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
	// `pi-durable` has no external executable (durable-agent-host: "preflight
	// checks capabilities (no executable lookup)"); the bundled label stays for
	// display and digest stability.
	return configured ?? String(runtime);
}
function builtinRuntime(config: AgentsConfig, override?: RuntimeId): RuntimeId {
	// default-model-preset: "the built-in preset configuration ... when no
	// harness is configured it SHALL default to pi-durable." A user who sets
	// the preset's runtime explicitly (including to "pi") keeps that choice;
	// only the unset case changed.
	return (
		override ?? config.presets?.[BUILTIN_PRESET_NAME]?.runtime ?? "pi-durable"
	);
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
	const unsigned = {
		name,
		runtime: profile.runtime,
		executable: executable(profile.runtime, profile.executable),
		...(profile.model ? { model: profile.model } : {}),
		...(profile.thinking ? { thinking: profile.thinking } : {}),
		tools: Object.freeze(tools),
		extensions: Object.freeze([...(profile.extensions ?? [])]),
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
		...(preset.gates ? { gates: preset.gates } : {}),
	};
}

/** The effective gate policy of every stage for one run: the preset's entry
 * wins, then the global `agents.gates` table, then `always`. A configuration
 * that declares nothing therefore runs every stage, and the table is read from
 * the already-pinned config at classification time so a mid-run edit cannot
 * change a running workflow. */
export function resolveGatePolicies(
	agents: AgentsConfig,
	presetName?: string,
): Record<GateStage, GatePolicy> {
	const preset = presetName ? ownValue(agents.presets, presetName) : undefined;
	const resolved = {} as Record<GateStage, GatePolicy>;
	for (const stage of GATE_STAGES)
		resolved[stage] =
			ownValue(preset?.gates, stage) ??
			ownValue(agents.gates, stage) ??
			"always";
	return resolved;
}

/** The stages whose review is human by definition: an orchestrator-started
 * workflow pins these to `always`, so the classifier can never skip a plan,
 * developer, or wiki review on the orchestrator's behalf. */
export const HUMAN_REVIEW_GATE_STAGES = [
	"planApproval",
	"developerReview",
	"wiki",
] as const satisfies readonly GateStage[];

/** `policies` with every human review stage forced to `always`. */
export function withHumanReviewGates(
	policies: Record<GateStage, GatePolicy>,
): Record<GateStage, GatePolicy> {
	const forced = { ...policies };
	for (const stage of HUMAN_REVIEW_GATE_STAGES) forced[stage] = "always";
	return forced;
}

/** The classifier provider a configuration selects. An absent
 * `[agents.classifier]` keeps the default hosted provider, so a configuration
 * that says nothing behaves exactly as before. Read once at start and pinned
 * into the snapshot, so a mid-run edit cannot switch the endpoint. */
export function resolveClassifierProvider(agents: AgentsConfig): string {
	return agents.classifier?.provider ?? DEFAULT_CLASSIFIER_PROVIDER;
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

/** True when a definition selects its step models with the classifier. Since
 * classifier-driven-step-model-selection every family has a routing step before
 * each of its classifiable steps, so this asks whether the resolved definition
 * carries any of them rather than whether it carries the pre-per-step
 * `core.route-plan`/`core.route-apply` passes. */
export function isClassifierRouted(
	definition: CompiledWorkflowDefinition,
): boolean {
	return definition.steps.some((stepId) => STEP_ROUTES[stepId] !== undefined);
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
/** Tools a read-only run must never be handed; the durable host translates the
 * resolved profile into its own tool policy. */
const MUTATING_TOOLS = new Set(["edit", "write", "multi_edit", "multiedit"]);
/** Read-only launch policy for a step that declares the `read-only`
 * requirement (`core.verification`): no edit/write tools and no shell/edit
 * capability, so the durable host launches the run with its read-only tool
 * policy. `bash` and the workflow's own question tools deliberately stay:
 * verifiers must run focused checks, ask the developer, and dispatch their own
 * handoff. */
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
	const unsigned = {
		...profile,
		readOnly: true,
		capabilities: Object.freeze(capabilities),
		tools: Object.freeze(declared),
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
	// The durable host is bundled, not an external executable on PATH
	// (durable-agent-host: "preflight checks capabilities (no executable
	// lookup)"), so there is no executable-resolution check.
	validateProfileRequirements(profile, requirements);
	assertModelAvailable(profile);
}

/** Global pi `models.json` custom-provider model ids, read synchronously and
 * without any external executable (durable-agent-configuration: "Durable
 * model enumeration"). Returns the providers the user configured locally and
 * every `provider/model` id those providers declare. An absent or unreadable
 * file contributes nothing, matching every other optional global-pi read in
 * this codebase (`pi-tools.ts`'s `globalPiTools`). */
function durableCustomModels(): {
	providers: Set<string>;
	models: Set<string>;
} {
	const providers = new Set<string>();
	const models = new Set<string>();
	try {
		// Mirrors `agent-host/credentials.ts`'s `piAgentDir()` resolution without a
		// static import of that module from this always-loaded config-parsing
		// layer: same `PI_CODING_AGENT_DIR` override, same `~/.pi/agent` default.
		const configured = process.env.PI_CODING_AGENT_DIR?.trim();
		const agentDir = configured
			? configured
			: path.join(os.homedir(), ".pi", "agent");
		const raw = fs.readFileSync(path.join(agentDir, "models.json"), "utf8");
		const parsed = JSON.parse(raw) as {
			providers?: Record<string, { models?: Array<{ id?: unknown }> }>;
		};
		for (const [providerId, provider] of Object.entries(
			parsed.providers ?? {},
		)) {
			providers.add(providerId);
			for (const model of provider.models ?? [])
				if (typeof model.id === "string")
					models.add(`${providerId}/${model.id}`);
		}
	} catch {
		/* no custom models configured, or the file is unreadable */
	}
	return { providers, models };
}

/** `pi-durable` model validation (durable-agent-configuration: "Durable model
 * enumeration"). Validates shape (`provider/model`, optional `:thinking`
 * suffix) and, for a provider the user configured locally
 * (`~/.pi/agent/models.json`), exact membership. A built-in provider's model
 * id is accepted on shape alone: enumerating pi-ai's full generated catalog
 * synchronously, with no external executable, would mean eagerly loading the
 * pi-ai package into every workflow-start validation — including workflows
 * that never route to `pi-durable` — which conflicts with keeping that
 * package's cost out of the common path. This is a deliberately narrower
 * guarantee than the spec's "fail closed" wording for every provider; a
 * genuinely invalid built-in model still fails, just later, at launch,
 * instead of at workflow start. */
function assertDurableModelAvailable(profile: ResolvedProfile): void {
	if (!profile.model) return;
	const candidate = profile.model.replace(/:[^:]+$/, "");
	const slash = candidate.indexOf("/");
	if (slash <= 0 || slash === candidate.length - 1)
		throw new Error(
			"profile " +
				profile.name +
				': pi-durable model must be "<provider>/<model>" (got ' +
				profile.model +
				")",
		);
	const providerId = candidate.slice(0, slash);
	const { providers, models } = durableCustomModels();
	if (providers.has(providerId) && !models.has(candidate)) {
		const sample = [...models]
			.filter((model) => model.startsWith(`${providerId}/`))
			.slice(0, 8);
		throw new Error(
			"profile " +
				profile.name +
				": unknown model " +
				profile.model +
				" for custom provider " +
				providerId +
				" (available: " +
				(sample.length ? sample.join(", ") : "none") +
				")",
		);
	}
}
/** Fail closed when a profile's configured model is not offered by its runtime. */
export function assertModelAvailable(profile: ResolvedProfile): void {
	if (!profile.model) return;
	assertDurableModelAvailable(profile);
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
