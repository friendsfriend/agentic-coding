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
	type Keybind,
	type KeybindSection,
	LAYOUT_CHROME_LINES,
	ScrollableList,
	setActiveKeybindCatalog,
	showErrorModal,
	uiColors,
	useTerminalDimensions,
} from "@ui";
import { createEffect, createSignal, onCleanup, onMount, Show } from "solid-js";
import type {
	ClassifierProviderOption,
	ClassifierStatusResponse,
} from "../../contracts/gateway.ts";
import {
	CLASSIFIER_PROVIDER_SPECS,
	classifierProviderSpec,
	DEFAULT_CLASSIFIER_PROVIDER,
	LAYA_LOCAL_PROVIDER,
} from "../../workflow/classifier-providers.ts";
import {
	DEFAULT_ORCHESTRATOR_MONITOR,
	ORCHESTRATOR_MONITOR_MODES,
} from "../../workflow/profiles.ts";
import {
	agentConfigEntry,
	refreshAgentConfig,
	reloadAgentConfigLocal,
} from "../dash/agent-config-cache.ts";
import {
	cancelClassifierInstallJob,
	clearClassifierError,
	lastClassifierError,
	refreshClassifierStatus,
	startClassifierInstall,
} from "../dash/classifier-status.ts";
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
	durableModels as loadDurableModels,
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
import { orchestratorLabel, type SettingsItem } from "./items.ts";

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
	/** Classifier provider selection plus local-model status, when a snapshot
	 * has been read. The picker falls back to the built-in catalog. */
	classifier?: ClassifierStatusResponse;
}

type View =
	| "menu"
	| "list"
	| "form"
	| "pool-entry"
	| "classifier"
	| "orchestrator";

/** The thinking levels a durable session accepts (`DurableHost.THINKING_LEVELS`). */
const ORCHESTRATOR_THINKING_LEVELS = [
	"off",
	"minimal",
	"low",
	"medium",
	"high",
	"xhigh",
	"max",
] as const;
/** The first row of each orchestrator picker: leave the field unset. */
const HOST_DEFAULT = "(host default)";

/** One row of the Agent Presets menu. */
interface MenuEntry {
	id: string;
	label: string;
	detail: string;
	/** Set on the two navigation options. */
	list?: AgentListKind;
	/** Set on the classifier-provider navigation option. */
	view?: View;
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
	// The models a `pi-durable` profile can select, resolved once from the user's
	// configured providers. Undefined while the first read is in flight (and if it
	// fails): the durable model field then stays free text rather than offering a
	// list the editor could not resolve.
	const [durableModels, setDurableModels] = createSignal<readonly string[]>();
	// The read is spawned once per mount and never re-awaited; a profile editor
	// reopened in the same session keeps the list it already has.
	let durableModelsRequested = false;
	const loadDurableModelsOnce = () => {
		if (durableModelsRequested) return;
		durableModelsRequested = true;
		void loadDurableModels()
			.then(setDurableModels)
			.catch(() => undefined);
	};
	const [editorRevision, setEditorRevision] = createSignal<string>();
	const [pendingDelete, setPendingDelete] = createSignal<{
		kind: AgentListKind;
		name: string;
	}>();
	// Classifier provider picker + the user-decided local install. The view never
	// downloads: it asks the server to install and renders the job it reads back.
	const [providerIndex, setProviderIndex] = createSignal(0);
	const [installPrompt, setInstallPrompt] = createSignal(false);
	const [installStatus, setInstallStatus] = createSignal<
		ClassifierStatusResponse | undefined
	>(props.classifier);
	// A cancel request that did not move the job out of an in-flight phase (an
	// unreachable server): the dialog stops being a progress surface so Escape can
	// still close it.
	const [cancelFailed, setCancelFailed] = createSignal(false);
	let installPoll: ReturnType<typeof setInterval> | undefined;
	// Orchestrator session picker: choose a model, a thinking level and the
	// workflow monitor mode, then save all three.
	const [orchestratorStage, setOrchestratorStage] = createSignal<
		"model" | "thinking" | "monitor"
	>("model");
	const [orchestratorIndex, setOrchestratorIndex] = createSignal(0);
	const [orchestratorModel, setOrchestratorModel] = createSignal<string>();
	const [orchestratorThinking, setOrchestratorThinking] =
		createSignal<string>();

	const stopInstallPolling = () => {
		if (installPoll === undefined) return;
		clearInterval(installPoll);
		installPoll = undefined;
	};
	onCleanup(stopInstallPolling);
	createEffect(() => {
		// A fresh server snapshot (props) is authoritative until a local install
		// read replaces it.
		const incoming = props.classifier;
		if (incoming) setInstallStatus(incoming);
	});

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
		return draftFields(current, profileNames(), durableModels());
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
	const activePoolStep = () => {
		const active = field();
		return active?.kind === "action" ? poolStepForField(active.key) : undefined;
	};
	const poolEntries = (step = poolStep()) => {
		const current = draft();
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
		// A durable profile's model choices come from the configured providers, not
		// from a runtime enumeration, so make sure that read is in flight as soon
		// as an editor could need it.
		loadDurableModelsOnce();
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
		setDraft(presetDraft(existing ?? "", agents()?.presets, agents()?.gates));
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
		const classifier = props.items?.find(
			(item) => item.id === "agents.classifier",
		);
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
		// The classifier picker is only offered when the inventory surfaced its
		// row, so the menu continues to mirror `props.items` exactly.
		if (classifier)
			options.push({
				id: "agents.classifier",
				label: classifier.label,
				detail: `${providerLabel(activeProvider())} · local model ${localStatusLine()}`,
				view: "classifier",
			});
		const orchestrator = props.items?.find(
			(item) => item.id === "agents.orchestrator",
		);
		if (orchestrator)
			options.push({
				id: "agents.orchestrator",
				label: orchestrator.label,
				detail: `${orchestratorLabel(agents()?.orchestrator)} · ${orchestrator.detail}`,
				view: "orchestrator",
			});
		const info: MenuEntry[] = (props.items ?? [])
			.filter(
				(item) =>
					item.editable &&
					item.id !== "agents.profiles" &&
					item.id !== "agents.presets" &&
					item.id !== "agents.classifier" &&
					item.id !== "agents.orchestrator",
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
		if (next?.kind === "action") setPoolIndex(0);
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
	const openPoolEntry = (step: string, index?: number) => {
		const current = draft();
		if (current?.kind !== "preset") return;
		setPoolStep(step);
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
		setErrors((currentErrors) => ({
			...currentErrors,
			[poolItemsKey(editor.step)]: undefined,
		}));
		setPoolIndex(editor.index ?? updated.length - 1);
		setPoolEntryEditor(undefined);
		setView("form");
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
			setView("form");
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
		// The classifier path never opens the profile/preset editor, so it holds no
		// editor revision; fall back to the revision the cached read captured so a
		// concurrent edit is still detected instead of silently overwritten.
		const expectedRevision =
			editorRevision() ?? agentConfigEntry(props.repository).revision;
		if (gatewayOrUndefined()) {
			void saveAgentConfig({
				repository: props.repository,
				expectedRevision,
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
		applyAgentsMutation(mutation, props.repository, expectedRevision);
		reloadAgentConfigLocal(props.repository);
		onDone();
	};

	// -- orchestrator session picker -------------------------------------------

	/** The rows of the current orchestrator picker stage. */
	const orchestratorOptions = (): string[] => {
		if (orchestratorStage() === "model")
			return [HOST_DEFAULT, ...(durableModels() ?? [])];
		if (orchestratorStage() === "thinking")
			return [HOST_DEFAULT, ...ORCHESTRATOR_THINKING_LEVELS];
		return [...ORCHESTRATOR_MONITOR_MODES];
	};
	const openOrchestratorPicker = () => {
		loadDurableModelsOnce();
		const current = agents()?.orchestrator?.model;
		setOrchestratorStage("model");
		setOrchestratorModel(undefined);
		setOrchestratorThinking(undefined);
		setOrchestratorIndex(
			Math.max(0, current ? orchestratorOptions().indexOf(current) : 0),
		);
		setView("orchestrator");
	};
	const chooseOrchestratorOption = () => {
		const choice = orchestratorOptions()[orchestratorIndex()];
		if (choice === undefined) return;
		const value = choice === HOST_DEFAULT ? undefined : choice;
		if (orchestratorStage() === "model") {
			setOrchestratorModel(value);
			setOrchestratorStage("thinking");
			const thinking = agents()?.orchestrator?.thinking;
			setOrchestratorIndex(
				Math.max(0, thinking ? orchestratorOptions().indexOf(thinking) : 0),
			);
			return;
		}
		if (orchestratorStage() === "thinking") {
			setOrchestratorThinking(value);
			setOrchestratorStage("monitor");
			const monitor = agents()?.orchestrator?.monitor;
			setOrchestratorIndex(
				Math.max(0, monitor ? orchestratorOptions().indexOf(monitor) : 0),
			);
			return;
		}
		if (refuseOnConflict()) return;
		// The default mode is `wake`, so selecting the default row leaves the key
		// out of the configuration instead of pinning a value that says nothing.
		const monitor = value === DEFAULT_ORCHESTRATOR_MONITOR ? undefined : value;
		const model = orchestratorModel();
		const thinking = orchestratorThinking();
		const next = {
			...(model ? { model } : {}),
			...(thinking ? { thinking } : {}),
			...(monitor ? { monitor } : {}),
		};
		try {
			commitAgents({ kind: "set-orchestrator", orchestrator: next }, () => {
				reload();
				notify(
					`Orchestrator session set to ${orchestratorLabel(next)}`,
					"success",
				);
				setView("menu");
			});
		} catch (error) {
			notify(error instanceof Error ? error.message : String(error), "error");
		}
	};

	// -- classifier provider picker + user-decided local install -------------

	/** The offered providers: the server snapshot when one was read, otherwise
	 * the built-in catalog. */
	const classifierOptions = (): ClassifierProviderOption[] => {
		const providers = props.classifier?.providers;
		return providers && providers.length > 0
			? [...providers]
			: CLASSIFIER_PROVIDER_SPECS.filter((spec) => spec.selectable).map(
					(spec) => ({ id: spec.id, label: spec.label }),
				);
	};
	const providerLabel = (id: string): string =>
		classifierOptions().find((option) => option.id === id)?.label ?? id;
	const statusKnown = (): boolean => installStatus() !== undefined;
	const activeProvider = (): string =>
		installStatus()?.provider ??
		props.classifier?.provider ??
		DEFAULT_CLASSIFIER_PROVIDER;
	const localStatus = () =>
		installStatus()?.local ?? { installed: false, running: false };
	const installPhase = (): string | undefined => localStatus().job?.phase;
	const installInFlight = (): boolean => {
		const phase = installPhase();
		return phase === "acquiring" || phase === "starting";
	};
	const megabytes = (bytes: number): string => `${(bytes / 1e6).toFixed(1)} MB`;
	/** Human copy for the current install job, or "" when there is nothing to
	 * report (no job, or an untouched `idle`). Never surfaces the raw enum. */
	const installPhaseCopy = (): string => {
		const job = localStatus().job;
		if (!job) return "";
		const bytes = job.receivedBytes
			? `${megabytes(job.receivedBytes)}${job.totalBytes ? ` / ${megabytes(job.totalBytes)}` : ""}`
			: job.totalBytes
				? megabytes(job.totalBytes)
				: "";
		switch (job.phase) {
			case "acquiring":
				return bytes ? `Downloading ${bytes}` : "Downloading…";
			case "starting":
				return "Starting the local model…";
			case "ready":
				return "Installed";
			case "cancelled":
				return "Install cancelled";
			case "failed":
				return job.detail ?? "Install failed";
			default:
				return "";
		}
	};
	/** One-line, non-secret local-model state shared by the menu row, the picker
	 * header and the modal. `running` and `installed (not running)` stay distinct:
	 * a stopped sidecar silently fails open, so the degraded state must be
	 * visible without running a workflow. */
	const localStatusLine = (): string => {
		if (!statusKnown()) return "checking…";
		const local = localStatus();
		if (local.running) return "running";
		if (local.installed) return "installed (not running)";
		if (installInFlight())
			return installPhaseCopy().toLowerCase() || "installing…";
		const phase = installPhase();
		if (phase === "failed") return "install failed";
		if (phase === "cancelled") return "install cancelled";
		return "not installed";
	};
	/** Where the opt-in model is stored, shortened to the last path segments so a
	 * long config root cannot crowd the dialog. */
	const localInstallLocation = (): string => {
		const modelPath = localStatus().modelPath;
		if (!modelPath) return "the app configuration directory (classifier/laya)";
		const parts = modelPath.split("/").filter(Boolean);
		return parts.length > 3 ? `…/${parts.slice(-3).join("/")}` : modelPath;
	};
	/** One-line description of an offered provider, for its Settings row. */
	const providerDetail = (id: string): string => {
		const description = classifierProviderSpec(id)?.description ?? id;
		return id === LAYA_LOCAL_PROVIDER
			? `${description} · ${localStatusLine()}`
			: description;
	};

	const persistProvider = (provider: string, done?: () => void): void => {
		if (refuseOnConflict()) return;
		try {
			commitAgents({ kind: "set-classifier", classifier: { provider } }, () => {
				reload();
				notify(
					`Classifier provider set to ${providerLabel(provider)}`,
					"success",
				);
				done?.();
			});
		} catch (error) {
			notify(error instanceof Error ? error.message : String(error), "error");
		}
	};

	/** After a successful install the sidecar is serving; persist the provider
	 * once the agents revision is re-read, so the post-install write is not
	 * refused as stale against a pre-install revision. */
	const persistLocalAfterInstall = (): void => {
		void refreshAgentConfig(props.repository)
			.catch(() => undefined)
			.then(() => {
				persistProvider(LAYA_LOCAL_PROVIDER, () => {
					setInstallPrompt(false);
					setView("menu");
				});
			});
	};

	/** Ask the server to acquire the local model; poll until it settles. */
	const beginInstallPolling = (): void => {
		stopInstallPolling();
		installPoll = setInterval(() => {
			void refreshClassifierStatus(props.repository).then((status) => {
				if (!status) return;
				setInstallStatus(status);
				if (
					status.local.job?.phase === "acquiring" ||
					status.local.job?.phase === "starting"
				)
					return;
				stopInstallPolling();
				// A ready model is switched over; a failure keeps the old provider.
				if (status.local.installed && status.local.running)
					persistLocalAfterInstall();
			});
		}, 500);
	};
	const confirmInstall = async (): Promise<void> => {
		clearClassifierError();
		const status = await startClassifierInstall(props.repository);
		setInstallStatus(status);
		const failure = lastClassifierError();
		if (failure) {
			// The POST never reached the server: report it instead of looking like a
			// no-op key press.
			clearClassifierError();
			notify(`Could not start the install: ${failure}`, "error");
			return;
		}
		setCancelFailed(false);
		beginInstallPolling();
	};
	const openInstallPrompt = (): void => {
		setInstallPrompt(true);
		setCancelFailed(false);
		stopInstallPolling();
		void refreshClassifierStatus(props.repository).then(setInstallStatus);
	};
	const cancelInstall = (): void => {
		stopInstallPolling();
		clearClassifierError();
		void cancelClassifierInstallJob(props.repository).then((status) => {
			setInstallStatus(status);
			const failure = lastClassifierError();
			const stillRunning =
				status?.local.job?.phase === "acquiring" ||
				status?.local.job?.phase === "starting";
			if (failure || stillRunning) {
				clearClassifierError();
				setCancelFailed(true);
				notify(
					`Could not cancel the install${failure ? `: ${failure}` : ""}`,
					"error",
				);
			}
		});
	};
	const closeInstallPrompt = (): void => {
		// Not now / Escape: do not persist the switch; keep the previous provider.
		setInstallPrompt(false);
		setCancelFailed(false);
		stopInstallPolling();
		void refreshClassifierStatus(props.repository).then(setInstallStatus);
	};
	const chooseProvider = (): void => {
		const option = classifierOptions()[providerIndex()];
		if (!option) return;
		const choice = providerChoice(
			option.id,
			statusKnown() && localStatus().installed,
		);
		if (choice.action === "install") {
			// Not installed: the modal decides. The switch is only persisted after a
			// successful, verified install.
			openInstallPrompt();
			return;
		}
		persistProvider(option.id, () => setView("menu"));
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
		if (installPrompt()) {
			// While acquiring, the modal is a progress surface: only cancel is
			// accepted, and Escape is the universal cancel alias. Once a cancel has
			// failed (unreachable server), Escape falls through to a plain close so
			// the dialog can never become unclosable.
			if (installInFlight() && !cancelFailed()) {
				if (key === "c" || key === "escape") cancelInstall();
				return true;
			}
			if (key === "escape" || key === "n") {
				closeInstallPrompt();
				return true;
			}
			if (localStatus().installed) {
				// Ready state: Enter switches the provider, `i` must not re-run the
				// acquisition the dialog's own copy used to imply.
				if (key === "enter" || key === "return") {
					persistProvider(LAYA_LOCAL_PROVIDER, () => {
						setInstallPrompt(false);
						setView("menu");
					});
				}
				return true;
			}
			if (key === "i" || key === "enter" || key === "return") {
				void confirmInstall();
				return true;
			}
			return true;
		}
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
		if (view() === "orchestrator") {
			const options = orchestratorOptions();
			if (key === "escape") {
				if (orchestratorStage() === "thinking") {
					setOrchestratorStage("model");
					setOrchestratorIndex(
						Math.max(0, options.indexOf(orchestratorModel() ?? HOST_DEFAULT)),
					);
				} else setView("menu");
				return true;
			}
			if (key === "j" || key === "down")
				setOrchestratorIndex((index) =>
					Math.min(index + 1, Math.max(0, options.length - 1)),
				);
			else if (key === "k" || key === "up")
				setOrchestratorIndex((index) => Math.max(index - 1, 0));
			else if (key === "enter" || key === "return") chooseOrchestratorOption();
			else return false;
			return true;
		}
		if (view() === "classifier") {
			const options = classifierOptions();
			if (key === "escape") {
				setView("menu");
				return true;
			}
			if (key === "j" || key === "down")
				setProviderIndex((index) =>
					Math.min(index + 1, Math.max(0, options.length - 1)),
				);
			else if (key === "k" || key === "up")
				setProviderIndex((index) => Math.max(index - 1, 0));
			else if (key === "i") {
				// `i` is an install affordance only for an uninstalled local model;
				// Enter already persists an installed one. Opening the install copy for
				// an installed model produced a contradictory "ready" dialog.
				if (
					options[providerIndex()]?.id === LAYA_LOCAL_PROVIDER &&
					statusKnown() &&
					!localStatus().installed
				)
					openInstallPrompt();
				else return false;
			} else if (key === "enter" || key === "return") chooseProvider();
			else return false;
			return true;
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
				} else if (entry?.view === "orchestrator") {
					openOrchestratorPicker();
				} else if (entry?.view) {
					setView(entry.view);
					if (entry.view === "classifier") {
						const options = classifierOptions();
						setProviderIndex(
							Math.max(
								0,
								options.findIndex((option) => option.id === activeProvider()),
							),
						);
						void refreshClassifierStatus(props.repository).then(
							setInstallStatus,
						);
					}
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
			// Enter always validates and saves the full draft.
			submit();
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
			const step = poolStepForField(focused.key);
			const current = draft();
			if (focusedPane() === "value" && step && current?.kind === "preset") {
				const entries = current.pools[step] ?? [];
				if (key === "e") {
					if (entries[poolIndex()]) openPoolEntry(step, poolIndex());
					return true;
				}
				if (key === "+" || key === "=") {
					openPoolEntry(step);
					return true;
				}
				if (key === "d") {
					if (entries[poolIndex()]) {
						const updated = entries.filter((_, index) => index !== poolIndex());
						const pools = { ...current.pools };
						if (updated.length) pools[step] = updated;
						else delete pools[step];
						setDraft({ ...current, pools });
						setErrors((currentErrors) => ({
							...currentErrors,
							[poolItemsKey(step)]: undefined,
						}));
						setPoolIndex(
							Math.max(0, Math.min(poolIndex(), updated.length - 1)),
						);
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
				else if (key === "h" || key === "left") setFocusedPane("field");
				else if (key === "l" || key === "right") return true;
				else return false;
				return true;
			}
			if (key === "h" || key === "left") setFocusedPane("field");
			else if (key === "l" || key === "right") setFocusedPane("value");
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

	/** Which install-dialog state is showing: the footer and the modal's `?` help
	 * are derived from this so they cannot drift from the handler. */
	const installPromptState = (): InstallPromptState => {
		if (installInFlight() && !cancelFailed()) return "cancel";
		return localStatus().installed ? "ready" : "install";
	};
	const installPromptKeys = (): readonly Keybind[] =>
		installPromptCatalog(installPromptState()).flatMap(
			(section) => section.keybinds,
		);

	// The active footer/`?` catalog follows the sub-view (or the install prompt,
	// whose keys the view's own catalog would mis-advertise); the shell skips the
	// agents section so this is the one writer while it is mounted.
	createEffect(() =>
		setActiveKeybindCatalog(
			installPrompt()
				? installPromptCatalog(installPromptState())
				: catalogFor(
						view(),
						view() === "form" && field()?.kind === "action",
						view() === "form" &&
							field()?.kind === "action" &&
							focusedPane() === "value",
					),
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
		const step = activePoolStep();
		if (step) {
			const poolMax = Math.max(0, poolEntries(step).length - 1);
			if (poolIndex() > poolMax) setPoolIndex(poolMax);
		}
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
			<Show when={installPrompt()}>
				<GenericModal
					title={
						installInFlight() && !cancelFailed()
							? "Installing local classifier"
							: localStatus().installed
								? "Local classifier ready"
								: "Install local classifier?"
					}
					helpSections={installPromptCatalog(installPromptState())}
					widthPercent={0.7}
					heightPercent={0.8}
					help={installPromptKeys()}
				>
					<box width="100%" flexDirection="column" gap={1}>
						<text
							fg={localStatus().error ? uiColors.warning : uiColors.textMuted}
						>
							Status: {installPhaseCopy() || localStatusLine()}
						</text>
						{localStatus().installed ? (
							<text fg={uiColors.textPrimary}>
								{localStatus().bytes
									? `${megabytes(localStatus().bytes ?? 0)}, Apache-2.0. `
									: "Apache-2.0. "}
								Stored under {localInstallLocation()}.
							</text>
						) : (
							<>
								<text fg={uiColors.textPrimary}>
									~324 MB, Apache-2.0. Stored under {localInstallLocation()}.
								</text>
								<text fg={uiColors.textPrimary}>
									Inference is fully offline afterwards and needs no API key.
								</text>
							</>
						)}
						<Show when={!localStatus().installed && !installInFlight()}>
							<text fg={uiColors.textMuted}>
								"Not now" keeps the current provider in effect.
							</text>
						</Show>
						<Show when={localStatus().installed}>
							<text fg={uiColors.textMuted}>
								Enter uses this provider; Esc closes.
							</text>
						</Show>
					</box>
				</GenericModal>
			</Show>
			<Show when={view() === "orchestrator"}>
				<box
					style={{
						width: "100%",
						flexGrow: 1,
						minHeight: 0,
						flexDirection: "column",
					}}
				>
					<box style={{ width: "100%", paddingLeft: 1, paddingBottom: 1 }}>
						<text fg={uiColors.textMuted}>
							{orchestratorStage() === "model"
								? durableModels() === undefined
									? "Orchestrator model · reading configured providers…"
									: "Orchestrator model"
								: orchestratorStage() === "thinking"
									? `Thinking level for ${orchestratorModel() ?? "the host default model"}`
									: "Workflow monitor: wake the session, notify only, or observe nothing"}
						</text>
					</box>
					<ScrollableList
						items={orchestratorOptions()}
						selectedIndex={orchestratorIndex()}
						availableLines={Math.max(1, contentLines() - 3)}
						estimatedItemHeight={1}
						showScrollIndicator={false}
						renderItem={(option, selected) => {
							const current = () => {
								const configured = agents()?.orchestrator;
								if (orchestratorStage() === "model") return configured?.model;
								if (orchestratorStage() === "thinking")
									return configured?.thinking;
								return configured?.monitor;
							};
							const active = () => {
								const fallback =
									orchestratorStage() === "monitor"
										? DEFAULT_ORCHESTRATOR_MONITOR
										: HOST_DEFAULT;
								return (current() ?? fallback) === option ? "(active) " : "";
							};
							return (
								<box style={{ height: 1, paddingLeft: 1 }}>
									<text
										fg={selected() ? uiColors.accent : uiColors.textPrimary}
									>
										{`${selected() ? "› " : "  "}${active()}${option}`}
									</text>
								</box>
							);
						}}
					/>
				</box>
			</Show>
			<Show when={view() === "classifier"}>
				<box
					style={{
						width: "100%",
						flexGrow: 1,
						minHeight: 0,
						flexDirection: "column",
					}}
				>
					<box style={{ width: "100%", paddingLeft: 1, paddingBottom: 1 }}>
						<text fg={uiColors.textMuted}>Local model {localStatusLine()}</text>
					</box>
					<ScrollableList
						items={classifierOptions()}
						selectedIndex={providerIndex()}
						availableLines={Math.max(1, contentLines() - 3)}
						estimatedItemHeight={3}
						showScrollIndicator={false}
						renderItem={(option, selected) => (
							<Card
								height={3}
								selected={selected()}
								title={`${option.id === activeProvider() ? "(active) " : ""}${option.label}`}
								cells={[
									<text fg={uiColors.textMuted}>
										{providerDetail(option.id)}
									</text>,
								]}
							/>
						)}
					/>
				</box>
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
						actionContent={
							<Show when={activePoolStep()}>
								{(step) => (
									<box
										style={{
											width: "100%",
											flexGrow: 1,
											minHeight: 0,
											flexDirection: "column",
											gap: 1,
										}}
									>
										<text fg={uiColors.textPrimary}>Pool {step()} entries</text>
										<Show
											when={poolEntries(step()).length > 0}
											fallback={
												<text fg={uiColors.textMuted}>
													No profile tags configured
												</text>
											}
										>
											<ScrollableList
												items={poolEntries(step())}
												selectedIndex={poolIndex()}
												availableLines={Math.max(1, contentLines() - 4)}
												estimatedItemHeight={3}
												showScrollIndicator={false}
												renderItem={(entry, selected) => (
													<Card
														height={3}
														selected={selected() && focusedPane() === "value"}
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
								)}
							</Show>
						}
					/>
				</box>
			</Show>
		</box>
	);
}

/** What selecting a provider must do. A hosted provider (or an installed
 * local one) is persisted; an uninstalled local provider may only open the
 * install modal, because a switch without a model would be a broken endpoint.
 * Pure and exported so the decision is testable without a terminal. */
export function providerChoice(
	providerId: string,
	installed: boolean,
): { action: "persist" | "install" } {
	return providerId === LAYA_LOCAL_PROVIDER && !installed
		? { action: "install" }
		: { action: "persist" };
}

/** Which state the install dialog is in. The modal help and the shell footer
 * are both derived from it, so the two can never advertise different keys. */
export type InstallPromptState = "install" | "cancel" | "ready";

/** Footer/`?` catalog for the install modal for one state. Exported so the modal
 * and the active catalog cannot drift. */
export function installPromptCatalog(
	state: InstallPromptState = "install",
): KeybindSection[] {
	const keybinds: Keybind[] =
		state === "cancel"
			? [{ key: "c/Esc", action: "cancel install", short: "cancel" }]
			: state === "ready"
				? [
						{ key: "Enter", action: "use this provider", short: "use" },
						{
							key: "Esc/n",
							action: "close",
							short: "close",
							standard: true,
						},
					]
				: [
						{ key: "i/Enter", action: "install", short: "install" },
						{ key: "Esc/n", action: "not now", short: "not now" },
					];
	return [{ title: "Local classifier", keybinds }];
}

/** Footer/`?` catalog for one sub-view. */
export function catalogFor(
	view: View,
	poolFieldFocused = false,
	poolListFocused = false,
): KeybindSection[] {
	if (view === "orchestrator")
		return [
			{
				title: "Orchestrator session",
				keybinds: [
					{ key: "j/k or ↑/↓", action: "select", standard: true },
					{
						key: "Enter",
						action: "choose model, thinking level and monitor mode (saves)",
						short: "select",
					},
					{ key: "Esc", action: "back", short: "back", standard: true },
				],
			},
		];
	if (view === "classifier")
		return [
			{
				title: "Classifier provider",
				keybinds: [
					{ key: "j/k or ↑/↓", action: "select provider", standard: true },
					{ key: "i", action: "install local model", short: "install" },
					{ key: "Enter", action: "use provider", short: "select" },
					{ key: "Esc", action: "back", short: "back", standard: true },
				],
			},
		];
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
				{
					key: "j/k or ↑/↓",
					action: poolListFocused ? "select pool entry" : "move fields/choices",
					standard: true,
				},
				...(poolFieldFocused
					? [
							...(poolListFocused
								? [
										{ key: "e", action: "edit pool entry", short: "edit" },
										{ key: "+", action: "add pool entry", short: "add" },
										{ key: "d", action: "delete pool entry", short: "delete" },
										{
											key: "Shift+↑/↓",
											action: "move pool entry",
											short: "move",
										},
									]
								: []),
							{ key: "y", action: "copy pool", short: "copy" },
							{ key: "p", action: "paste pool", short: "paste" },
						]
					: [
							{
								key: "Space",
								action: "select highlighted choice",
								short: "select",
							},
							{ key: "e", action: "edit text field", short: "edit" },
							{ key: "x", action: "clear choice", short: "clear" },
						]),
				{ key: "Tab", action: "next field", short: "next", standard: true },
				{ key: "Backspace", action: "delete character", short: "delete" },
				{ key: "Enter", action: "validate and save", short: "save" },
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
