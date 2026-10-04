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
	GATE_POLICIES,
	type GatePolicy,
	POOL_STEPS,
	type PoolEntry,
	type PresetConfig,
	type ProfileConfig,
} from "../../workflow/profiles.ts";
import {
	type AgentsConfig,
	type AgentsMutation,
	BUILTIN_PRESET_NAME,
} from "../data/agents.ts";

/** The one execution environment (multiplexer removal). */
export const RUNTIMES = ["pi-durable"] as const;
const THINKING_LEVELS = ["", "minimal", "low", "medium", "high"];

export type AgentListKind = "profiles" | "presets";

/** The classifiable steps the pool editor renders, in display order. */
export const POOL_EDITOR_STEPS: ReadonlyArray<{
	stepId: string;
	mode: ClassificationMode;
}> = Object.entries(POOL_STEPS).map(([stepId, mode]) => ({ stepId, mode }));

/** The stage gates the preset editor renders, in the protocol's own order.
 * The display label is UI copy; the key is the config stage name. The hint
 * states what `auto` actually removes, because the verification gate in
 * particular removes the triage step as well as verification, and a skipped
 * test suite or human review must never be a silent choice. */
export const GATE_EDITOR_STAGES: ReadonlyArray<{
	stage: string;
	label: string;
	hint: string;
}> = [
	{
		stage: "planApproval",
		label: "Plan approval",
		hint: "always shows the approval step; auto lets the classifier skip it",
	},
	{
		stage: "verification",
		label: "Verification (with triage)",
		hint: "auto skips triage AND verification — no verifier runs at all",
	},
	{
		stage: "developerReview",
		label: "Developer review",
		hint: "always shows the human review; auto lets the classifier skip it",
	},
	{
		stage: "wiki",
		label: "Wiki documentation",
		hint: "auto skips the wiki page and its approval",
	},
] as const;

/** The value a stage select carries when this preset does not own the stage:
 * the effective policy from the global `agents.gates` table. Choosing it
 * removes the preset entry, so the stage inherits again. */
export const GATE_INHERIT = "inherit";

export interface ProfileDraft {
	kind: "profile";
	name: string;
	/** Name the draft was loaded from; undefined for a new entry. */
	originalName?: string;
	runtime: RuntimeId;
	model: string;
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
	/** Stage gate policies this preset owns. A stage absent here is resolved
	 * from `globalGates` and then from the `always` default, and is not
	 * persisted until the user gives it an explicit policy. */
	gates: Record<string, GatePolicy>;
	/** The global `agents.gates` table, carried so the editor can show the
	 * effective value of a stage the preset does not own. */
	globalGates?: Record<string, GatePolicy>;
}

export type Draft = ProfileDraft | PresetDraft;

/** Field key for the item manager of one classifiable step. */
export const poolItemsKey = (step: string): string => `pool:${step}:items`;

/** Field key for one stage gate's policy select. */
export const gateItemsKey = (stage: string): string => `gate:${stage}`;

/** Profile fields for the current runtime; model is a choice when the runtime
 * enumerates models, otherwise free text. `durableModels` is the model list the
 * durable runtime's configured providers offer, supplied by the caller because
 * resolving it is asynchronous (pi-ai) and spawns nothing. While it is still
 * loading, if it could not be resolved, or when it is empty (no provider is
 * configured), the field stays free text: an empty choice list would leave no
 * way to name a model at all. */
export function profileFields(
	draft: ProfileDraft,
	durableModels?: readonly string[],
): FormField[] {
	const fields: FormField[] = [
		{ key: "name", label: "Profile name", kind: "text" },
		{
			key: "runtime",
			label: "Execution environment",
			kind: "select",
			options: [...RUNTIMES],
		},
	];
	// A durable profile never spawns a runtime to enumerate: the bundled runtime
	// has no model CLI, and its models are the configured providers' models the
	// caller resolved in process (the same list the dashboard `/model` picker
	// shows for a durable run).
	const models: string[] | undefined =
		durableModels && durableModels.length > 0 ? [...durableModels] : undefined;
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
	fields.push({
		key: "thinking",
		label: "Thinking level",
		kind: "select",
		options: [...THINKING_LEVELS],
	});
	return fields;
}

/** Preset fields. Each classifiable step opens a pool-entry manager, and the
 * stage gates follow as selects. `gates`/`globalGates` are the draft's own
 * table and the global fallback: a stage the draft does not own offers
 * `inherit` and states in its hint which policy that resolves to, so the form
 * never shows a value the engine would not use. */
export function presetFields(
	profileNames: readonly string[],
	gates: Readonly<Record<string, GatePolicy>> = {},
	globalGates: Readonly<Record<string, GatePolicy>> = {},
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
	for (const { stepId } of POOL_EDITOR_STEPS)
		fields.push({
			key: poolItemsKey(stepId),
			label: `Pool ${stepId} entries`,
			kind: "action",
		});
	// The stage-gate section: one select per stage over the fixed policy
	// vocabulary, reusing the existing `select` field kind.
	for (const { stage, label, hint } of GATE_EDITOR_STAGES) {
		const inherited = globalGates[stage] ?? "always";
		fields.push({
			key: gateItemsKey(stage),
			label: `Stage gate: ${label}`,
			kind: "select",
			options: [GATE_INHERIT, ...GATE_POLICIES],
			hint: gates[stage] ? hint : `inherits ${inherited} — ${hint}`,
		});
	}
	return fields;
}

/** The fields of a draft (depends on the profile runtime). */
export function draftFields(
	draft: Draft,
	profileNames: readonly string[],
	durableModels?: readonly string[],
): FormField[] {
	return draft.kind === "profile"
		? profileFields(draft, durableModels)
		: presetFields(profileNames, draft.gates, draft.globalGates ?? {});
}

/** Flatten a draft into the form's value map. */
export function draftValues(draft: Draft): FormValues {
	if (draft.kind === "profile")
		return {
			name: draft.name,
			runtime: draft.runtime,
			model: draft.model,
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
	// A stage this preset does not own is `inherit`: the field's hint names the
	// policy that resolves to, so the select never claims a value the engine
	// would not use.
	for (const { stage } of GATE_EDITOR_STAGES)
		values[gateItemsKey(stage)] = draft.gates[stage] ?? GATE_INHERIT;
	return values;
}

/** Apply one edited field back onto the draft. Changing a profile's runtime
 * clears every runtime-scoped field (model/thinking/executable/extensions) so
 * a stale value cannot survive under a runtime that does not accept it. */
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
				next.thinking = "";
				delete next.executable;
				delete next.extensions;
			}
			next.runtime = value as RuntimeId;
		} else if (key === "model") next.model = value;
		else if (key === "thinking") next.thinking = value;
		return next;
	}
	const next = { ...draft };
	if (key === "name") next.name = value;
	else if (key === "defaultProfile") next.defaultProfile = value;
	else {
		const stage = GATE_EDITOR_STAGES.find(
			(entry) => gateItemsKey(entry.stage) === key,
		)?.stage;
		if (stage) {
			// `inherit` is a removal, not a third policy: the stage falls back
			// to the global table and then to `always`.
			if (value === GATE_INHERIT) {
				const gates = { ...next.gates };
				delete gates[stage];
				next.gates = gates;
			} else if ((GATE_POLICIES as readonly string[]).includes(value))
				next.gates = { ...next.gates, [stage]: value as GatePolicy };
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
		runtime: profile?.runtime ?? "pi-durable",
		model: profile?.model ?? "",
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
	globalGates?: Record<string, GatePolicy>,
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
		gates: { ...(current?.gates ?? {}) },
		...(globalGates ? { globalGates: { ...globalGates } } : {}),
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
	// Only stages the user actually set are persisted: an unedited stage must
	// keep resolving from the global table and the `always` default rather than
	// freezing today's fallback into the preset.
	const gates = Object.fromEntries(
		Object.entries(draft.gates).filter(([, policy]) =>
			(GATE_POLICIES as readonly string[]).includes(policy),
		),
	) as Record<string, GatePolicy>;
	const name = draft.name.trim();
	const preset: PresetConfig = {
		...(draft.description ? { description: draft.description } : {}),
		...(draft.runtime ? { runtime: draft.runtime } : {}),
		...(draft.defaultProfile ? { default_profile: draft.defaultProfile } : {}),
		...(Object.keys(steps).length ? { steps } : {}),
		...(Object.keys(roleTables).length ? { roles: roleTables } : {}),
		...(Object.keys(pools).length ? { pools } : {}),
		...(Object.keys(gates).length ? { gates } : {}),
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
