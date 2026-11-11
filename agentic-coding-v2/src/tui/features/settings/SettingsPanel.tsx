/** @jsxImportSource @opentui/solid */
// Settings menu → list → form. Edits stay local until the developer activates
// Save changes; that action saves through the authenticated revision fence,
// without putting a command or a typed digest in a non-conversation page.
import { TextAttributes } from "@opentui/core";
import {
	createEffect,
	createMemo,
	createSignal,
	Match,
	on,
	onCleanup,
	Show,
	Switch,
} from "solid-js";
import type { Data, SettingsDocument } from "../../../protocol/index.ts";
import {
	type CardEntry,
	CardList,
} from "../../presentation/components/CardList.tsx";
import {
	Form,
	type FormField,
	type FormPane,
	type FormValues,
	formOptionIndex,
} from "../../presentation/components/Form.tsx";
import { useTerminalDimensions } from "../../presentation/hooks/useTerminalDimensions.ts";
import { uiColors } from "../../presentation/theme/colors";
import { ActionHeader } from "../../ui/ActionHeader.tsx";
import { LocalJsonEditor } from "../../ui/LocalJsonEditor.tsx";
import { type MenuKey, useMenuKeys } from "../../ui/menuKeys.ts";
import { SuppliedObservation } from "../../ui/SuppliedObservation.tsx";
import { color } from "../../ui/theme/index.ts";
import { getActiveThemeName } from "../../ui/theme/theme.ts";
import { SettingsSectionView } from "./SettingsSectionView.tsx";

type Section = "orchestrator" | "profiles" | "repositories" | "providers";
type Level =
	| { kind: "menu" }
	| { kind: "appearance" }
	| { kind: "list"; section: Section }
	| { kind: "form"; section: Section; index: number }
	| { kind: "advanced" };

const SECTION_LABELS: Record<Section, string> = {
	orchestrator: "Orchestrator",
	profiles: "Model profiles",
	repositories: "Repositories",
	providers: "Providers",
};
const THINKING = ["off", "minimal", "low", "medium", "high", "xhigh"] as const;

const object = (value: unknown): Data =>
	value && typeof value === "object" && !Array.isArray(value)
		? (value as Data)
		: {};
const text = (value: unknown): string =>
	typeof value === "string" ? value : value === undefined ? "" : String(value);
const shown = (value: unknown) => text(value) || "—";

export function SettingsPanel(props: {
	document: SettingsDocument | null;
	error: string | null;
	draft: string;
	change: (value: string) => void;
	editing: boolean;
	edit: (value: boolean) => void;
	connected: boolean;
	fresh: boolean;
	saving: boolean;
	save: () => void;
	reset: () => void;
	openTheme: () => void;
	/** The shell grants page keys only while content is focused, no dialog or
	 * editor is open and the prompt is empty. */
	keys: () => boolean;
}) {
	const dimensions = useTerminalDimensions();
	const [level, setLevel] = createSignal<Level>({ kind: "menu" });
	const [menuIndex, setMenuIndex] = createSignal(0);
	const [listIndex, setListIndex] = createSignal(0);
	const [fieldIndex, setFieldIndex] = createSignal(0);
	const [pane, setPane] = createSignal<FormPane>("field");
	const [choice, setChoice] = createSignal(0);
	const [observed, setObserved] = createSignal(false);
	let disposed = false,
		generation = 0;
	onCleanup(() => {
		disposed = true;
	});
	const documentSource = createMemo(() => ({
		document: props.document,
		generation: ++generation,
	}));
	const ready = () =>
		!disposed &&
		props.connected &&
		props.fresh &&
		!props.error &&
		!props.saving;
	const writable = () => ready();
	const parsed = createMemo(() => {
		try {
			const value: unknown = JSON.parse(props.draft);
			return value && typeof value === "object" && !Array.isArray(value)
				? (value as Data)
				: null;
		} catch {
			return null;
		}
	});
	const dirty = createMemo(() => {
		const settings = props.document?.settings;
		return settings ? props.draft !== JSON.stringify(settings, null, 2) : false;
	});
	const mutate = (change: (draft: Data) => void) => {
		const draft = parsed();
		if (!draft || !writable()) return;
		const next = structuredClone(draft);
		change(next);
		props.change(JSON.stringify(next, null, 2));
	};
	const profiles = () => object(parsed()?.profiles);
	const profileIds = () => Object.keys(profiles());
	const list = (key: string): unknown[] =>
		Array.isArray(parsed()?.[key]) ? (parsed()?.[key] as unknown[]) : [];

	// ---- menu ----
	const menuEntries = (): (CardEntry & { open: () => void })[] => [
		{
			id: "appearance",
			title: "Appearance",
			detail: "Theme and client-local UI preferences",
			open: () => setLevel({ kind: "appearance" }),
		},
		{
			id: "orchestrator",
			title: SECTION_LABELS.orchestrator,
			detail: `Default profile · ${shown(parsed()?.orchestratorProfile)}`,
			open: () => openList("orchestrator"),
		},
		{
			id: "profiles",
			title: SECTION_LABELS.profiles,
			detail: `${profileIds().length} profiles · model and thinking level per role`,
			open: () => openList("profiles"),
		},
		{
			id: "repositories",
			title: SECTION_LABELS.repositories,
			detail: `${list("repositories").length} repositories the server may work in`,
			open: () => openList("repositories"),
		},
		{
			id: "providers",
			title: SECTION_LABELS.providers,
			detail: `${list("providers").length} git providers · tokens stay environment references`,
			open: () => openList("providers"),
		},
		...(dirty() && ready()
			? [
					{
						id: "save",
						title: "Save changes",
						detail: "Save to the server · applies after a restart",
						accent: uiColors.success,
						open: props.save,
					},
					{
						id: "discard",
						title: "Discard edits",
						detail: "Restore the last settings read from the server",
						accent: uiColors.warning,
						open: props.reset,
					},
				]
			: []),
		{
			id: "advanced",
			title: "Advanced",
			detail: "The whole settings document as JSON",
			open: () => {
				setLevel({ kind: "advanced" });
			},
		},
	];
	const openList = (section: Section) => {
		if (!parsed()) return;
		setListIndex(0);
		setLevel({ kind: "list", section });
	};

	// ---- lists ----
	const listEntries = (section: Section): CardEntry[] => {
		switch (section) {
			case "orchestrator":
				return [
					{
						id: "default",
						title: "Default profile",
						detail: "The profile new Orchestrator sessions use",
						value: shown(parsed()?.orchestratorProfile),
					},
				];
			case "profiles":
				return [
					...profileIds().map((id) => {
						const profile = object(profiles()[id]);
						return {
							id,
							title: id,
							detail: text(profile.description) || "No description",
							value: `${shown(profile.model)} · ${shown(profile.thinking)}`,
						};
					}),
					{ id: "+", title: "+ Add profile", accent: uiColors.success },
				];
			case "repositories":
				return [
					...list("repositories").map((path, index) => ({
						id: `repository:${index}`,
						title: shown(path),
						detail: "Absolute path on the host",
					})),
					{ id: "+", title: "+ Add repository", accent: uiColors.success },
				];
			case "providers":
				return [
					...list("providers").map((entry, index) => {
						const provider = object(entry);
						return {
							id: `provider:${index}`,
							title: shown(provider.name),
							detail: shown(provider.baseUrl),
							value: `${shown(provider.type)}${provider.tokenRef ? ` · ${text(provider.tokenRef)}` : ""}`,
						};
					}),
					{ id: "+", title: "+ Add provider", accent: uiColors.success },
				];
		}
	};
	const add = (section: Section): number => {
		if (section === "profiles") {
			let id = "new-profile",
				index = 1;
			while (Object.hasOwn(profiles(), id)) id = `new-profile-${index++}`;
			mutate((draft) => {
				draft.profiles = {
					...object(draft.profiles),
					[id]: { model: "", thinking: "off", description: "" },
				};
			});
			return profileIds().length - 1;
		}
		if (section === "repositories") {
			mutate((draft) => {
				draft.repositories = [
					...(Array.isArray(draft.repositories) ? draft.repositories : []),
					"",
				];
			});
			return list("repositories").length - 1;
		}
		mutate((draft) => {
			draft.providers = [
				...(Array.isArray(draft.providers) ? draft.providers : []),
				{ name: "new-provider", type: "gitlab", baseUrl: "https://gitlab.com" },
			];
		});
		return list("providers").length - 1;
	};
	const openForm = (section: Section, index: number) => {
		setFieldIndex(0);
		setPane("field");
		setLevel({ kind: "form", section, index });
	};
	const activateListEntry = (section: Section, index: number) => {
		const entry = listEntries(section)[index];
		if (!entry || !writable()) return;
		openForm(section, entry.id === "+" ? add(section) : index);
	};

	// ---- forms ----
	const formFields = (section: Section): FormField[] => {
		switch (section) {
			case "orchestrator":
				return [
					{
						key: "orchestratorProfile",
						label: "Default profile",
						kind: "select",
						options: profileIds(),
						hint: "Names one of the model profiles",
					},
				];
			case "profiles":
				return [
					{ key: "name", label: "Name", kind: "text", maxLength: 128 },
					{
						key: "model",
						label: "Model",
						kind: "text",
						maxLength: 256,
						hint: "provider/model as the provider names it",
					},
					{
						key: "thinking",
						label: "Thinking",
						kind: "select",
						options: THINKING,
					},
					{
						key: "description",
						label: "Description",
						kind: "text",
						maxLength: 2048,
					},
					{
						key: "remove",
						label: "Remove profile",
						kind: "action",
						tone: "warning",
					},
				];
			case "repositories":
				return [
					{
						key: "path",
						label: "Path",
						kind: "text",
						hint: "Absolute path on the host",
					},
					{
						key: "remove",
						label: "Remove repository",
						kind: "action",
						tone: "warning",
					},
				];
			case "providers":
				return [
					{ key: "name", label: "Name", kind: "text", maxLength: 128 },
					{
						key: "type",
						label: "Type",
						kind: "select",
						options: ["github", "gitlab"],
					},
					{
						key: "baseUrl",
						label: "Base URL",
						kind: "text",
						maxLength: 2048,
						hint: "HTTPS; HTTP only on loopback",
					},
					{ key: "username", label: "Username", kind: "text", maxLength: 256 },
					{
						key: "tokenRef",
						label: "Token reference",
						kind: "text",
						maxLength: 256,
						hint: "Name of an environment variable, never the token",
					},
					{
						key: "remove",
						label: "Remove provider",
						kind: "action",
						tone: "warning",
					},
				];
		}
	};
	const formValues = (section: Section, index: number): FormValues => {
		switch (section) {
			case "orchestrator":
				return { orchestratorProfile: text(parsed()?.orchestratorProfile) };
			case "profiles": {
				const id = profileIds()[index] ?? "";
				const profile = object(profiles()[id]);
				return {
					name: id,
					model: text(profile.model),
					thinking: text(profile.thinking),
					description: text(profile.description),
				};
			}
			case "repositories":
				return { path: text(list("repositories")[index]) };
			case "providers": {
				const provider = object(list("providers")[index]);
				return {
					name: text(provider.name),
					type: text(provider.type),
					baseUrl: text(provider.baseUrl),
					username: text(provider.username),
					tokenRef: text(provider.tokenRef),
				};
			}
		}
	};
	const setValue = (
		section: Section,
		index: number,
		key: string,
		value: string,
	) =>
		mutate((draft) => {
			if (section === "orchestrator") {
				draft.orchestratorProfile = value;
				return;
			}
			if (section === "profiles") {
				const current = object(draft.profiles);
				const id = Object.keys(current)[index];
				if (id === undefined) return;
				if (key === "name") {
					// Rename in place so the list position (the form's cursor) holds.
					if (!value || (value !== id && Object.hasOwn(current, value))) return;
					draft.profiles = Object.fromEntries(
						Object.entries(current).map(([name, entry]) => [
							name === id ? value : name,
							entry,
						]),
					);
					if (draft.orchestratorProfile === id)
						draft.orchestratorProfile = value;
					return;
				}
				current[id] = { ...object(current[id]), [key]: value };
				draft.profiles = current;
				return;
			}
			if (section === "repositories") {
				if (
					Array.isArray(draft.repositories) &&
					index < draft.repositories.length
				)
					draft.repositories[index] = value;
				return;
			}
			if (!Array.isArray(draft.providers) || index >= draft.providers.length)
				return;
			const provider = object(draft.providers[index]);
			if (!value && (key === "username" || key === "tokenRef"))
				delete provider[key];
			else provider[key] = value;
			draft.providers[index] = provider;
		});
	const remove = (section: Section, index: number) => {
		mutate((draft) => {
			if (section === "profiles") {
				const id = Object.keys(object(draft.profiles))[index];
				if (id !== undefined) delete object(draft.profiles)[id];
			} else if (
				section === "repositories" &&
				Array.isArray(draft.repositories)
			)
				draft.repositories.splice(index, 1);
			else if (section === "providers" && Array.isArray(draft.providers))
				draft.providers.splice(index, 1);
		});
		props.edit(false);
		setListIndex(Math.max(0, index - 1));
		setLevel({ kind: "list", section });
	};

	// ---- keys ----
	const clamp = (value: number, length: number) =>
		Math.max(0, Math.min(value, Math.max(0, length - 1)));
	const key = (input: MenuKey): boolean | undefined => {
		const current = level();
		const step = input === "up" ? -1 : input === "down" ? 1 : 0;
		if (current.kind === "menu") {
			const entries = menuEntries();
			if (input === "back" || input === "left") return false;
			if (step) setMenuIndex(clamp(menuIndex() + step, entries.length));
			else if (input === "open" || input === "right")
				entries[clamp(menuIndex(), entries.length)]?.open();
			return;
		}
		if (current.kind === "appearance") {
			if (input === "back" || input === "left") setLevel({ kind: "menu" });
			else if (input === "open" || input === "right") props.openTheme();
			return;
		}
		if (current.kind === "advanced") {
			if (input === "back" || input === "left") setLevel({ kind: "menu" });
			return;
		}
		if (current.kind === "list") {
			const entries = listEntries(current.section);
			if (step) setListIndex(clamp(listIndex() + step, entries.length));
			else if (input === "open" || input === "right")
				activateListEntry(current.section, clamp(listIndex(), entries.length));
			else setLevel({ kind: "menu" });
			return;
		}
		const fields = formFields(current.section);
		const field = fields[fieldIndex()];
		if (!field) return;
		if (pane() === "field") {
			if (step) setFieldIndex(clamp(fieldIndex() + step, fields.length));
			else if (input === "back" || input === "left") {
				setListIndex(current.index);
				setLevel({ kind: "list", section: current.section });
			} else if (field.kind === "action")
				remove(current.section, current.index);
			else {
				setPane("value");
				setChoice(
					formOptionIndex(
						field,
						formValues(current.section, current.index)[field.key] ?? "",
					),
				);
				if (field.kind === "text" && writable()) props.edit(true);
			}
			return;
		}
		if (field.kind === "select") {
			const options = field.options ?? [];
			if (step) setChoice(clamp(choice() + step, options.length));
			else if (input === "open") {
				const option = options[choice()];
				if (option !== undefined)
					setValue(current.section, current.index, field.key, option);
				setPane("field");
			} else setPane("field");
			return;
		}
		if (input === "back" || input === "left") setPane("field");
		else if (input === "open" && writable()) props.edit(true);
	};
	useMenuKeys({ active: () => props.keys() && !props.editing, key });
	// Leaving the text editor (Enter, Escape or a focus change) returns the form
	// cursor to the field list, as the original form did.
	createEffect(
		on(
			() => props.editing,
			(editing: boolean, was: boolean | undefined) => {
				const current = level();
				const field =
					current.kind === "form"
						? formFields(current.section)[fieldIndex()]
						: undefined;
				if (was && !editing && field?.kind === "text") setPane("field");
			},
		),
	);

	const lines = () => Math.max(4, dimensions().height - 14);
	const path = () => {
		const current = level();
		if (current.kind === "menu") return "";
		if (current.kind === "advanced") return "Advanced";
		if (current.kind === "appearance") return "Appearance";
		const section = SECTION_LABELS[current.section];
		if (current.kind === "list") return section;
		return `${section} › ${listEntries(current.section)[current.index]?.title ?? ""}`;
	};
	return (
		<box flexDirection="column" gap={1} backgroundColor={uiColors.bgBase}>
			<box flexDirection="row">
				<Show when={path()}>
					<text fg={uiColors.textPrimary} attributes={TextAttributes.BOLD}>
						{path()}
					</text>
					<text fg={uiColors.textMuted}>{"  ·  "}</text>
				</Show>
				<text fg={dirty() ? uiColors.warning : uiColors.textMuted}>
					{props.saving
						? "Saving changes…"
						: dirty()
							? "Unsaved changes · they apply after a restart"
							: "Saved · changes apply after a restart"}
				</text>
			</box>
			<Show when={props.error}>
				<text fg={uiColors.warning}>Reading settings failed</text>
			</Show>
			<Show when={!props.connected || !props.fresh}>
				<text fg={uiColors.warning}>Disconnected · showing the last read</text>
			</Show>
			<Show when={props.document && !parsed()}>
				<text fg={uiColors.warning}>
					The draft is not a JSON object. Fix it in Advanced.
				</text>
			</Show>
			<Show when={props.document}>
				<Switch>
					<Match when={level().kind === "appearance"}>
						<SettingsSectionView
							items={[
								{
									id: "appearance.theme",
									label: "Theme",
									value: getActiveThemeName(),
									detail: "Changes the colorscheme of the application",
									editable: true,
								},
							]}
							selectedIndex={0}
							onSelectIndex={() => {}}
						/>
					</Match>
					<Match when={level().kind === "menu"}>
						<CardList
							entries={menuEntries()}
							selectedIndex={menuIndex()}
							availableLines={lines()}
							onSelect={setMenuIndex}
							onActivate={(index) => {
								setMenuIndex(index);
								menuEntries()[index]?.open();
							}}
						/>
					</Match>
					<Match
						when={(() => {
							const current = level();
							return current.kind === "list" ? current : undefined;
						})()}
					>
						{(current) => (
							<CardList
								entries={listEntries(current().section)}
								selectedIndex={listIndex()}
								availableLines={lines()}
								onSelect={setListIndex}
								onActivate={(index) => {
									setListIndex(index);
									activateListEntry(current().section, index);
								}}
							/>
						)}
					</Match>
					<Match
						when={(() => {
							const current = level();
							return current.kind === "form" ? current : undefined;
						})()}
					>
						{(current) => (
							<Form
								fields={formFields(current().section)}
								values={formValues(current().section, current().index)}
								activeIndex={fieldIndex()}
								focusedPane={pane()}
								choiceCursorIndex={choice()}
								editing={props.editing}
								onInput={(field, value) =>
									setValue(current().section, current().index, field, value)
								}
								onEditDone={() => {
									props.edit(false);
									setPane("field");
								}}
								onSelectField={(index) => {
									setFieldIndex(index);
									setPane("field");
								}}
								actionContent={
									<text fg={uiColors.warning}>
										Enter removes it from the local draft
									</text>
								}
							/>
						)}
					</Match>
					<Match when={level().kind === "advanced"}>
						<ActionHeader
							scope={[documentSource(), props.draft]}
							interactive={writable()}
							onActivate={() => props.edit(!props.editing)}
						>
							<text fg={color("accent")}>
								{props.editing ? "Leave JSON editor" : "Edit JSON"}
							</text>
						</ActionHeader>
						<LocalJsonEditor
							maxLength={128000}
							value={props.draft}
							scope={`settings:${documentSource().generation}:${props.document?.revision ?? "absent"}`}
							editing={props.editing}
							interactive={writable()}
							enter={() => {
								if (writable()) props.edit(true);
							}}
							change={props.change}
						/>
						<ActionHeader
							scope={[documentSource(), observed()]}
							onActivate={() => setObserved(!observed())}
						>
							<text fg={color("accent")}>
								{observed() ? "▾" : "▸"} Settings on disk
							</text>
						</ActionHeader>
						<Show when={observed()}>
							<SuppliedObservation
								value={props.document?.settings}
								scope={documentSource()}
								label="Settings as read"
							/>
						</Show>
					</Match>
				</Switch>
			</Show>
		</box>
	);
}
