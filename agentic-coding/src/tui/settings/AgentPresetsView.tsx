/** @jsxImportSource @opentui/solid */
// Settings → Agent Presets (rework-model-profiles-and-presets).
//
// One inline surface for both halves of agent configuration: the menu offers
// "Model profiles" and "Presets"; each opens a selectable list; Enter edits the
// selected entry in a prefilled form and `+` opens the same form empty. There
// is no editor modal any more — the form is a page body that owns its keys
// through a keymap layer while it is mounted, so a name can contain any
// character without the shell's single-letter shortcuts firing.
import type { KeyEvent, Renderable } from "@opentui/core";
import type { Keymap } from "@opentui/keymap";
import {
	Card,
	Form,
	type FormErrors,
	type FormField,
	type FormPane,
	type FormValues,
	firstErrorField,
	formOptionIndex,
	formValues,
	GenericModal,
	hostChromeLines,
	type KeybindSection,
	LAYOUT_CHROME_LINES,
	ScrollableList,
	setActiveKeybindCatalog,
	showErrorModal,
	uiColors,
	useTerminalDimensions,
} from "@ui";
import { createEffect, createSignal, onCleanup, onMount, Show } from "solid-js";
import {
	agentConfigEntry,
	refreshAgentConfig,
	reloadAgentConfigLocal,
} from "../dash/agent-config-cache.ts";
import {
	type ConsoleIssue,
	captureConsoleIssues,
} from "../dash/consoleCapture.ts";
import { notify } from "../dash/notifications.ts";
import { traceTui } from "../dash/tracing.ts";
import {
	type AgentsMutation,
	applyAgentsMutation,
	BUILTIN_PRESET_NAME,
	clearModelCache,
	saveAgentConfig,
} from "../data/agents.ts";
import { gatewayOrUndefined } from "../data/index.ts";
import {
	type AgentListKind,
	applyDraftValue,
	type Draft,
	draftFields,
	draftValues,
	movePoolEntry,
	POOL_EDITOR_STEPS,
	type PresetDraft,
	poolItemsKey,
	presetDraft,
	presetMutation,
	profileDraft,
	profileMutation,
	profileReferences,
	validateDraft,
} from "./agentPresets.ts";
import type { SettingsItem } from "./items.ts";

/** Keys the surface owns while it is mounted. */
const SURFACE_KEYS = [
	"escape",
	"return",
	"enter",
	"tab",
	"shift+tab",
	"backspace",
	"delete",
	"up",
	"down",
	"shift+up",
	"shift+down",
	"left",
	"right",
	"home",
	"end",
	"j",
	"k",
	"d",
	"+",
	"=",
	"y",
	"n",
	"/",
	"'",
	'"',
	..."abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789-_[]{};:\\|,.<>`~!@#$%^&*() "
		.split("")
		.map((key) => (key === " " ? "space" : key)),
];

export interface AgentPresetsViewProps {
	keymap?: Keymap<Renderable, KeyEvent>;
	/** Project scope; absent means the user configuration. */
	repository?: string;
	/** Inventoried section items: the two menu options plus any editable
	 * informational rows (e.g. reset to user scope). Read-only rows are dropped
	 * here because this menu only offers actions the user can take. */
	items?: readonly SettingsItem[];
	/** Activate an informational row (e.g. reset to user scope). */
	onActivate?: (item: SettingsItem) => void;
}

type View = "menu" | "list" | "form" | "pool-list" | "pool-entry";

/** One row of the Agent Presets menu. */
interface MenuEntry {
	id: string;
	label: string;
	detail: string;
	/** Set on the two navigation options. */
	list?: AgentListKind;
	/** Present on informational rows. */
	item?: SettingsItem;
}

type PoolEntryValue = PresetDraft["pools"][string][number];

interface PoolEntryEditor {
	step: string;
	index?: number;
	entry: PoolEntryValue;
	fieldIndex: number;
	focusedPane: FormPane;
	editing: boolean;
	choiceCursorIndex: number;
	errors: FormErrors;
}

interface PoolClipboard {
	sourceStep: string;
	entries: PoolEntryValue[];
}

export function AgentPresetsView(props: AgentPresetsViewProps) {
	const dimensions = useTerminalDimensions();
	const contentLines = () =>
		Math.max(1, dimensions().height - hostChromeLines(LAYOUT_CHROME_LINES) - 1);

	const [version, setVersion] = createSignal(0);
	const [view, setView] = createSignal<View>("menu");
	const [menuIndex, setMenuIndex] = createSignal(0);
	const [listKind, setListKind] = createSignal<AgentListKind>("profiles");
	const [listIndex, setListIndex] = createSignal(0);
	const [draft, setDraft] = createSignal<Draft>();
	const [fieldIndex, setFieldIndex] = createSignal(0);
	const [focusedPane, setFocusedPane] = createSignal<FormPane>("field");
	const [editing, setEditing] = createSignal(false);
	const [choiceCursors, setChoiceCursors] = createSignal<
		Record<string, number>
	>({});
	const [poolStep, setPoolStep] = createSignal<string>();
	const [poolIndex, setPoolIndex] = createSignal(0);
	const [poolClipboard, setPoolClipboard] = createSignal<PoolClipboard>();
	const [poolEntryEditor, setPoolEntryEditor] = createSignal<PoolEntryEditor>();
	const [errors, setErrors] = createSignal<FormErrors>({});
	const [editorRevision, setEditorRevision] = createSignal<string>();
	const [pendingDelete, setPendingDelete] = createSignal<{
		kind: AgentListKind;
		name: string;
	}>();

	const reload = () => {
		setVersion((value) => value + 1);
		void refreshAgentConfig(props.repository).then(() =>
			setVersion((value) => value + 1),
		);
	};

	// The same section page can move between the user and a project scope; a
	// changed repository resets the surface and re-reads the new configuration.
	let lastRepository = props.repository;
	createEffect(() => {
		const repository = props.repository;
		if (repository === lastRepository) return;
		lastRepository = repository;
		setView("menu");
		setDraft(undefined);
		setErrors({});
		reload();
	});

	let lastReadError: string | undefined;
	const agents = () => {
		version();
		const entry = agentConfigEntry(props.repository);
		if (entry.error) {
			if (lastReadError !== entry.error) {
				lastReadError = entry.error;
				notify(`Configuration could not be read: ${entry.error}`, "error");
			}
			return undefined;
		}
		lastReadError = undefined;
		return entry.agents;
	};
	const profileNames = () => Object.keys(agents()?.profiles ?? {}).sort();
	const presetNames = () =>
		Object.keys(agents()?.presets ?? {})
			.filter((name) => name !== BUILTIN_PRESET_NAME)
			.sort();

	const fields = (): FormField[] => {
		const current = draft();
		if (!current) return [];
		return draftFields(current, profileNames());
	};
	const values = (): FormValues => {
		const current = draft();
		// Merge the draft over the field defaults so a blank/new field still gets
		// its declared default before the first edit.
		return formValues(fields(), current ? draftValues(current) : {});
	};
	const field = (): FormField | undefined => fields()[fieldIndex()];
	const poolStepForField = (key: string) =>
		POOL_EDITOR_STEPS.find(({ stepId }) => poolItemsKey(stepId) === key)
			?.stepId;
	const poolEntries = () => {
		const current = draft();
		const step = poolStep();
		return current?.kind === "preset" && step
			? (current.pools[step] ?? [])
			: [];
	};
	const poolEntryFields = (): FormField[] => {
		const editor = poolEntryEditor();
		if (!editor) return [];
		const fields: FormField[] = [
			{ key: "label", label: "Profile tag", kind: "text" },
			{
				key: "profile",
				label: "Agent profile",
				kind: "select",
				options: ["", ...profileNames()],
			},
		];
		if (
			POOL_EDITOR_STEPS.find(({ stepId }) => stepId === editor.step)?.mode ===
			"roster"
		)
			fields.push({
				key: "default",
				label: "Roster default",
				kind: "select",
				options: ["", "default"],
			});
		return fields;
	};
	const poolEntryValues = (): FormValues => {
		const entry = poolEntryEditor()?.entry;
		return {
			label: entry?.label ?? "",
			profile: entry?.profile ?? "",
			default: entry?.default ? "default" : "",
		};
	};
	const poolEntryField = () =>
		poolEntryFields()[poolEntryEditor()?.fieldIndex ?? 0];

	const openProfileEditor = (existing?: string) => {
		const current = existing ? agents()?.profiles[existing] : undefined;
		clearModelCache();
		setDraft(profileDraft(existing ?? "", current));
		setEditorRevision(agentConfigEntry(props.repository).revision);
		setFieldIndex(0);
		setFocusedPane("field");
		setEditing(false);
		setChoiceCursors({});
		setErrors({});
		setView("form");
	};
	const openPresetEditor = (existing?: string) => {
		if (existing === BUILTIN_PRESET_NAME) {
			notify(
				"The use-default-model preset is built in and cannot be edited",
				"error",
			);
			return;
		}
		setDraft(presetDraft(existing ?? "", agents()?.presets));
		setPoolClipboard(undefined);
		setEditorRevision(agentConfigEntry(props.repository).revision);
		setFieldIndex(0);
		setFocusedPane("field");
		setEditing(false);
		setChoiceCursors({});
		setErrors({});
		setView("form");
	};
	const openCreate = () => {
		if (listKind() === "profiles") openProfileEditor();
		else openPresetEditor();
	};
	const openSelected = () => {
		const name = listItems()[listIndex()];
		if (!name) return;
		if (listKind() === "profiles") openProfileEditor(name);
		else openPresetEditor(name);
	};

	const listItems = (): string[] =>
		listKind() === "profiles"
			? profileNames()
			: [...presetNames(), BUILTIN_PRESET_NAME];

	// The two editable options lead the menu; every editable informational row
	// (reset-to-user-scope) follows so its action stays reachable. Read-only
	// rows (scope, project checkout, routing, inactive legacy config, read
	// errors, conflicts) are not actionable here and are dropped.
	const menuEntries = (): MenuEntry[] => {
		const profiles = props.items?.find((item) => item.id === "agents.profiles");
		const presets = props.items?.find((item) => item.id === "agents.presets");
		const options: MenuEntry[] = [
			{
				id: "agents.profiles",
				label: profiles?.label ?? "Model profiles",
				detail: profiles
					? `${profiles.value} · ${profiles.detail}`
					: `${profileNames().length} profiles · runtime, model, thinking`,
				list: "profiles",
			},
			{
				id: "agents.presets",
				label: presets?.label ?? "Presets",
				detail: presets
					? `${presets.value} · ${presets.detail}`
					: `${presetNames().length} presets · step and model-pool routing`,
				list: "presets",
			},
		];
		const info: MenuEntry[] = (props.items ?? [])
			.filter(
				(item) =>
					item.editable &&
					item.id !== "agents.profiles" &&
					item.id !== "agents.presets",
			)
			.map((item) => ({
				id: item.id,
				label: item.label,
				// The scope item's detail already opens with its value, so only
				// prepend the value when the detail does not restate it.
				detail: `${
					item.value && !item.detail.startsWith(item.value)
						? `${item.value} · `
						: ""
				}${item.detail}`,
				item,
			}));
		return [...options, ...info];
	};

	const setError = (key: string, message: string | undefined) =>
		setErrors((current) => ({ ...current, [key]: message }));
	const editDraft = (key: string, value: string) => {
		const current = draft();
		if (!current) return;
		setDraft(applyDraftValue(current, key, value));
		setError(key, undefined);
	};
	const moveField = (delta: number) => {
		const nextIndex = Math.max(
			0,
			Math.min(fields().length - 1, fieldIndex() + delta),
		);
		setFieldIndex(nextIndex);
		const next = fields()[nextIndex];
		if (next?.kind === "select")
			setChoiceCursors((current) => ({
				...current,
				[next.key]: formOptionIndex(next, values()[next.key] ?? ""),
			}));
	};
	const choiceCursorIndex = () => {
		const focused = field();
		if (focused?.kind !== "select") return 0;
		const options = focused.options ?? [];
		return Math.min(
			choiceCursors()[focused.key] ??
				formOptionIndex(focused, values()[focused.key] ?? ""),
			Math.max(0, options.length - 1),
		);
	};
	const moveChoiceCursor = (delta: number) => {
		const focused = field();
		const options = focused?.options ?? [];
		if (focused?.kind !== "select" || options.length === 0) return;
		setChoiceCursors((current) => ({
			...current,
			[focused.key]:
				(choiceCursorIndex() + delta + options.length) % options.length,
		}));
	};
	const commitChoice = () => {
		const focused = field();
		if (focused?.kind !== "select") return;
		const option = focused.options?.[choiceCursorIndex()];
		if (option !== undefined) editDraft(focused.key, option);
	};
	const clearChoice = () => {
		const focused = field();
		if (focused?.kind !== "select") return;
		const emptyIndex = focused.options?.indexOf("") ?? -1;
		if (emptyIndex >= 0)
			setChoiceCursors((current) => ({
				...current,
				[focused.key]: emptyIndex,
			}));
		editDraft(focused.key, "");
	};
	const openPoolManager = (step: string) => {
		setPoolStep(step);
		setPoolIndex(0);
		setView("pool-list");
	};
	const copyPool = (step: string) => {
		const current = draft();
		if (current?.kind !== "preset") return;
		setPoolClipboard({
			sourceStep: step,
			entries: (current.pools[step] ?? []).map((entry) => ({ ...entry })),
		});
		notify(`Copied pool entries from ${step}`, "success");
	};
	const pastePool = (step: string) => {
		const current = draft();
		const copied = poolClipboard();
		if (current?.kind !== "preset") return;
		if (!copied) {
			notify("No pool copied; press y on a source step first", "warning");
			return;
		}
		const pools = { ...current.pools };
		if (copied.entries.length)
			pools[step] = copied.entries.map((entry) => ({ ...entry }));
		else delete pools[step];
		setDraft({ ...current, pools });
		setErrors((errors) => ({ ...errors, [poolItemsKey(step)]: undefined }));
		notify(
			`Pasted pool entries from ${copied.sourceStep} to ${step}`,
			"success",
		);
	};
	const openPoolEntry = (index?: number) => {
		const current = draft();
		const step = poolStep();
		if (current?.kind !== "preset" || !step) return;
		const existing =
			index === undefined ? undefined : current.pools[step]?.[index];
		if (index !== undefined && !existing) return;
		const profileOptions = ["", ...profileNames()];
		setPoolEntryEditor({
			step,
			...(index !== undefined ? { index } : {}),
			entry: existing ? { ...existing } : { label: "", profile: "" },
			fieldIndex: 0,
			focusedPane: "field",
			editing: false,
			choiceCursorIndex: Math.max(
				0,
				profileOptions.indexOf(existing?.profile ?? ""),
			),
			errors: {},
		});
		setView("pool-entry");
	};
	const editPoolEntryValue = (key: string, value: string) => {
		setPoolEntryEditor((current) => {
			if (!current) return current;
			const entry = { ...current.entry };
			if (key === "label") entry.label = value;
			else if (key === "profile") entry.profile = value;
			else if (key === "default") {
				if (value === "default") entry.default = true;
				else delete entry.default;
			}
			return {
				...current,
				entry,
				errors: { ...current.errors, [key]: undefined },
			};
		});
	};
	const submitPoolEntry = () => {
		const editor = poolEntryEditor();
		const current = draft();
		if (!editor || current?.kind !== "preset") return;
		const label = editor.entry.label.trim();
		const entries = current.pools[editor.step] ?? [];
		const nextErrors: FormErrors = {};
		if (!label) nextErrors.label = "Profile tag is required";
		else if (
			entries.some(
				(entry, index) =>
					index !== editor.index && entry.label.trim() === label,
			)
		)
			nextErrors.label = "This tag already exists in the pool";
		if (!editor.entry.profile) nextErrors.profile = "Choose a profile";
		if (Object.keys(nextErrors).length) {
			const index = nextErrors.label ? 0 : 1;
			setPoolEntryEditor((value) =>
				value
					? {
							...value,
							errors: nextErrors,
							fieldIndex: index,
							focusedPane: "value",
							editing: false,
						}
					: value,
			);
			return;
		}
		const updatedEntry = { ...editor.entry, label };
		const updated = [...entries];
		if (editor.index === undefined) updated.push(updatedEntry);
		else updated[editor.index] = updatedEntry;
		setDraft({
			...current,
			pools: { ...current.pools, [editor.step]: updated },
		});
		setPoolIndex(editor.index ?? updated.length - 1);
		setPoolEntryEditor(undefined);
		setView("pool-list");
	};
	const movePoolEntryField = (delta: number) => {
		const editor = poolEntryEditor();
		if (!editor) return;
		const fields = poolEntryFields();
		const nextIndex = Math.max(
			0,
			Math.min(fields.length - 1, editor.fieldIndex + delta),
		);
		const nextField = fields[nextIndex];
		const value = nextField ? (poolEntryValues()[nextField.key] ?? "") : "";
		setPoolEntryEditor((current) =>
			current
				? {
						...current,
						fieldIndex: nextIndex,
						focusedPane: "value",
						choiceCursorIndex:
							nextField?.kind === "select"
								? Math.max(0, (nextField.options ?? []).indexOf(value))
								: 0,
					}
				: current,
		);
	};
	const movePoolEntryChoice = (delta: number) => {
		const editor = poolEntryEditor();
		const focused = poolEntryField();
		const options = focused?.options ?? [];
		if (!editor || focused?.kind !== "select" || options.length === 0) return;
		setPoolEntryEditor((current) =>
			current
				? {
						...current,
						choiceCursorIndex:
							(editor.choiceCursorIndex + delta + options.length) %
							options.length,
					}
				: current,
		);
	};
	const commitPoolEntryChoice = () => {
		const editor = poolEntryEditor();
		const focused = poolEntryField();
		if (!editor || focused?.kind !== "select") return;
		const option = focused.options?.[editor.choiceCursorIndex];
		if (option !== undefined) editPoolEntryValue(focused.key, option);
	};
	const clearPoolEntryChoice = () => {
		const focused = poolEntryField();
		if (focused?.kind !== "select") return;
		const emptyIndex = focused.options?.indexOf("") ?? -1;
		if (emptyIndex >= 0)
			setPoolEntryEditor((current) =>
				current ? { ...current, choiceCursorIndex: emptyIndex } : current,
			);
		editPoolEntryValue(focused.key, "");
	};
	const handlePoolList = (event: KeyEvent, key: string): boolean => {
		const current = draft();
		const step = poolStep();
		if (current?.kind !== "preset" || !step) return false;
		const entries = current.pools[step] ?? [];
		if (key === "escape") {
			setView("form");
			return true;
		}
		if (key === "+" || key === "=") {
			openPoolEntry();
			return true;
		}
		if (key === "d") {
			if (entries[poolIndex()]) {
				const updated = entries.filter((_, index) => index !== poolIndex());
				const pools = { ...current.pools };
				if (updated.length) pools[step] = updated;
				else delete pools[step];
				setDraft({ ...current, pools });
				setPoolIndex(Math.max(0, Math.min(poolIndex(), updated.length - 1)));
			}
			return true;
		}
		if ((key === "up" || key === "down") && event.shift) {
			const delta = key === "up" ? -1 : 1;
			setDraft(movePoolEntry(current, step, poolIndex(), delta));
			setPoolIndex((index) =>
				Math.max(0, Math.min(index + delta, entries.length - 1)),
			);
			return true;
		}
		if (key === "j" || key === "down")
			setPoolIndex((index) =>
				Math.min(index + 1, Math.max(0, entries.length - 1)),
			);
		else if (key === "k" || key === "up")
			setPoolIndex((index) => Math.max(index - 1, 0));
		else if (key === "enter" || key === "return") openPoolEntry(poolIndex());
		else return false;
		return true;
	};
	const handlePoolEntry = (event: KeyEvent, key: string): boolean => {
		const focused = poolEntryField();
		if (!focused) return false;
		if (event.ctrl || event.meta || event.option) return false;
		const editor = poolEntryEditor();
		if (!editor) return false;
		if (key === "escape") {
			if (editor.editing) {
				setPoolEntryEditor({ ...editor, editing: false });
				return true;
			}
			setPoolEntryEditor(undefined);
			setView("pool-list");
			return true;
		}
		if (key === "tab") {
			movePoolEntryField(event.shift ? -1 : 1);
			return true;
		}
		if (key === "enter" || key === "return") {
			submitPoolEntry();
			return true;
		}
		if (editor.editing) {
			if (focused.kind === "text") {
				if (key === "backspace" || key === "delete")
					editPoolEntryValue(
						focused.key,
						(poolEntryValues()[focused.key] ?? "").slice(0, -1),
					);
				else if (event.sequence?.length === 1 && event.sequence >= " ")
					editPoolEntryValue(
						focused.key,
						(poolEntryValues()[focused.key] ?? "") + event.sequence,
					);
			}
			return true;
		}
		if (key === "e" && focused.kind === "text") {
			setPoolEntryEditor({ ...editor, focusedPane: "value", editing: true });
			return true;
		}
		if (editor.focusedPane === "field") {
			if (key === "j" || key === "down") movePoolEntryField(1);
			else if (key === "k" || key === "up") movePoolEntryField(-1);
			else if (key === "l" || key === "right")
				setPoolEntryEditor({ ...editor, focusedPane: "value" });
			else if (key === "h" || key === "left") return true;
			else return false;
			return true;
		}
		if (focused.kind === "text") {
			if (key === "h" || key === "left")
				setPoolEntryEditor({ ...editor, focusedPane: "field" });
			else if (key === "j" || key === "down") movePoolEntryField(1);
			else if (key === "k" || key === "up") movePoolEntryField(-1);
			else return false;
			return true;
		}
		if (key === "h" || key === "left")
			setPoolEntryEditor({ ...editor, focusedPane: "field" });
		else if (key === "j" || key === "down") movePoolEntryChoice(1);
		else if (key === "k" || key === "up") movePoolEntryChoice(-1);
		else if (key === "space") commitPoolEntryChoice();
		else if (key === "x") clearPoolEntryChoice();
		else return false;
		return true;
	};

	/** Refuse writes while another config file also defines [agents]: entries
	 * living only there cannot be removed via this target and would resurrect
	 * at load time. */
	const refuseOnConflict = (): boolean => {
		const entry = agentConfigEntry(props.repository);
		if (entry.error) {
			notify(`Configuration could not be read: ${entry.error}`, "error");
			return true;
		}
		const conflicts = entry.conflicts ?? [];
		if (!conflicts.length) return false;
		notify(
			`Not saved: [agents] is also defined in ${conflicts.join(", ")}; remove it there first so dashboard edits are not shadowed`,
			"error",
		);
		return true;
	};

	/** Apply an agent-config mutation through the typed client when a transport is
	 * configured; the demo/test path applies it in-process. */
	const commitAgents = (mutation: AgentsMutation, onDone: () => void): void => {
		if (gatewayOrUndefined()) {
			void saveAgentConfig({
				repository: props.repository,
				expectedRevision: editorRevision(),
				mutation,
			})
				.then(() => refreshAgentConfig(props.repository))
				.then(onDone)
				.catch((error: unknown) => {
					notify(
						error instanceof Error ? error.message : String(error),
						"error",
					);
					reload();
				});
			return;
		}
		applyAgentsMutation(mutation, props.repository, editorRevision());
		reloadAgentConfigLocal(props.repository);
		onDone();
	};

	const submit = () => {
		const current = draft();
		if (!current) return;
		setEditing(false);
		const names = current.kind === "profile" ? profileNames() : presetNames();
		const nextErrors = validateDraft(current, names);
		setErrors(nextErrors);
		if (Object.keys(nextErrors).some((key) => nextErrors[key])) {
			setFieldIndex(firstErrorField(fields(), nextErrors));
			setFocusedPane("value");
			return;
		}
		// Renaming a referenced profile would leave a dangling reference and make
		// the whole agents config unparseable, so refuse it like a delete.
		const trimmed = current.name.trim();
		if (
			current.kind === "profile" &&
			current.originalName &&
			current.originalName !== trimmed
		) {
			const refs = profileReferences(
				agents() ?? { profiles: {} },
				current.originalName,
			);
			if (refs.length) {
				setError("name", `Cannot rename: referenced by ${refs.join(", ")}`);
				setFieldIndex(0);
				return;
			}
		}
		if (refuseOnConflict()) return;
		const done = () => {
			reload();
			notify(
				`${current.kind === "profile" ? "Profile" : "Preset"} ${current.name.trim()} saved`,
				"success",
			);
			setDraft(undefined);
			setErrors({});
			setView("list");
		};
		try {
			commitAgents(
				current.kind === "profile"
					? profileMutation(current)
					: presetMutation(current),
				done,
			);
		} catch (error) {
			notify(error instanceof Error ? error.message : String(error), "error");
		}
	};

	const requestDelete = () => {
		const name = listItems()[listIndex()];
		if (!name) return;
		if (listKind() === "presets" && name === BUILTIN_PRESET_NAME) {
			notify(
				"The use-default-model preset is built in and cannot be deleted",
				"error",
			);
			return;
		}
		setPendingDelete({ kind: listKind(), name });
	};
	const confirmDelete = () => {
		const confirm = pendingDelete();
		setPendingDelete(undefined);
		if (!confirm) return;
		if (confirm.kind === "profiles") {
			const current = agents();
			if (!current) return;
			const refs = profileReferences(current, confirm.name);
			if (refs.length) {
				notify(
					`Cannot delete ${confirm.name}: referenced by ${refs.join(", ")}`,
					"error",
				);
				return;
			}
		}
		if (refuseOnConflict()) return;
		try {
			commitAgents(
				confirm.kind === "profiles"
					? { kind: "delete-profile", name: confirm.name }
					: { kind: "delete-preset", name: confirm.name },
				() => {
					reload();
					notify(
						`${confirm.kind === "profiles" ? "Profile" : "Preset"} ${confirm.name} deleted`,
						"success",
					);
				},
			);
		} catch (error) {
			notify(error instanceof Error ? error.message : String(error), "error");
		}
	};

	// Returns false for keys the surface does not use so the shell keeps owning
	// global shortcuts (Ctrl+P, Ctrl+O/I, `q`, `T`, `?`) outside text entry.
	const handler = (event: KeyEvent): boolean => {
		const key = event.name.toLowerCase();
		if (pendingDelete()) {
			if (key === "y" || key === "enter" || key === "return") {
				confirmDelete();
				return true;
			}
			if (key === "escape" || key === "n") {
				setPendingDelete(undefined);
				return true;
			}
			return false;
		}
		if (view() === "menu") {
			const entries = menuEntries();
			if (key === "j" || key === "down")
				setMenuIndex((index) =>
					Math.min(index + 1, Math.max(0, entries.length - 1)),
				);
			else if (key === "k" || key === "up")
				setMenuIndex((index) => Math.max(index - 1, 0));
			else if (key === "enter" || key === "return") {
				const entry = entries[menuIndex()];
				if (entry?.list) {
					setListKind(entry.list);
					setListIndex(0);
					setView("list");
					if (
						entry.list === "presets" &&
						agents() !== undefined &&
						presetNames().length === 0
					)
						showErrorModal(
							"No custom presets",
							"Recreate them as model pools in Settings → Presets.",
						);
				} else if (entry?.item) props.onActivate?.(entry.item);
			} else return false;
			return true;
		}
		if (view() === "list") {
			const items = listItems();
			if (key === "escape") {
				setView("menu");
				return true;
			}
			if (key === "+" || key === "=") {
				openCreate();
				return true;
			}
			if (key === "d") {
				requestDelete();
				return true;
			}
			if (key === "j" || key === "down")
				setListIndex((index) =>
					Math.min(index + 1, Math.max(0, items.length - 1)),
				);
			else if (key === "k" || key === "up")
				setListIndex((index) => Math.max(index - 1, 0));
			else if (key === "enter" || key === "return") openSelected();
			else return false;
			return true;
		}
		if (view() === "pool-list") return handlePoolList(event, key);
		if (view() === "pool-entry") return handlePoolEntry(event, key);
		// form
		const focused = field();
		if (!focused) return false;
		if (event.ctrl || event.meta || event.option) return false;
		if (key === "escape") {
			if (editing()) {
				setEditing(false);
				return true;
			}
			setDraft(undefined);
			setErrors({});
			setView("list");
			return true;
		}
		if (key === "tab") {
			setEditing(false);
			moveField(event.shift ? -1 : 1);
			setFocusedPane("value");
			return true;
		}
		if (focused.kind === "action" && (key === "y" || key === "p")) {
			const step = poolStepForField(focused.key);
			if (step) {
				if (key === "y") copyPool(step);
				else pastePool(step);
			}
			return true;
		}
		if (key === "enter" || key === "return") {
			if (focused.kind === "action") {
				const step = poolStepForField(focused.key);
				if (step) openPoolManager(step);
			} else {
				// Always validate and save the full draft; Enter never advances fields.
				submit();
			}
			return true;
		}
		if (editing()) {
			if (focused.kind === "text") {
				if (key === "backspace" || key === "delete") {
					editDraft(focused.key, (values()[focused.key] ?? "").slice(0, -1));
					return true;
				}
				if (event.sequence?.length === 1 && event.sequence >= " ") {
					editDraft(
						focused.key,
						(values()[focused.key] ?? "") + event.sequence,
					);
					return true;
				}
			}
			return true;
		}
		if (key === "e" && focused.kind === "text") {
			setFocusedPane("value");
			setEditing(true);
			return true;
		}
		if (focusedPane() === "field") {
			if (key === "j" || key === "down") moveField(1);
			else if (key === "k" || key === "up") moveField(-1);
			else if (key === "l" || key === "right") setFocusedPane("value");
			else if (key === "h" || key === "left") return true;
			else return false;
			return true;
		}
		if (focused.kind === "text") {
			if (key === "h" || key === "left") setFocusedPane("field");
			else if (key === "j" || key === "down") moveField(1);
			else if (key === "k" || key === "up") moveField(-1);
			else return false;
			return true;
		}
		if (focused.kind === "action") {
			if (key === "h" || key === "left") setFocusedPane("field");
			else if (key === "j" || key === "down") moveField(1);
			else if (key === "k" || key === "up") moveField(-1);
			else return false;
			return true;
		}
		// Match FilterModal: h/l focuses panes, j/k moves within the focused pane.
		if (key === "h" || key === "left") setFocusedPane("field");
		else if (key === "j" || key === "down") moveChoiceCursor(1);
		else if (key === "k" || key === "up") moveChoiceCursor(-1);
		else if (key === "space") commitChoice();
		else if (key === "x") clearChoice();
		else return false;
		return true;
	};

	// The active footer/`?` catalog follows the sub-view; the shell skips the
	// agents section so this is the one writer while it is mounted.
	createEffect(() =>
		setActiveKeybindCatalog(
			catalogFor(view(), view() === "form" && field()?.kind === "action"),
		),
	);

	// A delete or a scope switch can shorten either list under the cursor; re-clamp
	// both so Enter and `d` keep acting on a real row instead of silently doing
	// nothing.
	createEffect(() => {
		const listMax = Math.max(0, listItems().length - 1);
		if (listIndex() > listMax) setListIndex(listMax);
		const menuMax = Math.max(0, menuEntries().length - 1);
		if (menuIndex() > menuMax) setMenuIndex(menuMax);
		const poolMax = Math.max(0, poolEntries().length - 1);
		if (poolIndex() > poolMax) setPoolIndex(poolMax);
	});

	// Route library warnings/errors emitted while the surface is open to OTEL and
	// a warning toast instead of the TUI console overlay.
	let reportingConsoleIssue = false;
	const reportConsoleIssue = (issue: ConsoleIssue): void => {
		if (reportingConsoleIssue) return;
		reportingConsoleIssue = true;
		try {
			const leak = /leak|not be disposed|disposed/i.test(issue.message);
			traceTui(
				"tui.agent_presets.console",
				{
					surface: "agent-presets",
					action: `console-${issue.level}`,
					kind: leak ? "leak" : issue.level,
				},
				issue.level === "error" ? "error" : "ok",
			);
			notify(
				issue.message
					? `Agent configuration: ${issue.message}`
					: "Agent configuration warning",
				"warning",
			);
		} finally {
			reportingConsoleIssue = false;
		}
	};
	let disposeConsoleCapture: (() => void) | undefined;
	let disposeLayer: (() => void) | undefined;
	onMount(() => {
		disposeConsoleCapture = captureConsoleIssues(reportConsoleIssue);
		void refreshAgentConfig(props.repository).then(() =>
			setVersion((value) => value + 1),
		);
		if (props.keymap) {
			disposeLayer = props.keymap.registerLayer({
				name: "settings-agent-presets",
				priority: 1000,
				commands: [
					{
						name: "settings-agent-presets.handle",
						run: ({ event }) => handler(event),
					},
				],
				bindings: SURFACE_KEYS.map((key) => ({
					key,
					cmd: "settings-agent-presets.handle",
					preventDefault: false,
				})),
			});
		}
	});
	onCleanup(() => {
		disposeConsoleCapture?.();
		disposeConsoleCapture = undefined;
		disposeLayer?.();
		disposeLayer = undefined;
	});

	return (
		<box
			backgroundColor={uiColors.bgBase}
			style={{ width: "100%", height: "100%", flexDirection: "column" }}
		>
			<Show when={pendingDelete()}>
				{(confirm) => (
					<GenericModal
						title={`Delete ${confirm().kind === "profiles" ? "profile" : "preset"}?`}
						fieldLabel={confirm().name}
						helpSections={false}
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
				<ScrollableList
					items={menuEntries()}
					selectedIndex={menuIndex()}
					availableLines={contentLines()}
					estimatedItemHeight={3}
					showScrollIndicator={false}
					renderItem={(entry, selected) => (
						<Card
							height={3}
							selected={selected()}
							title={entry.label}
							cells={[<text fg={uiColors.textMuted}>{entry.detail}</text>]}
						/>
					)}
				/>
			</Show>
			<Show when={view() === "list"}>
				<Show
					when={listItems().length > 0}
					fallback={
						<box style={{ flexGrow: 1, justifyContent: "center" }}>
							<text fg={uiColors.textMuted}>
								{listKind() === "profiles"
									? "No model profiles configured"
									: "No presets configured"}
							</text>
						</box>
					}
				>
					<ScrollableList
						items={listItems()}
						selectedIndex={listIndex()}
						availableLines={contentLines()}
						estimatedItemHeight={3}
						showScrollIndicator={false}
						renderItem={(name, selected) => {
							const preset = () => agents()?.presets?.[name];
							const profile = () => agents()?.profiles?.[name];
							const builtIn = name === BUILTIN_PRESET_NAME;
							return (
								<Card
									height={3}
									selected={selected()}
									title={builtIn ? `${name} (built-in)` : name}
									cells={[
										<text fg={uiColors.textMuted}>
											{listKind() === "profiles"
												? [profile()?.runtime, profile()?.model]
														.filter(Boolean)
														.join(" · ") || "runtime pi"
												: `${Object.keys(preset()?.pools ?? {}).length} pools`}
										</text>,
									]}
								/>
							);
						}}
					/>
				</Show>
			</Show>
			<Show when={view() === "pool-list"}>
				<box
					style={{
						width: "100%",
						height: "100%",
						minHeight: 0,
						flexDirection: "column",
					}}
				>
					<text fg={uiColors.textPrimary}>Pool {poolStep()} entries</text>
					<Show
						when={poolEntries().length > 0}
						fallback={
							<box style={{ flexGrow: 1, justifyContent: "center" }}>
								<text fg={uiColors.textMuted}>No profile tags configured</text>
							</box>
						}
					>
						<ScrollableList
							items={poolEntries()}
							selectedIndex={poolIndex()}
							availableLines={contentLines() - 1}
							estimatedItemHeight={3}
							showScrollIndicator={false}
							renderItem={(entry, selected) => (
								<Card
									height={3}
									selected={selected()}
									title={entry.label}
									cells={[
										<text fg={uiColors.textMuted}>
											{entry.profile}
											{entry.default ? " · default" : ""}
										</text>,
									]}
								/>
							)}
						/>
					</Show>
				</box>
			</Show>
			<Show when={view() === "pool-entry" && poolEntryEditor()}>
				<box style={{ width: "100%", flexGrow: 1, minHeight: 0 }}>
					<Form
						fields={poolEntryFields()}
						values={poolEntryValues()}
						errors={poolEntryEditor()?.errors}
						activeIndex={poolEntryEditor()?.fieldIndex ?? 0}
						focusedPane={poolEntryEditor()?.focusedPane}
						choiceCursorIndex={poolEntryEditor()?.choiceCursorIndex}
						editing={poolEntryEditor()?.editing}
						availableLines={contentLines() - 1}
						header={`Pool entry · ${poolEntryEditor()?.step}`}
					/>
				</box>
			</Show>
			<Show when={view() === "form" && draft()}>
				<box style={{ width: "100%", flexGrow: 1, minHeight: 0 }}>
					<Form
						fields={fields()}
						values={values()}
						errors={errors()}
						activeIndex={fieldIndex()}
						focusedPane={focusedPane()}
						choiceCursorIndex={choiceCursorIndex()}
						editing={editing()}
						availableLines={contentLines() - 1}
						header={
							draft()?.kind === "profile"
								? "Model profile"
								: "Configuration preset"
						}
					/>
				</box>
			</Show>
		</box>
	);
}

/** Footer/`?` catalog for one sub-view. */
export function catalogFor(
	view: View,
	poolFieldFocused = false,
): KeybindSection[] {
	if (view === "menu")
		return [
			{
				title: "Agent Presets",
				keybinds: [
					{ key: "j/k or ↑/↓", action: "select option", standard: true },
					{ key: "Enter", action: "open", standard: true },
					{
						key: "Esc",
						action: "parent page",
						short: "parent",
						standard: true,
					},
				],
			},
		];
	if (view === "list")
		return [
			{
				title: "Agent Presets",
				keybinds: [
					{ key: "j/k or ↑/↓", action: "select entry", standard: true },
					{ key: "Enter", action: "edit entry", short: "edit" },
					{ key: "+", action: "add entry", short: "add" },
					{ key: "d", action: "delete entry", short: "delete" },
					{ key: "Esc", action: "back", short: "back", standard: true },
				],
			},
		];
	if (view === "pool-list")
		return [
			{
				title: "Model pool entries",
				keybinds: [
					{ key: "j/k or ↑/↓", action: "select entry", standard: true },
					{ key: "Enter", action: "edit entry", short: "edit" },
					{ key: "+", action: "add entry", short: "add" },
					{ key: "d", action: "delete entry", short: "delete" },
					{ key: "Shift+↑/↓", action: "move entry", short: "move" },
					{
						key: "Esc",
						action: "back to preset",
						short: "back",
						standard: true,
					},
				],
			},
		];
	if (view === "pool-entry")
		return [
			{
				title: "Pool entry form",
				keybinds: [
					{ key: "h/l", action: "focus fields/value", standard: true },
					{ key: "j/k or ↑/↓", action: "move fields/choices", standard: true },
					{
						key: "Space",
						action: "select highlighted choice",
						short: "select",
					},
					{ key: "e", action: "edit text field", short: "edit" },
					{ key: "Tab", action: "next field", short: "next", standard: true },
					{ key: "Backspace", action: "delete character", short: "delete" },
					{ key: "x", action: "clear choice", short: "clear" },
					{ key: "Enter", action: "save pool entry", short: "save" },
					{
						key: "Esc",
						action: "finish editing / cancel",
						short: "done",
						standard: true,
					},
				],
			},
		];
	return [
		{
			title: "Agent form",
			keybinds: [
				{ key: "h/l", action: "focus fields/value", standard: true },
				{ key: "j/k or ↑/↓", action: "move fields/choices", standard: true },
				{ key: "Space", action: "select highlighted choice", short: "select" },
				{ key: "e", action: "edit text field", short: "edit" },
				{ key: "Tab", action: "next field", short: "next", standard: true },
				{ key: "Backspace", action: "delete character", short: "delete" },
				{ key: "x", action: "clear choice", short: "clear" },
				...(poolFieldFocused
					? [
							{ key: "y", action: "copy pool", short: "copy" },
							{ key: "p", action: "paste pool", short: "paste" },
						]
					: []),
				{
					key: "Enter",
					action: poolFieldFocused
						? "manage pool entries"
						: "validate and save",
					short: poolFieldFocused ? "manage" : "save",
				},
				{
					key: "Esc",
					action: "finish editing / cancel",
					short: "done",
					standard: true,
				},
			],
		},
	];
}
