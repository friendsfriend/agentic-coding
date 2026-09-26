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
	/** Editable entries per classifiable step, retaining opaque criteria. */
	pools: Record<string, PoolEntry[]>;
	/** Step assignments outside the pool fields, preserved verbatim. */
	steps: Record<string, string>;
	/** Role tables outside the pool fields, preserved verbatim. */
	roles: Record<string, Record<string, string>>;
}

export type Draft = ProfileDraft | PresetDraft;

/** Field key for the item manager of one classifiable step. */
export const poolItemsKey = (step: string): string => `pool:${step}:items`;

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
			label: "Thinking level (Pi only)",
			kind: "select",
			options: [...THINKING_LEVELS],
		});
	return fields;
}

/** Preset fields. Each classifiable step opens a pool-entry manager. */
export function presetFields(profileNames: readonly string[]): FormField[] {
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
	for (const { stepId } of POOL_EDITOR_STEPS)
		fields.push({
			key: poolItemsKey(stepId),
			label: `Pool ${stepId} entries`,
			kind: "action",
		});
	return fields;
}

/** The fields of a draft (depends on the profile runtime). */
export function draftFields(
	draft: Draft,
	profileNames: readonly string[],
): FormField[] {
	return draft.kind === "profile"
		? profileFields(draft)
		: presetFields(profileNames);
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
	for (const { stepId } of POOL_EDITOR_STEPS) {
		const count = draft.pools[stepId]?.length ?? 0;
		values[poolItemsKey(stepId)] =
			`${count} ${count === 1 ? "entry" : "entries"}`;
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
	const next = { ...draft };
	if (key === "name") next.name = value;
	else if (key === "defaultProfile") next.defaultProfile = value;
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
	const pools = Object.fromEntries(
		Object.entries(current?.pools ?? {}).map(([step, entries]) => [
			step,
			entries.map((entry) => ({ ...entry })),
		]),
	);
	return {
		kind: "preset",
		name,
		...(current ? { originalName: name } : {}),
		...(current?.description ? { description: current.description } : {}),
		...(current?.runtime ? { runtime: current.runtime } : {}),
		defaultProfile: current?.default_profile ?? "",
		pools,
		steps: { ...(current?.steps ?? {}) },
		roles: { ...(current?.roles ?? {}) },
	};
}

/** Normalize pools before save: single-choice steps keep exactly one default. */
export function poolDraftEntries(
	draft: PresetDraft,
): Record<string, PoolEntry[]> {
	const pools: Record<string, PoolEntry[]> = {};
	for (const { stepId, mode } of POOL_EDITOR_STEPS) {
		const entries = draft.pools[stepId] ?? [];
		if (!entries.length) continue;
		const defaultIndex =
			mode === "single" ? entries.findIndex((entry) => entry.default) : -1;
		pools[stepId] = entries.map((entry, index) => {
			const normalized = { ...entry };
			const isDefault =
				mode === "roster"
					? entry.default === true
					: index === (defaultIndex < 0 ? 0 : defaultIndex);
			if (isDefault) normalized.default = true;
			else delete normalized.default;
			return normalized;
		});
	}
	return pools;
}

/** Swap one pool item with its neighbor; boundary moves leave order unchanged. */
export function movePoolEntry(
	draft: PresetDraft,
	step: string,
	index: number,
	delta: -1 | 1,
): PresetDraft {
	const entries = [...(draft.pools[step] ?? [])];
	const nextIndex = index + delta;
	if (
		index < 0 ||
		index >= entries.length ||
		nextIndex < 0 ||
		nextIndex >= entries.length
	)
		return draft;
	const entry = entries[index];
	const neighbor = entries[nextIndex];
	if (!entry || !neighbor) return draft;
	entries[index] = neighbor;
	entries[nextIndex] = entry;
	return { ...draft, pools: { ...draft.pools, [step]: entries } };
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
		const anyEntries = POOL_EDITOR_STEPS.some(
			({ stepId }) => (draft.pools[stepId]?.length ?? 0) > 0,
		);
		if (!anyEntries && !errors.name)
			errors.name = "A preset must declare at least one model pool";
		for (const { stepId, mode } of POOL_EDITOR_STEPS) {
			const entries = draft.pools[stepId] ?? [];
			if (!entries.length) continue;
			if (entries.some((entry) => !entry.label.trim() || !entry.profile))
				errors[poolItemsKey(stepId)] =
					"Every pool entry needs a label and profile";
			if (mode !== "roster") continue;
			const defaults = entries.filter((entry) => entry.default === true).length;
			if (defaults < 2 || defaults > 5)
				errors[poolItemsKey(stepId)] =
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
