/** @jsxImportSource @opentui/solid */

import type { KeyEvent } from "@opentui/core";
import { createSignal, onCleanup, onMount, Show } from "solid-js";
import type { RuntimeId } from "../../../workflow/contracts.ts";
import {
	conflictingAgentsFiles,
	loadConfig,
	saveAgentsSection,
} from "../../../workflow/effects.ts";
import {
	type AgentsConfig,
	BUILTIN_PRESET_NAME,
	clearModelCache,
	type PresetConfig,
	type ProfileConfig,
	parseAgentsConfig,
	runtimeModels,
} from "../../../workflow/profiles.ts";
import { notify } from "../notifications";
import { uiColors } from "./colors";
import { GenericModal, type HelpEntry } from "./GenericModal";
import { SelectableList } from "./Selectable";

const RUNTIMES = ["pi", "opencode", "opencode-v2"] as const;
const RUNTIME_EXECUTABLES: Record<string, string> = {
	pi: "pi",
	opencode: "opencode",
	"opencode-v2": "opencode2",
};
const PRESET_STEPS = [
	"core.plan",
	"core.implementation",
	"core.triage",
	"core.archive",
];
const FUSION_CONSOLIDATE_STEP = "fusion.consolidate";
const FUSION_PLAN_ROLES = [
	"planner-1",
	"planner-2",
	"planner-3",
	"planner-4",
	"planner-5",
];
const VERIFICATION_ROLES = [
	"quality-verifier",
	"security-verifier",
	"performance-verifier",
	"openspec-verifier",
	"usability-verifier",
	"test-verifier",
];
const THINKING_LEVELS = ["", "minimal", "low", "medium", "high"];
const UNSET = "(unset)";

type View = "menu" | "profiles" | "presets" | "editor";
type ProfileDraft = {
	kind: "profile";
	name: string;
	runtime: RuntimeId;
	model: string;
	agent: string;
	thinking: string;
};
type PresetDraft = {
	kind: "preset";
	name: string;
	runtime?: RuntimeId;
	defaultProfile: string;
	steps: Record<string, string>;
	roles: Record<string, string>;
	/** Role assignments under roles.fusion.plan (planner-1..5). */
	fusionRoles: Record<string, string>;
	/** Role tables for steps other than core.verification and fusion.plan,
	 * preserved verbatim. */
	otherRoles: Record<string, Record<string, string>>;
};
type Draft = ProfileDraft | PresetDraft;
interface EditorField {
	key: string;
	label: string;
	kind: "text" | "choice";
	options?: string[];
}

function profileFields(draft: ProfileDraft): EditorField[] {
	const fields: EditorField[] = [
		{ key: "name", label: "Profile name", kind: "text" },
		{
			key: "runtime",
			label: "Execution environment",
			kind: "choice",
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
					kind: "choice",
					options: ["", ...models],
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
			kind: "choice",
			options: [...THINKING_LEVELS],
		});
	return fields;
}
function presetFields(profileNames: string[]): EditorField[] {
	const options = [UNSET, ...profileNames];
	return [
		{ key: "name", label: "Preset name", kind: "text" },
		{
			key: "defaultProfile",
			label: "Default profile (fallback)",
			kind: "choice",
			options,
		},
		...PRESET_STEPS.map((step) => ({
			key: `step:${step}`,
			label: `Step ${step}`,
			kind: "choice" as const,
			options,
		})),
		{
			key: `step:${FUSION_CONSOLIDATE_STEP}`,
			label: `Step ${FUSION_CONSOLIDATE_STEP}`,
			kind: "choice" as const,
			options,
		},
		...FUSION_PLAN_ROLES.map((role) => ({
			key: `fusionRole:${role}`,
			label: `Fusion ${role}`,
			kind: "choice" as const,
			options,
		})),
		...VERIFICATION_ROLES.map((role) => ({
			key: `role:${role}`,
			label: `Verification ${role}`,
			kind: "choice" as const,
			options,
		})),
	];
}
export function ModelConfigModal(props: {
	onCancel: () => void;
	onKeyReady: (handler: (key: KeyEvent) => boolean) => void;
}) {
	const [view, setView] = createSignal<View>("menu");
	const [menuIndex, setMenuIndex] = createSignal(0);
	const [listIndex, setListIndex] = createSignal(0);
	const [version, setVersion] = createSignal(0);
	const [draft, setDraft] = createSignal<Draft>();
	const [fieldIndex, setFieldIndex] = createSignal(0);
	const [choiceIndex, setChoiceIndex] = createSignal(0);
	const [pendingDelete, setPendingDelete] = createSignal<{
		kind: "profile" | "preset";
		name: string;
	}>();
	const [textValue, setTextValue] = createSignal("");
	let lastReadError: string | undefined;
	const reload = () => setVersion((value) => value + 1);

	const agents = (): AgentsConfig | undefined => {
		version();
		try {
			const config = loadConfig();
			const parsed = parseAgentsConfig(config.agents, config);
			lastReadError = undefined;
			return parsed;
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			if (lastReadError !== message) {
				lastReadError = message;
				notify(`Configuration could not be read: ${message}`, "error");
			}
			return undefined;
		}
	};
	const profileNames = () => Object.keys(agents()?.profiles ?? {}).sort();
	const presetNames = () =>
		Object.keys(agents()?.presets ?? {})
			.filter((name) => name !== BUILTIN_PRESET_NAME)
			.sort();

	const openProfileEditor = (existing?: string) => {
		const current = existing ? agents()?.profiles[existing] : undefined;
		clearModelCache();
		setDraft({
			kind: "profile",
			name: existing ?? "",
			runtime: current?.runtime ?? "pi",
			model: current?.model ?? "",
			agent: current?.agent ?? "",
			thinking: current?.thinking ?? "",
		});
		startEditor();
	};
	const openPresetEditor = (existing?: string) => {
		if (existing === BUILTIN_PRESET_NAME) {
			notify(
				"The use-default-model preset is built in and cannot be edited",
				"error",
			);
			return;
		}
		const current = existing ? agents()?.presets?.[existing] : undefined;
		// Edit only the core.verification and fusion.plan role tables; other
		// steps' tables are kept verbatim so an edit-save cycle never collapses
		// them into one step.
		const {
			"core.verification": verification = {},
			"fusion.plan": fusionPlan = {},
			...otherRoles
		} = current?.roles ?? {};
		setDraft({
			kind: "preset",
			name: existing ?? "",
			runtime: current?.runtime,
			defaultProfile: current?.default_profile ?? "",
			steps: { ...(current?.steps ?? {}) },
			roles: { ...verification },
			fusionRoles: { ...fusionPlan },
			otherRoles,
		});
		startEditor();
	};
	const startEditor = () => {
		setFieldIndex(0);
		syncFieldValue();
		setView("editor");
	};
	const fields = (): EditorField[] => {
		const d = draft();
		if (!d) return [];
		return d.kind === "profile"
			? profileFields(d)
			: presetFields(profileNames());
	};
	const field = (): EditorField | undefined => fields()[fieldIndex()];
	const fieldValue = (d: Draft, f: EditorField): string => {
		if (d.kind === "profile")
			switch (f.key) {
				case "name":
					return d.name;
				case "runtime":
					return d.runtime;
				case "model":
					return d.model;
				case "agent":
					return d.agent;
				case "thinking":
					return d.thinking;
			}
		else {
			if (f.key === "name") return d.name;
			if (f.key === "defaultProfile") return d.defaultProfile;
			if (f.key.startsWith("step:")) return d.steps[f.key.slice(5)] ?? "";
			if (f.key.startsWith("fusionRole:"))
				return d.fusionRoles[f.key.slice("fusionRole:".length)] ?? "";
			if (f.key.startsWith("role:")) return d.roles[f.key.slice(5)] ?? "";
		}
		return "";
	};
	const fieldOptions = (f: EditorField): string[] => {
		const d = draft();
		const base = f.options ?? [];
		if (!d) return base;
		const current = fieldValue(d, f);
		if (current && !base.includes(current)) return [current, ...base];
		return base;
	};
	const syncFieldValue = () => {
		const d = draft();
		const f = field();
		if (!d || !f) return;
		const value = fieldValue(d, f);
		if (f.kind === "text") setTextValue(value);
		else setChoiceIndex(Math.max(0, fieldOptions(f).indexOf(value)));
	};
	// Only the "(unset)" label maps to empty for storage; empty values stay empty
	// so they are omitted from saved profiles/presets entirely.
	const display = (value: string) => (value === UNSET ? "" : value);

	const applyField = (): void => {
		const d = draft();
		const f = field();
		if (!d || !f) return;
		const raw =
			f.kind === "text"
				? textValue().trim()
				: (fieldOptions(f)[choiceIndex()] ?? "");
		const value = display(raw);
		setDraft((current) => {
			if (!current) return current;
			if (current.kind === "profile") {
				const next = { ...current };
				if (f.key === "name") next.name = value;
				else if (f.key === "runtime") {
					if (next.runtime !== value) {
						next.model = "";
						next.agent = "";
						next.thinking = "";
					}
					next.runtime = value as RuntimeId;
				} else if (f.key === "model") next.model = value;
				else if (f.key === "agent") next.agent = value;
				else if (f.key === "thinking") next.thinking = value;
				return next;
			}
			const next = {
				...current,
				steps: { ...current.steps },
				roles: { ...current.roles },
				fusionRoles: { ...current.fusionRoles },
			};
			if (f.key === "name") next.name = value;
			else if (f.key === "defaultProfile") next.defaultProfile = value;
			else if (f.key.startsWith("step:")) next.steps[f.key.slice(5)] = value;
			else if (f.key.startsWith("fusionRole:"))
				next.fusionRoles[f.key.slice("fusionRole:".length)] = value;
			else if (f.key.startsWith("role:")) next.roles[f.key.slice(5)] = value;
			return next;
		});
		advance();
	};
	const advance = () => {
		if (fieldIndex() + 1 >= fields().length) {
			finishEditor();
			return;
		}
		setFieldIndex((index) => index + 1);
		syncFieldValue();
	};
	const backField = () => {
		if (fieldIndex() === 0) {
			setView(draft()?.kind === "profile" ? "profiles" : "presets");
			return;
		}
		setFieldIndex((index) => index - 1);
		syncFieldValue();
	};

	/** Refuse writes while another config file also defines [agents]: entries
	 * living only there cannot be removed via this target and would resurrect
	 * at load time. */
	const refuseOnConflict = (): boolean => {
		try {
			const conflicts = conflictingAgentsFiles();
			if (!conflicts.length) return false;
			notify(
				`Not saved: [agents] is also defined in ${conflicts.join(", ")}; remove it there first so dashboard edits are not shadowed`,
				"error",
			);
			return true;
		} catch (error) {
			notify(error instanceof Error ? error.message : String(error), "error");
			return true;
		}
	};

	const finishEditor = (): void => {
		const d = draft();
		if (!d) return;
		if (refuseOnConflict()) return;
		if (!d.name.trim()) {
			notify("Name is required", "error");
			return;
		}
		if (d.name === BUILTIN_PRESET_NAME) {
			notify("The use-default-model name is reserved", "error");
			return;
		}
		try {
			if (d.kind === "profile") saveProfile(d);
			else savePreset(d);
		} catch (error) {
			notify(error instanceof Error ? error.message : String(error), "error");
			return;
		}
		reload();
		notify(
			`${d.kind === "profile" ? "Profile" : "Preset"} ${d.name} saved`,
			"success",
		);
		setDraft(undefined);
		setView(d.kind === "profile" ? "profiles" : "presets");
	};
	const saveProfile = (d: ProfileDraft): void => {
		const profile: ProfileConfig = {
			runtime: d.runtime,
			...(d.model ? { model: d.model } : {}),
			...(d.agent ? { agent: d.agent } : {}),
			...(d.thinking ? { thinking: d.thinking } : {}),
		};
		saveAgentsSection((section) => {
			if (section.profiles === undefined || section.profiles === null)
				section.profiles = {};
			else if (
				typeof section.profiles !== "object" ||
				Array.isArray(section.profiles)
			)
				throw new Error("agents.profiles must be a table of profiles");
			(section.profiles as Record<string, unknown>)[d.name] = profile;
		});
	};
	const savePreset = (d: PresetDraft): void => {
		const steps = Object.fromEntries(
			Object.entries(d.steps).filter(([, value]) => value),
		);
		const verificationRoles = Object.fromEntries(
			Object.entries(d.roles).filter(([, value]) => value),
		);
		const fusionPlanRoles = Object.fromEntries(
			Object.entries(d.fusionRoles).filter(([, value]) => value),
		);
		const roleTables: Record<string, Record<string, string>> = {
			...d.otherRoles,
		};
		if (Object.keys(verificationRoles).length)
			roleTables["core.verification"] = verificationRoles;
		if (Object.keys(fusionPlanRoles).length)
			roleTables["fusion.plan"] = fusionPlanRoles;
		const preset: PresetConfig = {
			...(d.runtime ? { runtime: d.runtime } : {}),
			...(d.defaultProfile ? { default_profile: d.defaultProfile } : {}),
			...(Object.keys(steps).length ? { steps } : {}),
			...(Object.keys(roleTables).length ? { roles: roleTables } : {}),
		};
		saveAgentsSection((section) => {
			if (section.presets === undefined || section.presets === null)
				section.presets = {};
			else if (
				typeof section.presets !== "object" ||
				Array.isArray(section.presets)
			)
				throw new Error("agents.presets must be a table of presets");
			(section.presets as Record<string, unknown>)[d.name] = preset;
		});
	};

	const profileReferences = (agents: AgentsConfig, name: string): string[] => {
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
		}
		return refs;
	};
	const deleteProfile = (name: string): void => {
		const current = agents();
		if (!current) return;
		const refs = profileReferences(current, name);
		if (refs.length) {
			notify(
				`Cannot delete ${name}: referenced by ${refs.join(", ")}`,
				"error",
			);
			return;
		}
		try {
			saveAgentsSection((section) => {
				if (section.profiles && typeof section.profiles === "object")
					delete (section.profiles as Record<string, unknown>)[name];
			});
		} catch (error) {
			notify(error instanceof Error ? error.message : String(error), "error");
			return;
		}
		reload();
		notify(`Profile ${name} deleted`, "success");
	};
	const deletePreset = (name: string): void => {
		if (name === BUILTIN_PRESET_NAME) {
			notify(
				"The use-default-model preset is built in and cannot be deleted",
				"error",
			);
			return;
		}
		if (refuseOnConflict()) return;
		try {
			saveAgentsSection((section) => {
				if (section.presets && typeof section.presets === "object")
					delete (section.presets as Record<string, unknown>)[name];
			});
		} catch (error) {
			notify(error instanceof Error ? error.message : String(error), "error");
			return;
		}
		reload();
		notify(`Preset ${name} deleted`, "success");
	};

	const listItems = (): string[] => {
		if (view() === "profiles")
			return [...profileNames(), "(create new profile…)"];
		if (view() === "presets")
			return [...presetNames(), "(create new preset…)", BUILTIN_PRESET_NAME];
		return [];
	};
	const isCreateItem = (index: number) =>
		listItems()[index] ===
		(view() === "profiles" ? "(create new profile…)" : "(create new preset…)");

	const editorTitle = () => {
		const d = draft();
		if (!d) return "";
		return d.kind === "profile"
			? "Agent profile"
			: "Agent configuration preset";
	};
	const summary = () =>
		fields()
			.slice(0, fieldIndex())
			.map((f) => ({
				label: f.label,
				value: (() => {
					const d = draft();
					const raw = d ? fieldValue(d, f) : "";
					return raw === "" ? "—" : raw;
				})(),
			}));
	const editorHelp = (f: EditorField): HelpEntry[] =>
		f.kind === "text"
			? [
					{ key: "Type", action: "Enter value" },
					{ key: "Backspace", action: "Delete" },
					{ key: "Enter", action: "Next" },
					{ key: "Esc", action: "Back" },
				]
			: [
					{ key: "j/k", action: "Select" },
					{ key: "Enter", action: "Next" },
					{ key: "Esc", action: "Back" },
				];

	const handler = (key: KeyEvent): boolean => {
		const name = key.name.toLowerCase();
		const confirm = pendingDelete();
		if (confirm) {
			if (name === "escape" || name === "n") setPendingDelete(undefined);
			else if (name === "y" || name === "enter" || name === "return") {
				setPendingDelete(undefined);
				if (confirm.kind === "profile") deleteProfile(confirm.name);
				else deletePreset(confirm.name);
			}
			return true;
		}
		if (view() === "menu") {
			if (name === "escape") {
				props.onCancel();
				return true;
			}
			if (name === "j" || name === "down")
				setMenuIndex((index) => Math.min(index + 1, 1));
			else if (name === "k" || name === "up")
				setMenuIndex((index) => Math.max(index - 1, 0));
			else if (name === "enter" || name === "return") {
				setListIndex(0);
				setView(menuIndex() === 0 ? "profiles" : "presets");
			}
			return true;
		}
		if (view() === "profiles" || view() === "presets") {
			const items = listItems();
			if (name === "escape") {
				setView("menu");
				return true;
			}
			if (name === "d") {
				// Deletion is destructive and writes straight to config: require an
				// explicit second confirmation before issuing it.
				const item = items[listIndex()];
				if (item && !isCreateItem(listIndex()) && item !== BUILTIN_PRESET_NAME)
					setPendingDelete({
						kind: view() === "profiles" ? "profile" : "preset",
						name: item,
					});
				return true;
			}
			if (name === "j" || name === "down")
				setListIndex((index) => Math.min(index + 1, items.length - 1));
			else if (name === "k" || name === "up")
				setListIndex((index) => Math.max(index - 1, 0));
			else if (name === "enter" || name === "return") {
				const index = listIndex();
				const item = items[index];
				if (!item) return true;
				const creating = isCreateItem(index);
				setListIndex(0);
				if (view() === "profiles") {
					if (creating) openProfileEditor();
					else openProfileEditor(item);
				} else if (creating) openPresetEditor();
				else openPresetEditor(item);
			}
			return true;
		}
		// editor
		const f = field();
		if (!f) return true;
		if (name === "escape") {
			backField();
			return true;
		}
		if (f.kind === "text") {
			if ((name === "enter" || name === "return") && !key.meta) applyField();
			else if (name === "backspace" || name === "delete")
				setTextValue((value) => value.slice(0, -1));
			else if (key.sequence?.length === 1 && key.sequence >= " ")
				setTextValue((value) => value + key.sequence);
			return true;
		}
		const options = fieldOptions(f);
		if (name === "j" || name === "down")
			setChoiceIndex((index) => Math.min(index + 1, options.length - 1));
		else if (name === "k" || name === "up")
			setChoiceIndex((index) => Math.max(index - 1, 0));
		else if (name === "enter" || name === "return") applyField();
		return true;
	};

	onMount(() => props.onKeyReady(handler));
	onCleanup(() => props.onKeyReady(() => true));

	return (
		<>
			<Show when={pendingDelete()}>
				{(confirm) => (
					<GenericModal
						title={`Delete ${confirm().kind}?`}
						fieldLabel={confirm().name}
						help={[
							{ key: "y/Enter", action: "Confirm delete" },
							{ key: "Esc/n", action: "Cancel" },
						]}
					>
						<box width="100%" flexDirection="column">
							<text fg={uiColors.textPrimary}>
								Delete "{confirm().name}" from the managed config?
							</text>
							<text fg={uiColors.warning}>This cannot be undone.</text>
						</box>
					</GenericModal>
				)}
			</Show>
			<Show when={view() === "menu"}>
				<GenericModal
					title="Model configuration"
					fieldLabel="Manage"
					help={[
						{ key: "j/k", action: "Navigate" },
						{ key: "Enter", action: "Open" },
						{ key: "Esc", action: "Close" },
					]}
				>
					<box width="100%" height="100%" flexDirection="column">
						<SelectableList
							items={["Profiles", "Presets"]}
							selectedIndex={menuIndex()}
							renderItem={(item, active) => (
								<text fg={active ? uiColors.primary : uiColors.textSecondary}>
									{item}
									{item === "Profiles"
										? ` (${profileNames().length})`
										: ` (${presetNames().length})`}
								</text>
							)}
						/>
						<text fg={uiColors.textMuted}>
							Saving rewrites the managed config file; comments in it are not
							preserved.
						</text>
					</box>
				</GenericModal>
			</Show>
			<Show
				when={view() === "profiles" || view() === "presets"}
				fallback={
					<Show when={view() === "editor" && field()}>
						{(f) => (
							<GenericModal
								title={editorTitle()}
								fieldLabel={f().label}
								summary={summary()}
								step={fieldIndex()}
								total={Math.max(1, fields().length)}
								help={editorHelp(f())}
							>
								<Show
									when={f().kind === "text"}
									fallback={
										<SelectableList
											items={fieldOptions(f())}
											selectedIndex={Math.min(
												choiceIndex(),
												Math.max(0, fieldOptions(f()).length - 1),
											)}
											renderItem={(item, active) => (
												<text
													fg={
														active ? uiColors.primary : uiColors.textSecondary
													}
												>
													{item === "" ? UNSET : item}
												</text>
											)}
										/>
									}
								>
									<box width="100%" flexDirection="column">
										<text fg={uiColors.textPrimary}>
											{textValue()}
											<span style={{ fg: uiColors.primary }}>▌</span>
										</text>
										{textValue() ? null : (
											<text fg={uiColors.textMuted}>Type a value…</text>
										)}
									</box>
								</Show>
							</GenericModal>
						)}
					</Show>
				}
			>
				<GenericModal
					title={view() === "profiles" ? "Agent profiles" : "Agent presets"}
					fieldLabel="Entries"
					help={[
						{ key: "j/k", action: "Navigate" },
						{ key: "Enter", action: "Edit / create" },
						{ key: "d", action: "Delete" },
						{ key: "Esc", action: "Back" },
					]}
				>
					<SelectableList
						items={listItems()}
						selectedIndex={listIndex()}
						renderItem={(item, active) => (
							<text fg={active ? uiColors.primary : uiColors.textSecondary}>
								{item === BUILTIN_PRESET_NAME ? `${item} (built-in)` : item}
							</text>
						)}
					/>
				</GenericModal>
			</Show>
		</>
	);
}
