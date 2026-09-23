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
	type FormValues,
	firstErrorField,
	formStepOption,
	formValues,
	GenericModal,
	hostChromeLines,
	type KeybindSection,
	LAYOUT_CHROME_LINES,
	ScrollableList,
	setActiveKeybindCatalog,
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
	"left",
	"right",
	"home",
	"end",
	"ctrl+s",
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
	/** Inventoried section items: the two menu options plus the read-only
	 * scope/routing rows the section is required to surface. */
	items?: readonly SettingsItem[];
	/** Activate an informational row (e.g. reset to user scope). */
	onActivate?: (item: SettingsItem) => void;
}

type View = "menu" | "list" | "form";

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

	const openProfileEditor = (existing?: string) => {
		const current = existing ? agents()?.profiles[existing] : undefined;
		clearModelCache();
		setDraft(profileDraft(existing ?? "", current));
		setEditorRevision(agentConfigEntry(props.repository).revision);
		setFieldIndex(0);
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
		setEditorRevision(agentConfigEntry(props.repository).revision);
		setFieldIndex(0);
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

	// The two editable options lead the menu; every inventoried informational
	// row (scope, project checkout, reset-to-user-scope, inactive legacy config,
	// conflicts, routing) follows so it stays surfaced and its action reachable.
	const menuEntries = (): MenuEntry[] => {
		const options: MenuEntry[] = [
			{
				id: "agents.profiles",
				label: "Model profiles",
				detail: `${profileNames().length} profiles · runtime, model, thinking`,
				list: "profiles",
			},
			{
				id: "agents.presets",
				label: "Presets",
				detail: `${presetNames().length} presets · step and role routing`,
				list: "presets",
			},
		];
		const info: MenuEntry[] = (props.items ?? [])
			.filter(
				(item) => item.id !== "agents.profiles" && item.id !== "agents.presets",
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
	const moveField = (delta: number) =>
		setFieldIndex((index) =>
			Math.max(0, Math.min(fields().length - 1, index + delta)),
		);
	const cycleField = (delta: number) => {
		const current = draft();
		const focused = field();
		if (!current || !focused || focused.kind !== "select") return;
		editDraft(
			focused.key,
			formStepOption(focused, values()[focused.key] ?? "", delta),
		);
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
		const names = current.kind === "profile" ? profileNames() : presetNames();
		const nextErrors = validateDraft(current, names);
		setErrors(nextErrors);
		if (Object.keys(nextErrors).some((key) => nextErrors[key])) {
			setFieldIndex(firstErrorField(fields(), nextErrors));
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
		// form
		const focused = field();
		if (!focused) return false;
		if (event.ctrl && key === "s") {
			submit();
			return true;
		}
		if (event.ctrl || event.meta || event.option) return false;
		if (key === "escape") {
			setDraft(undefined);
			setErrors({});
			setView("list");
			return true;
		}
		if (key === "tab") {
			moveField(event.shift ? -1 : 1);
			return true;
		}
		if (focused.kind === "text") {
			if (key === "backspace" || key === "delete") {
				const current = values()[focused.key] ?? "";
				editDraft(focused.key, current.slice(0, -1));
				return true;
			}
			if (key === "enter" || key === "return") {
				if (fieldIndex() + 1 >= fields().length) submit();
				else moveField(1);
				return true;
			}
			if (key === "up") {
				moveField(-1);
				return true;
			}
			if (key === "down") {
				moveField(1);
				return true;
			}
			if (event.sequence?.length === 1 && event.sequence >= " ") {
				editDraft(focused.key, (values()[focused.key] ?? "") + event.sequence);
				return true;
			}
			return false;
		}
		// select field
		if (key === "j" || key === "down") moveField(1);
		else if (key === "k" || key === "up") moveField(-1);
		else if (key === "h" || key === "left") cycleField(-1);
		else if (key === "l" || key === "right") cycleField(1);
		else if (key === "enter" || key === "return") {
			if (fieldIndex() + 1 >= fields().length) submit();
			else moveField(1);
		} else return false;
		return true;
	};

	// The active footer/`?` catalog follows the sub-view; the shell skips the
	// agents section so this is the one writer while it is mounted.
	createEffect(() => setActiveKeybindCatalog(catalogFor(view())));

	// A delete or a scope switch can shorten either list under the cursor; re-clamp
	// both so Enter and `d` keep acting on a real row instead of silently doing
	// nothing.
	createEffect(() => {
		const listMax = Math.max(0, listItems().length - 1);
		if (listIndex() > listMax) setListIndex(listMax);
		const menuMax = Math.max(0, menuEntries().length - 1);
		if (menuIndex() > menuMax) setMenuIndex(menuMax);
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
							title={
								entry.list
									? entry.label
									: `${entry.label}${
											entry.item?.editable === false ? " · read-only" : ""
										}`
							}
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
												: `${Object.keys(preset()?.steps ?? {}).length} steps`}
										</text>,
									]}
								/>
							);
						}}
					/>
				</Show>
			</Show>
			<Show when={view() === "form" && draft()}>
				<box style={{ width: "100%", flexGrow: 1, minHeight: 0 }}>
					<Form
						fields={fields()}
						values={values()}
						errors={errors()}
						activeIndex={fieldIndex()}
						editing
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
export function catalogFor(view: View): KeybindSection[] {
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
	return [
		{
			title: "Agent form",
			keybinds: [
				// j/k are literal text in a text field, so field movement is Tab and
				// the arrows; j/k still move between choice fields.
				{ key: "Tab/↑/↓", action: "move field", standard: true },
				{ key: "j/k", action: "move choice field", standard: true },
				{ key: "h/l", action: "change choice", standard: true },
				{ key: "Enter", action: "next / save", short: "next" },
				{ key: "Ctrl+S", action: "save", short: "save" },
				{ key: "Esc", action: "cancel", short: "cancel", standard: true },
			],
		},
	];
}
