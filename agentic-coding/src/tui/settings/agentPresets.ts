// Agent profile/preset form domain (rework-model-profiles-and-presets,
// classifier-driven-model-pools).
//
// Pure data and pure functions: the field catalog, the draft model, the
// values<->draft mapping, validation and the mutation builders. The Solid view
// only owns focus/key dispatch, so the same rules are unit-testable without a
// terminal and the write path cannot drift from the form.

import type { FormErrors, FormField, FormValues } from "@ui";
import type { RuntimeId } from "../../contracts/workflow.ts";
import {
	type ClassificationMode,
	POOL_STEPS,
	type PoolEntry,
	type PresetConfig,
	type ProfileConfig,
} from "../../workflow/profiles.ts";
import {
	type AgentsConfig,
	type AgentsMutation,
	BUILTIN_PRESET_NAME,
	runtimeModels,
} from "../data/agents.ts";

export const RUNTIMES = ["pi", "opencode", "opencode-v2"] as const;
const RUNTIME_EXECUTABLES: Record<string, string> = {
	pi: "pi",
	opencode: "opencode",
	"opencode-v2": "opencode2",
};
const THINKING_LEVELS = ["", "minimal", "low", "medium", "high"];

export type AgentListKind = "profiles" | "presets";

/** The classifiable steps the pool editor renders, in display order. */
export const POOL_EDITOR_STEPS: ReadonlyArray<{
	stepId: string;
	mode: ClassificationMode;
}> = Object.entries(POOL_STEPS).map(([stepId, mode]) => ({ stepId, mode }));

export interface ProfileDraft {
	kind: "profile";
	name: string;
	/** Name the draft was loaded from; undefined for a new entry. */
	originalName?: string;
	runtime: RuntimeId;
	model: string;
	agent: string;
	thinking: string;
	/** Fields the form does not edit, carried through so a save never drops them
	 * (the mutation replaces the whole profile object). */
	executable?: string;
	tools?: string[];
	extensions?: string[];
	capabilities?: ProfileConfig["capabilities"];
}

export interface PresetDraft {
	kind: "preset";
	name: string;
	originalName?: string;
	/** Preserved verbatim; the form does not edit it. */
	description?: string;
	runtime?: RuntimeId;
	defaultProfile: string;
	/** Raw comma-separated label text per classifiable step. */
	poolLabels: Record<string, string>;
	/** One profile choice per `step\0label` entry key. */
	poolProfiles: Record<string, string>;
	/** Default flag per `step\0label` entry key (fusion.plan toggles). */
	poolDefaults: Record<string, boolean>;
	/** Opaque criteria JSON per `step\0label` entry key, preserved verbatim so
	 * an unchanged save never drops a structured TypeSafe criterion. */
	poolCriteria: Record<string, unknown>;
	/** Step assignments outside the pool fields, preserved verbatim. */
	steps: Record<string, string>;
	/** Role tables outside the pool fields, preserved verbatim. */
	roles: Record<string, Record<string, string>>;
}

export type Draft = ProfileDraft | PresetDraft;

/** Field key of one pool's comma-separated label list. */
export const poolLabelsKey = (step: string): string => `pool:${step}:labels`;
/** Field key of one pool entry's profile choice. */
export const poolProfileKey = (step: string, label: string): string =>
	`pool:${step}:profile:${label}`;
/** Field key of one pool entry's default toggle. */
export const poolDefaultKey = (step: string, label: string): string =>
	`pool:${step}:default:${label}`;

const ENTRY_SEPARATOR = "\u0000";
function entryKey(step: string, label: string): string {
	return `${step}${ENTRY_SEPARATOR}${label}`;
}
function splitEntryKey(key: string): { step: string; label: string } {
	const index = key.indexOf(ENTRY_SEPARATOR);
	if (index < 0) return { step: key, label: "" };
	return { step: key.slice(0, index), label: key.slice(index + 1) };
}
/** Split a comma-separated label list into unique, trimmed labels. */
export function splitPoolLabels(value: string): string[] {
	const seen = new Set<string>();
	const labels: string[] = [];
	for (const raw of value.split(",")) {
		const label = raw.trim();
		if (!label || seen.has(label)) continue;
		seen.add(label);
		labels.push(label);
	}
	return labels;
}

/** Profile fields for the current runtime; model is a choice when the runtime
 * enumerates models, otherwise free text. */
export function profileFields(draft: ProfileDraft): FormField[] {
	const fields: FormField[] = [
		{ key: "name", label: "Profile name", kind: "text" },
		{
			key: "runtime",
			label: "Execution environment",
			kind: "select",
			options: [...RUNTIMES],
		},
	];
	let models: string[] | undefined;
	try {
		models = [
			...runtimeModels(
				RUNTIME_EXECUTABLES[draft.runtime] ?? draft.runtime,
				draft.runtime,
			),
		].sort();
	} catch {
		models = undefined;
	}
	fields.push(
		models
			? {
					key: "model",
					label: `Model for ${draft.runtime}`,
					kind: "select",
					options: ["", ...models],
					hint: "optional; empty uses the runtime default",
				}
			: {
					key: "model",
					label: `Model for ${draft.runtime} (optional)`,
					kind: "text",
				},
	);
	if (draft.runtime !== "pi")
		fields.push({
			key: "agent",
			label: "Agent name (optional)",
			kind: "text",
		});
	if (draft.runtime === "pi")
		fields.push({
			key: "thinking",
			label: "Thinking level (optional)",
			kind: "select",
			options: [...THINKING_LEVELS],
		});
	return fields;
}

/** Preset fields. Each classifiable step gets a comma-separated label field
 * plus one profile choice per current label, derived live from the draft; the
 * `fusion.plan` roster also gets a default toggle per entry. */
export function presetFields(
	draft: PresetDraft,
	profileNames: readonly string[],
): FormField[] {
	const options = ["", ...profileNames];
	const fields: FormField[] = [
		{ key: "name", label: "Preset name", kind: "text" },
		{
			key: "defaultProfile",
			label: "Default profile (fallback)",
			kind: "select",
			options,
		},
	];
	for (const { stepId, mode } of POOL_EDITOR_STEPS) {
		fields.push({
			key: poolLabelsKey(stepId),
			label: `Pool ${stepId} labels (comma-separated)`,
			kind: "text",
		});
		for (const label of splitPoolLabels(draft.poolLabels[stepId] ?? "")) {
			fields.push({
				key: poolProfileKey(stepId, label),
				label: `Pool ${stepId} · ${label} profile`,
				kind: "select",
				options,
			});
			if (mode === "roster")
				fields.push({
					key: poolDefaultKey(stepId, label),
					label: `Pool ${stepId} · ${label} default`,
					kind: "select",
					options: ["", "default"],
				});
		}
	}
	return fields;
}

/** The fields of a draft (depends on the profile runtime). */
export function draftFields(
	draft: Draft,
	profileNames: readonly string[],
): FormField[] {
	return draft.kind === "profile"
		? profileFields(draft)
		: presetFields(draft, profileNames);
}

/** Flatten a draft into the form's value map. */
export function draftValues(draft: Draft): FormValues {
	if (draft.kind === "profile")
		return {
			name: draft.name,
			runtime: draft.runtime,
			model: draft.model,
			agent: draft.agent,
			thinking: draft.thinking,
		};
	const values: FormValues = {
		name: draft.name,
		defaultProfile: draft.defaultProfile,
	};
	for (const { stepId } of POOL_EDITOR_STEPS)
		values[poolLabelsKey(stepId)] = draft.poolLabels[stepId] ?? "";
	for (const [key, profile] of Object.entries(draft.poolProfiles)) {
		const { step, label } = splitEntryKey(key);
		if (label) values[poolProfileKey(step, label)] = profile;
	}
	for (const [key, isDefault] of Object.entries(draft.poolDefaults)) {
		const { step, label } = splitEntryKey(key);
		if (label) values[poolDefaultKey(step, label)] = isDefault ? "default" : "";
	}
	return values;
}

/** Apply one edited field back onto the draft. Changing a profile's runtime
 * clears every runtime-scoped field (model/agent/thinking/executable/
 * extensions) so a stale value cannot survive under a harness that does not
 * accept it — opencode rejects pi's `extensions`, and the previous runtime's
 * `executable` would be spawned for the wrong harness. */
export function applyDraftValue(
	draft: Draft,
	key: string,
	value: string,
): Draft {
	if (draft.kind === "profile") {
		const next = { ...draft };
		if (key === "name") next.name = value;
		else if (key === "runtime") {
			if (next.runtime !== value) {
				next.model = "";
				next.agent = "";
				next.thinking = "";
				delete next.executable;
				delete next.extensions;
			}
			next.runtime = value as RuntimeId;
		} else if (key === "model") next.model = value;
		else if (key === "agent") next.agent = value;
		else if (key === "thinking") next.thinking = value;
		return next;
	}
	const next: PresetDraft = {
		...draft,
		poolLabels: { ...draft.poolLabels },
		poolProfiles: { ...draft.poolProfiles },
		poolDefaults: { ...draft.poolDefaults },
		poolCriteria: { ...draft.poolCriteria },
	};
	if (key === "name") next.name = value;
	else if (key === "defaultProfile") next.defaultProfile = value;
	else if (key.startsWith("pool:")) {
		const [, step, kind, ...rest] = key.split(":");
		if (kind === "labels" && step) next.poolLabels[step] = value;
		else if (kind === "profile" && step) {
			const label = rest.join(":");
			if (value) next.poolProfiles[entryKey(step, label)] = value;
			else delete next.poolProfiles[entryKey(step, label)];
		} else if (kind === "default" && step) {
			const label = rest.join(":");
			if (value === "default") next.poolDefaults[entryKey(step, label)] = true;
			else delete next.poolDefaults[entryKey(step, label)];
		}
	}
	return next;
}

export function profileDraft(
	name: string,
	profile?: ProfileConfig,
): ProfileDraft {
	return {
		kind: "profile",
		name: name,
		...(profile ? { originalName: name } : {}),
		runtime: profile?.runtime ?? "pi",
		model: profile?.model ?? "",
		agent: profile?.agent ?? "",
		thinking: profile?.thinking ?? "",
		...(profile?.executable ? { executable: profile.executable } : {}),
		...(profile?.tools ? { tools: profile.tools } : {}),
		...(profile?.extensions ? { extensions: profile.extensions } : {}),
		...(profile?.capabilities ? { capabilities: profile.capabilities } : {}),
	};
}

export function presetDraft(
	name: string,
	presets?: AgentsConfig["presets"],
): PresetDraft {
	const current = name ? presets?.[name] : undefined;
	const poolLabels: Record<string, string> = {};
	const poolProfiles: Record<string, string> = {};
	const poolDefaults: Record<string, boolean> = {};
	const poolCriteria: Record<string, unknown> = {};
	for (const [step, entries] of Object.entries(current?.pools ?? {})) {
		poolLabels[step] = entries.map((entry) => entry.label).join(", ");
		for (const entry of entries) {
			const key = entryKey(step, entry.label);
			poolProfiles[key] = entry.profile;
			if (entry.default === true) poolDefaults[key] = true;
			if (entry.criteria !== undefined) poolCriteria[key] = entry.criteria;
		}
	}
	return {
		kind: "preset",
		name,
		...(current ? { originalName: name } : {}),
		...(current?.description ? { description: current.description } : {}),
		...(current?.runtime ? { runtime: current.runtime } : {}),
		defaultProfile: current?.default_profile ?? "",
		poolLabels,
		poolProfiles,
		poolDefaults,
		poolCriteria,
		steps: { ...(current?.steps ?? {}) },
		roles: { ...(current?.roles ?? {}) },
	};
}

/** Entries built from the draft's label text and per-label choices. */
export function poolDraftEntries(
	draft: PresetDraft,
): Record<string, PoolEntry[]> {
	const pools: Record<string, PoolEntry[]> = {};
	for (const { stepId, mode } of POOL_EDITOR_STEPS) {
		const labels = splitPoolLabels(draft.poolLabels[stepId] ?? "");
		if (!labels.length) continue;
		const entries: PoolEntry[] = [];
		for (const [index, label] of labels.entries()) {
			const key = entryKey(stepId, label);
			const profile = draft.poolProfiles[key];
			if (!profile) continue;
			const isDefault =
				mode === "roster"
					? draft.poolDefaults[key] === true
					: singleDefaultIndex(draft, stepId, labels) === index;
			const criteria = draft.poolCriteria[key];
			entries.push({
				label,
				profile,
				...(criteria !== undefined ? { criteria } : {}),
				...(isDefault ? { default: true } : {}),
			});
		}
		if (entries.length) pools[stepId] = entries;
	}
	return pools;
}

/** The single-select default is the first labeled entry explicitly tagged as
 * default, or the first remaining label when that tag is gone. */
function singleDefaultIndex(
	draft: PresetDraft,
	step: string,
	labels: readonly string[],
): number {
	for (const [index, label] of labels.entries())
		if (draft.poolDefaults[entryKey(step, label)] === true) return index;
	return 0;
}

/**
 * Validate a draft before writing it. Name rules are enforced here so a failed
 * save can point at the field instead of a generic toast.
 */
export function validateDraft(
	draft: Draft,
	existingNames: readonly string[],
): FormErrors {
	const errors: FormErrors = {};
	const name = draft.name.trim();
	if (!name) errors.name = "Name is required";
	else if (name === BUILTIN_PRESET_NAME)
		errors.name = `"${BUILTIN_PRESET_NAME}" is reserved`;
	else if (name !== draft.originalName && existingNames.includes(name))
		errors.name = `A ${
			draft.kind === "profile" ? "profile" : "preset"
		} named "${name}" already exists`;
	if (draft.kind === "preset") {
		const anyLabels = POOL_EDITOR_STEPS.some(
			({ stepId }) =>
				splitPoolLabels(draft.poolLabels[stepId] ?? "").length > 0,
		);
		if (!anyLabels && !errors.name)
			errors.name = "A preset must declare at least one model pool";
		for (const { stepId, mode } of POOL_EDITOR_STEPS) {
			const labels = splitPoolLabels(draft.poolLabels[stepId] ?? "");
			if (!labels.length) continue;
			for (const label of labels)
				if (!draft.poolProfiles[entryKey(stepId, label)]) {
					errors[poolProfileKey(stepId, label)] =
						`Choose a profile for ${label}`;
					break;
				}
			if (mode !== "roster") continue;
			const defaults = labels.filter(
				(label) => draft.poolDefaults[entryKey(stepId, label)] === true,
			).length;
			if (defaults < 2 || defaults > 5)
				errors[poolLabelsKey(stepId)] =
					"fusion.plan needs 2-5 entries marked default";
		}
	}
	return errors;
}

/** Server mutation that saves a profile draft under `originalName` (or creates
 * it when the draft is new). */
export function profileMutation(draft: ProfileDraft): AgentsMutation {
	const name = draft.name.trim();
	return {
		kind: "set-profile",
		name,
		...(draft.originalName && draft.originalName !== name
			? { renameFrom: draft.originalName }
			: {}),
		profile: {
			runtime: draft.runtime,
			...(draft.executable ? { executable: draft.executable } : {}),
			...(draft.model ? { model: draft.model } : {}),
			...(draft.agent ? { agent: draft.agent } : {}),
			...(draft.thinking ? { thinking: draft.thinking } : {}),
			...(draft.tools ? { tools: draft.tools } : {}),
			...(draft.extensions ? { extensions: draft.extensions } : {}),
			...(draft.capabilities ? { capabilities: draft.capabilities } : {}),
		},
	};
}

/** Server mutation for a preset draft, dropping empty references and preserving
 * step/role assignments outside the pool fields. */
export function presetMutation(draft: PresetDraft): AgentsMutation {
	const steps = Object.fromEntries(
		Object.entries(draft.steps).filter(([, value]) => value),
	);
	const roleTables: Record<string, Record<string, string>> = {};
	for (const [step, roles] of Object.entries(draft.roles)) {
		const kept = Object.fromEntries(
			Object.entries(roles).filter(([, value]) => value),
		);
		if (Object.keys(kept).length) roleTables[step] = kept;
	}
	const pools = poolDraftEntries(draft);
	const name = draft.name.trim();
	const preset: PresetConfig = {
		...(draft.description ? { description: draft.description } : {}),
		...(draft.runtime ? { runtime: draft.runtime } : {}),
		...(draft.defaultProfile ? { default_profile: draft.defaultProfile } : {}),
		...(Object.keys(steps).length ? { steps } : {}),
		...(Object.keys(roleTables).length ? { roles: roleTables } : {}),
		...(Object.keys(pools).length ? { pools } : {}),
	};
	return {
		kind: "set-preset",
		name,
		...(draft.originalName && draft.originalName !== name
			? { renameFrom: draft.originalName }
			: {}),
		preset,
	};
}

/** Every place an agent profile is referenced. Deleting a referenced profile
 * would leave a dangling reference, so deletion refuses while this is non-empty. */
export function profileReferences(
	agents: AgentsConfig,
	name: string,
): string[] {
	const refs: string[] = [];
	if (agents.default_profile === name) refs.push("agents.default_profile");
	for (const [step, profile] of Object.entries(agents.routes ?? {}))
		if (profile === name) refs.push(`routes.${step}`);
	for (const [step, roles] of Object.entries(agents.role_routes ?? {}))
		for (const [role, profile] of Object.entries(roles))
			if (profile === name) refs.push(`role_routes.${step}.${role}`);
	for (const [definition, profile] of Object.entries(
		agents.definition_defaults ?? {},
	))
		if (profile === name) refs.push(`definition_defaults.${definition}`);
	for (const [presetName, preset] of Object.entries(agents.presets ?? {})) {
		if (preset.default_profile === name)
			refs.push(`presets.${presetName}.default_profile`);
		for (const [step, profile] of Object.entries(preset.steps ?? {}))
			if (profile === name) refs.push(`presets.${presetName}.steps.${step}`);
		for (const [step, roleMap] of Object.entries(preset.roles ?? {}))
			for (const [role, profile] of Object.entries(roleMap))
				if (profile === name)
					refs.push(`presets.${presetName}.roles.${step}.${role}`);
		for (const [step, entries] of Object.entries(preset.pools ?? {}))
			for (const entry of entries)
				if (entry.profile === name)
					refs.push(`presets.${presetName}.pools.${step}.${entry.label}`);
	}
	return refs;
}
