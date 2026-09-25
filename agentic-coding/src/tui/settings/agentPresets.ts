// Agent profile/preset form domain (rework-model-profiles-and-presets).
//
// Pure data and pure functions: the field catalog, the draft model, the
// values<->draft mapping, validation and the mutation builders. The Solid view
// only owns focus/key dispatch, so the same rules are unit-testable without a
// terminal and the write path cannot drift from the form.

import type { FormErrors, FormField, FormValues } from "@ui";
import type { RuntimeId } from "../../contracts/workflow.ts";
import {
	PRESET_CATEGORY_KEYS,
	type PresetConfig,
	type ProfileConfig,
} from "../../workflow/profiles.ts";
import { VERIFIER_ROLES } from "../../workflow/steps/verification.ts";
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
export const PRESET_STEPS = [
	"core.plan",
	"core.implementation",
	"core.triage",
	"core.wiki",
	"core.archive",
];
export const FUSION_CONSOLIDATE_STEP = "fusion.consolidate";
export const FUSION_PLAN_ROLES = [
	"planner-1",
	"planner-2",
	"planner-3",
	"planner-4",
	"planner-5",
];
const THINKING_LEVELS = ["", "minimal", "low", "medium", "high"];

export type AgentListKind = "profiles" | "presets";

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
	/** Flat per-complexity worker profiles, keyed by category (sparse). */
	complexities: Record<string, string>;
	steps: Record<string, string>;
	roles: Record<string, string>;
	/** Role assignments under roles.fusion.plan (planner-1..5). */
	fusionRoles: Record<string, string>;
	/** Role tables for steps other than core.verification and fusion.plan,
	 * preserved verbatim so an edit-save cycle never collapses them. */
	otherRoles: Record<string, Record<string, string>>;
}

export type Draft = ProfileDraft | PresetDraft;

/** Field key of one step route inside a preset draft. */
export const stepKey = (step: string): string => `step:${step}`;
/** Field key of one fusion planner role. */
export const fusionRoleKey = (role: string): string => `fusionRole:${role}`;
/** Field key of one plan-complexity profile assignment. */
export const complexityKey = (category: string): string =>
	`complexity:${category}`;
/** Field key of one verification role. */
export const roleKey = (role: string): string => `role:${role}`;

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

/** Preset fields. Every profile reference is a choice over the saved profiles
 * (empty means "not set"), so a typo cannot create a broken reference. */
export function presetFields(profileNames: readonly string[]): FormField[] {
	const options = ["", ...profileNames];
	return [
		{ key: "name", label: "Preset name", kind: "text" },
		{
			key: "defaultProfile",
			label: "Default profile (fallback)",
			kind: "select",
			options,
		},
		...PRESET_CATEGORY_KEYS.map((category) => ({
			key: complexityKey(category),
			label: `Complexity ${category}`,
			kind: "select" as const,
			options,
		})),
		...PRESET_STEPS.map((step) => ({
			key: stepKey(step),
			label: `Step ${step}`,
			kind: "select" as const,
			options,
		})),
		{
			key: stepKey(FUSION_CONSOLIDATE_STEP),
			label: `Step ${FUSION_CONSOLIDATE_STEP}`,
			kind: "select" as const,
			options,
		},
		...FUSION_PLAN_ROLES.map((role) => ({
			key: fusionRoleKey(role),
			label: `Fusion ${role}`,
			kind: "select" as const,
			options,
		})),
		...VERIFIER_ROLES.map((role) => ({
			key: roleKey(role),
			label: `Verification ${role}`,
			kind: "select" as const,
			options,
		})),
	];
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
	for (const [category, profile] of Object.entries(draft.complexities))
		values[complexityKey(category)] = profile;
	for (const [step, profile] of Object.entries(draft.steps))
		values[stepKey(step)] = profile;
	for (const [role, profile] of Object.entries(draft.fusionRoles))
		values[fusionRoleKey(role)] = profile;
	for (const [role, profile] of Object.entries(draft.roles))
		values[roleKey(role)] = profile;
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
		complexities: { ...draft.complexities },
		steps: { ...draft.steps },
		roles: { ...draft.roles },
		fusionRoles: { ...draft.fusionRoles },
	};
	if (key === "name") next.name = value;
	else if (key === "defaultProfile") next.defaultProfile = value;
	else if (key.startsWith("complexity:"))
		next.complexities[key.slice("complexity:".length)] = value;
	else if (key.startsWith("step:"))
		next.steps[key.slice("step:".length)] = value;
	else if (key.startsWith("fusionRole:"))
		next.fusionRoles[key.slice("fusionRole:".length)] = value;
	else if (key.startsWith("role:"))
		next.roles[key.slice("role:".length)] = value;
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
	// Edit only the core.verification and fusion.plan role tables; other steps'
	// tables are kept verbatim.
	const {
		"core.verification": verification = {},
		"fusion.plan": fusionPlan = {},
		...otherRoles
	} = current?.roles ?? {};
	const complexities: Record<string, string> = {};
	for (const category of PRESET_CATEGORY_KEYS) {
		const profile = current?.[category];
		if (profile) complexities[category] = profile;
	}
	return {
		kind: "preset",
		name,
		...(current ? { originalName: name } : {}),
		...(current?.description ? { description: current.description } : {}),
		...(current?.runtime ? { runtime: current.runtime } : {}),
		defaultProfile: current?.default_profile ?? "",
		complexities,
		steps: { ...(current?.steps ?? {}) },
		roles: { ...verification },
		fusionRoles: { ...fusionPlan },
		otherRoles,
	};
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
 * role tables the form does not edit. */
export function presetMutation(draft: PresetDraft): AgentsMutation {
	const steps = Object.fromEntries(
		Object.entries(draft.steps).filter(([, value]) => value),
	);
	const verificationRoles = Object.fromEntries(
		Object.entries(draft.roles).filter(([, value]) => value),
	);
	const fusionPlanRoles = Object.fromEntries(
		Object.entries(draft.fusionRoles).filter(([, value]) => value),
	);
	const roleTables: Record<string, Record<string, string>> = {
		...draft.otherRoles,
	};
	if (Object.keys(verificationRoles).length)
		roleTables["core.verification"] = verificationRoles;
	if (Object.keys(fusionPlanRoles).length)
		roleTables["fusion.plan"] = fusionPlanRoles;
	const name = draft.name.trim();
	const preset: PresetConfig = {
		...(draft.description ? { description: draft.description } : {}),
		...(draft.runtime ? { runtime: draft.runtime } : {}),
		...(draft.defaultProfile ? { default_profile: draft.defaultProfile } : {}),
		...(Object.keys(steps).length ? { steps } : {}),
		...(Object.keys(roleTables).length ? { roles: roleTables } : {}),
	};
	for (const category of PRESET_CATEGORY_KEYS) {
		const profile = draft.complexities[category];
		if (profile) preset[category] = profile;
	}
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
		for (const category of PRESET_CATEGORY_KEYS)
			if (preset[category] === name)
				refs.push(`presets.${presetName}.${category}`);
	}
	return refs;
}
