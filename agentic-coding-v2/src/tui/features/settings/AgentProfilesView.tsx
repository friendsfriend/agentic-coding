/** @jsxImportSource @opentui/solid */
// v1 Settings/AgentPresetsView's profile list, form and delete interaction,
// copied and adapted to native-only profile definitions and the typed gateway.
// Presets/classifiers/runtime delegation intentionally do not exist in v2.
import type { KeyEvent } from "@opentui/core";
import { useKeymap } from "@opentui/keymap/solid";
import {
	type Accessor,
	createEffect,
	createSignal,
	onCleanup,
	onMount,
	Show,
} from "solid-js";
import type { Methods, SettingsDocument } from "../../../protocol/index.ts";
import type { ClientConnection } from "../../client/connection.ts";
import {
	Card,
	Form,
	type FormErrors,
	type FormField,
	type FormPane,
	type FormValues,
	GenericModal,
	hostChromeLines,
	type KeybindSection,
	LAYOUT_CHROME_LINES,
	ScrollableList,
	uiColors,
	useKeyDispatch,
	useTerminalDimensions,
} from "../../ui/index.ts";

type Draft = {
	name: string;
	originalName?: string;
	baseRevision: string;
	model: string;
	thinking: string;
	description: string;
};
const THINKING = ["off", "minimal", "low", "medium", "high", "xhigh"];
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
	..."abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789-_[]{};:\\|,.<>`~!@#$%^&*() /'\"=+"
		.split("")
		.map((key) => (key === " " ? "space" : key)),
];

export function AgentProfilesView(props: {
	client: ClientConnection;
	active: () => boolean;
	connected: boolean;
	edit: (editing: boolean) => void;
	back: () => void;
	changed: () => void;
	notify: (message: string, error?: boolean) => void;
	catalog: (catalog: KeybindSection[]) => void;
}) {
	const dispatch = useKeyDispatch();
	const dimensions = useTerminalDimensions();
	const lines = () =>
		Math.max(1, dimensions().height - hostChromeLines(LAYOUT_CHROME_LINES) - 1);
	const [document, setDocument] = createSignal<SettingsDocument>();
	const [models, setModels] = createSignal<readonly string[]>([]);
	const [loading, setLoading] = createSignal(true);
	const [busy, setBusy] = createSignal(false);
	const [readError, setReadError] = createSignal(false);
	const [index, setIndex] = createSignal(0);
	const [draft, setDraft] = createSignal<Draft>();
	const [fieldIndex, setFieldIndex] = createSignal(0);
	const [pane, setPane] = createSignal<FormPane>("field");
	const [editing, setEditing] = createSignal(false);
	const [choices, setChoices] = createSignal<Record<string, number>>({});
	const [errors, setErrors] = createSignal<FormErrors>({});
	const [pendingDelete, setPendingDelete] = createSignal<{
		name: string;
		revision: string;
	}>();
	let disposed = false,
		generation = 0;
	const names = () => Object.keys(document()?.settings.profiles ?? {}).sort();
	const ready = () =>
		!disposed &&
		props.connected &&
		!loading() &&
		!busy() &&
		!readError() &&
		!!document();
	const report = (error: unknown) =>
		props.notify(error instanceof Error ? error.message : String(error), true);
	const load = async () => {
		const request = ++generation;
		setLoading(true);
		try {
			const read = await props.client.call("settings.read", {});
			if (disposed || generation !== request) return;
			setDocument(read);
			setReadError(false);
		} catch (error) {
			if (!disposed && generation === request) {
				setReadError(true);
				report(error);
			}
		} finally {
			if (!disposed && generation === request) setLoading(false);
		}
	};
	onMount(() => {
		void load();
		void props.client
			.call("settings.models", {})
			.then((rows) => {
				if (!disposed) setModels(rows);
			})
			.catch(() => {
				// v1 falls back to free text when provider model enumeration is unavailable.
			});
	});
	const fields = (): FormField[] => [
		{ key: "name", label: "Profile name", kind: "text" },
		...(models().length
			? [
					{
						key: "model",
						label: "Model for pi-durable",
						kind: "select" as const,
						options: [
							...new Set([
								"",
								...models(),
								...(draft()?.model ? [draft()?.model ?? ""] : []),
							]),
						],
					},
				]
			: [
					{
						key: "model",
						label: "Model for pi-durable",
						kind: "text" as const,
					},
				]),
		{
			key: "thinking",
			label: "Thinking level",
			kind: "select",
			options: THINKING,
		},
		{ key: "description", label: "Description", kind: "text" },
	];
	const values = (): FormValues => {
		const current = draft();
		return {
			name: current?.name ?? "",
			model: current?.model ?? "",
			thinking: current?.thinking ?? "off",
			description: current?.description ?? "",
		};
	};
	const field = () => fields()[fieldIndex()];
	const choiceIndex = () =>
		choices()[field()?.key ?? ""] ??
		Math.max(
			0,
			(field()?.options ?? []).indexOf(
				values()[field()?.key as keyof ReturnType<typeof values>] ?? "",
			),
		);
	const open = (name?: string) => {
		const read = document();
		if (!ready() || !read) return;
		const profile = name ? read.settings.profiles[name] : undefined;
		setDraft({
			name: name ?? "",
			...(name ? { originalName: name } : {}),
			baseRevision: read.revision,
			model: profile?.model ?? "",
			thinking: profile?.thinking ?? "off",
			description: profile?.description ?? "",
		});
		setFieldIndex(0);
		setPane("field");
		setEditing(false);
		setChoices({});
		setErrors({});
	};
	const change = (key: string, value: string) => {
		const current = draft();
		if (
			!current ||
			value.length >
				(key === "description" ? 2048 : key === "model" ? 512 : 128)
		)
			return;
		setDraft({ ...current, [key]: value });
		setErrors((old) => ({ ...old, [key]: undefined }));
	};
	const commit = async (input: Methods["settings.profile"]["input"]) => {
		// Never retry an uncertain mutation.
		setBusy(true);
		try {
			const saved = await props.client.call("settings.profile", input);
			props.changed();
			if (disposed) return;
			setDocument(saved);
			setDraft(undefined);
			setEditing(false);
			setIndex((cursor) =>
				Math.min(
					cursor,
					Math.max(0, Object.keys(saved.settings.profiles).length - 1),
				),
			);
			props.notify(
				"Profile saved. Running sessions are unchanged; restart separately to apply.",
			);
		} catch (error) {
			if (!disposed) report(error);
		} finally {
			if (!disposed) setBusy(false);
		}
	};
	const submit = () => {
		const current = draft();
		if (!current || !ready()) return;
		setEditing(false);
		const nextErrors: FormErrors = {};
		const name = current.name.trim();
		if (!name || name.length > 128 || /\s/.test(name))
			nextErrors.name = "Enter a profile name without whitespace";
		else if (name !== current.originalName && names().includes(name))
			nextErrors.name = "A profile with that name already exists";
		if (current.model.indexOf("/") < 1 || current.model.endsWith("/"))
			nextErrors.model = "Choose a provider/model";
		setErrors(nextErrors);
		const first = fields().findIndex((entry) => nextErrors[entry.key]);
		if (first >= 0) {
			setFieldIndex(first);
			setPane("value");
			return;
		}
		void commit({
			baseRevision: current.baseRevision,
			operation: "save",
			name,
			...(current.originalName ? { originalName: current.originalName } : {}),
			profile: {
				model: current.model,
				thinking: current.thinking,
				description: current.description,
			},
		});
	};
	const moveField = (delta: number) => {
		setEditing(false);
		setFieldIndex((cursor) =>
			Math.max(0, Math.min(fields().length - 1, cursor + delta)),
		);
	};
	const handle = (event: KeyEvent): boolean => {
		const key = event.name.toLowerCase();
		if (event.ctrl || event.meta || event.option) return false;
		if (busy()) return true;
		const confirmation = pendingDelete();
		if (confirmation) {
			if (key === "escape" || key === "n") setPendingDelete(undefined);
			else if (key === "y" || key === "enter" || key === "return") {
				setPendingDelete(undefined);
				if (ready())
					void commit({
						baseRevision: confirmation.revision,
						operation: "delete",
						name: confirmation.name,
					});
			}
			return true;
		}
		const current = draft();
		if (!current) {
			if (key === "escape") props.back();
			else if (key === "j" || key === "down")
				setIndex((cursor) =>
					Math.min(cursor + 1, Math.max(0, names().length - 1)),
				);
			else if (key === "k" || key === "up")
				setIndex((cursor) => Math.max(0, cursor - 1));
			else if (key === "+" || key === "=") open();
			else if (key === "enter" || key === "return") {
				const selected = names()[index()];
				if (selected) open(selected);
			} else if (key === "d") {
				const name = names()[index()],
					revision = document()?.revision;
				if (ready() && name && revision) setPendingDelete({ name, revision });
			} else if (event.shift && key === "r") void load();
			else return false;
			return true;
		}
		const focused = field();
		if (!focused) return false;
		if (key === "escape") {
			if (editing()) setEditing(false);
			else {
				setDraft(undefined);
				setErrors({});
			}
		} else if (key === "tab") {
			moveField(event.shift ? -1 : 1);
			setPane("value");
		} else if (key === "enter" || key === "return") submit();
		else if (editing()) {
			if (key === "backspace" || key === "delete")
				change(
					focused.key,
					(
						values()[focused.key as keyof ReturnType<typeof values>] ?? ""
					).slice(0, -1),
				);
			else if (event.sequence?.length === 1 && event.sequence >= " ")
				change(
					focused.key,
					(values()[focused.key as keyof ReturnType<typeof values>] ?? "") +
						event.sequence,
				);
		} else if (key === "e" && focused.kind === "text") {
			setPane("value");
			setEditing(true);
		} else if (pane() === "field") {
			if (key === "j" || key === "down") moveField(1);
			else if (key === "k" || key === "up") moveField(-1);
			else if (key === "l" || key === "right") setPane("value");
			else if (key !== "h" && key !== "left") return false;
		} else if (key === "h" || key === "left") setPane("field");
		else if (focused.kind === "text") {
			if (key === "j" || key === "down") moveField(1);
			else if (key === "k" || key === "up") moveField(-1);
			else return false;
		} else {
			const options = focused.options ?? [];
			if (key === "j" || key === "down" || key === "k" || key === "up")
				setChoices((old) => ({
					...old,
					[focused.key]: Math.max(
						0,
						Math.min(
							options.length - 1,
							choiceIndex() + (key === "j" || key === "down" ? 1 : -1),
						),
					),
				}));
			else if (key === "space")
				change(focused.key, options[choiceIndex()] ?? "");
			else if (key === "x") change(focused.key, "");
			else return false;
		}
		return true;
	};
	const unregister = useKeymap().registerLayer({
		id: "v2.settings.agent-profiles",
		priority: 80,
		enabled: props.active,
		commands: [
			{
				name: "settings.agent-profiles.handle",
				run: ({ event }) => handle(event),
			},
		],
		bindings: [...new Set(SURFACE_KEYS)].map((key) => ({
			key,
			cmd: "settings.agent-profiles.handle",
			preventDefault: false,
		})),
	});
	createEffect(() => props.edit(editing() || !!pendingDelete() || busy()));
	createEffect(() =>
		props.catalog([
			{
				title: draft() ? "Agent form" : "Model profiles",
				keybinds: busy()
					? []
					: pendingDelete()
						? [
								{ key: "y/Enter", action: "confirm delete", short: "confirm" },
								{ key: "Esc/n", action: "cancel", short: "cancel" },
							]
						: draft()
							? [
									{ key: "h/l", action: "focus fields/value", standard: true },
									{
										key: "j/k or ↑/↓",
										action: "move fields/choices",
										standard: true,
									},
									{
										key: "Space",
										action: "select highlighted choice",
										short: "select",
									},
									{ key: "e", action: "edit text field", short: "edit" },
									{ key: "x", action: "clear choice", short: "clear" },
									{ key: "Tab", action: "next field", standard: true },
									{ key: "Enter", action: "validate and save", short: "save" },
									{
										key: "Esc",
										action: "finish editing / cancel",
										standard: true,
									},
								]
							: [
									{ key: "j/k or ↑/↓", action: "select entry", standard: true },
									{ key: "Enter", action: "edit entry", short: "edit" },
									{ key: "+", action: "add entry", short: "add" },
									{ key: "d", action: "delete entry", short: "delete" },
									{
										key: "R",
										action: "reload server settings",
										short: "reload",
									},
									{ key: "Esc", action: "back", standard: true },
								],
			},
		]),
	);
	onCleanup(() => {
		disposed = true;
		unregister();
		props.edit(false);
		props.catalog([]);
	});
	const renderProfile = (
		name: Accessor<string>,
		selected: Accessor<boolean>,
	) => (
		<Card
			height={3}
			selected={selected}
			title={name()}
			cells={[
				<text
					fg={uiColors.textMuted}
				>{`pi-durable · ${document()?.settings.profiles[name()]?.model ?? ""}`}</text>,
			]}
		/>
	);
	return (
		<box
			backgroundColor={uiColors.bgBase}
			style={{ width: "100%", height: "100%", flexDirection: "column" }}
		>
			<Show when={pendingDelete()}>
				{(confirmation) => (
					<GenericModal
						title="Delete profile?"
						fieldLabel={confirmation().name}
						helpSections={false}
						help={[
							{ key: "y/Enter", action: "Confirm delete" },
							{ key: "Esc/n", action: "Cancel" },
						]}
					>
						<box width="100%" flexDirection="column">
							<text
								fg={uiColors.textPrimary}
							>{`Delete "${confirmation().name}" from the managed config?`}</text>
							<text fg={uiColors.warning}>This cannot be undone.</text>
						</box>
					</GenericModal>
				)}
			</Show>
			<Show when={loading()}>
				<text fg={uiColors.textMuted}>Reading server settings…</text>
			</Show>
			<Show when={!props.connected}>
				<text fg={uiColors.warning}>Disconnected · saving withheld</text>
			</Show>
			<Show when={readError()}>
				<text fg={uiColors.warning}>Settings unavailable · R to reload</text>
			</Show>
			<Show when={busy()}>
				<text fg={uiColors.textMuted}>Saving profile…</text>
			</Show>
			<Show
				when={draft()}
				fallback={
					<Show when={!loading() && !readError()}>
						<Show
							when={names().length}
							fallback={
								<text fg={uiColors.textMuted}>
									No model profiles configured
								</text>
							}
						>
							<ScrollableList
								items={names()}
								itemKey={(name) => name}
								selectedIndex={index()}
								onSelect={setIndex}
								onActivate={() => dispatch("Enter")}
								availableLines={lines()}
								estimatedItemHeight={3}
								showScrollIndicator={false}
								renderItem={(name, selected) =>
									renderProfile(() => name, selected)
								}
								renderReactiveItem={renderProfile}
							/>
						</Show>
					</Show>
				}
			>
				<Form
					fields={fields()}
					values={values()}
					errors={errors()}
					activeIndex={fieldIndex()}
					focusedPane={pane()}
					choiceCursorIndex={choiceIndex()}
					editing={editing()}
					availableLines={lines() - 1}
					availableColumns={Math.floor(dimensions().width * 0.6)}
					header="Model profile"
				/>
			</Show>
		</box>
	);
}
