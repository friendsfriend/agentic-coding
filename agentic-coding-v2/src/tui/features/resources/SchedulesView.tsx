/** @jsxImportSource @opentui/solid */
// v1's Schedules surface (src/tui/schedules/SchedulesView.tsx +
// ScheduleDetails.tsx + keybinds.ts), copied in shape: a list of schedules, a
// detail pane, and a form/list editor with F2/Ctrl+Enter to save. The native
// scheduler is the only authority; v2 schedules an ordinary native invocation,
// so the editor carries skill/profile/repository/topic/inputs/timing instead of
// v1's workflow jobs.
import type { KeyEvent } from "@opentui/core";
import { useKeymap } from "@opentui/keymap/solid";
import {
	type Accessor,
	createEffect,
	createMemo,
	createSignal,
	For,
	onCleanup,
	Show,
} from "solid-js";
import type { Data, Methods, SkillSummary } from "../../../protocol/index.ts";
import type { ClientConnection } from "../../client/connection.ts";
import { Selectable } from "../../presentation/components/Selectable.tsx";
import { ActionHeader } from "../../ui/ActionHeader.tsx";
import {
	Form,
	type FormField,
	type FormPane,
	type FormValues,
	type KeybindSection,
	ScrollableList,
	uiColors,
	useKeyDispatch,
} from "../../ui/index.ts";
import { editorKeybinds, textareaBindings } from "../../ui/keybinds.ts";

type Timing = Methods["schedule.create"]["input"]["timing"];
type Draft = {
	id: string;
	skill: string;
	profile: string;
	repository: string;
	baseRef: string;
	topic: string;
	inputs: string;
	timing: "once" | "interval" | "calendar";
	at: string;
	anchor: string;
	every: string;
	timezone: string;
	weekdays: string;
	hour: string;
	minute: string;
	late: "run-late" | "expire-after";
	grace: string;
};
const SAMPLE = (now: number) =>
	new Date(now + 3_600_000).toISOString().slice(0, 16);

function draftFor(repositories: string[], profiles: string[]): Draft {
	const now = Date.now();
	return {
		id: "",
		skill: "",
		profile: profiles[0] ?? "",
		repository: repositories[0] ?? "",
		baseRef: "HEAD",
		topic: "",
		inputs: "",
		timing: "interval",
		at: SAMPLE(now),
		anchor: SAMPLE(now),
		every: "60",
		timezone: Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC",
		weekdays: "1,2,3,4,5",
		hour: "9",
		minute: "0",
		late: "run-late",
		grace: "60",
	};
}

const instant = (value: string) => {
	const parsed = Date.parse(value);
	if (!Number.isFinite(parsed))
		throw new Error("Use an ISO instant such as 2026-01-31T09:00");
	return parsed;
};
const count = (value: string, max: number, name: string) => {
	if (!/^\d+$/.test(value.trim()))
		throw new Error(`${name} must be a whole number`);
	const parsed = Number(value);
	if (!Number.isSafeInteger(parsed) || parsed < 0 || parsed > max)
		throw new Error(`${name} is out of range`);
	return parsed;
};

export function SchedulesView(props: {
	client: ClientConnection;
	schedules: Data[];
	profiles: Data[];
	repositories: string[];
	skills: SkillSummary[];
	connected: boolean;
	fresh: boolean;
	active: () => boolean;
	changed: () => void;
	notify: (message: string, error?: boolean) => void;
	catalog: (catalog: KeybindSection[]) => void;
}) {
	const dispatch = useKeyDispatch();
	const [selected, setSelected] = createSignal(0);
	const [detail, setDetail] = createSignal(false);
	const [draft, setDraft] = createSignal<Draft>();
	const [fieldIndex, setFieldIndex] = createSignal(0);
	const [pane, setPane] = createSignal<FormPane>("field");
	const [choice, setChoice] = createSignal(0);
	const [editing, setEditing] = createSignal(false);
	const [pendingDelete, setPendingDelete] = createSignal<{
		id: string;
		revision: number;
	}>();
	const [busy, setBusy] = createSignal(false);
	let disposed = false;
	const ready = () => !disposed && props.connected && props.fresh && !busy();
	const report = (value: unknown) =>
		props.notify(value instanceof Error ? value.message : String(value), true);
	const profileIds = () =>
		props.profiles
			.map((profile) => String(profile.id))
			.filter((id) => id.length > 0);
	const row = createMemo(() => {
		const rows = props.schedules;
		return rows[selected()] ?? rows[0];
	});
	createEffect(() => {
		if (!props.schedules.length) {
			setSelected(0);
			setDetail(false);
			return;
		}
		if (selected() >= props.schedules.length)
			setSelected(props.schedules.length - 1);
	});

	// ---- editor ----
	const fields = (): FormField[] => {
		const current = draft();
		if (!current) return [];
		const timing: FormField[] =
			current.timing === "once"
				? [{ key: "at", label: "Run at (local date-time)", kind: "text" }]
				: current.timing === "interval"
					? [
							{
								key: "anchor",
								label: "Anchor (local date-time)",
								kind: "text",
							},
							{ key: "every", label: "Every (minutes)", kind: "text" },
						]
					: [
							{ key: "timezone", label: "Timezone", kind: "text" },
							{
								key: "weekdays",
								label: "Weekdays (1=Mon … 7=Sun)",
								kind: "text",
							},
							{ key: "hour", label: "Hour (0–23)", kind: "text" },
							{ key: "minute", label: "Minute (0–59)", kind: "text" },
						];
		return [
			{
				key: "id",
				label: "Schedule identity",
				kind: "text",
				hint: "Stable request identity; a reused id must describe the same run",
			},
			{
				key: "skill",
				label: "Skill",
				kind: "select",
				options: props.skills.map((skill) => skill.id),
			},
			{
				key: "profile",
				label: "Profile",
				kind: "select",
				options: profileIds(),
			},
			{
				key: "repository",
				label: "Repository",
				kind: "select",
				options: props.repositories,
			},
			{ key: "baseRef", label: "Git base", kind: "text" },
			{ key: "topic", label: "Topic", kind: "text" },
			{ key: "inputs", label: "Inputs", kind: "text" },
			{
				key: "timing",
				label: "Recurrence",
				kind: "select",
				options: ["once", "interval", "calendar"],
			},
			...timing,
			{
				key: "late",
				label: "Late policy",
				kind: "select",
				options: ["run-late", "expire-after"],
			},
			...(current.late === "expire-after"
				? [{ key: "grace", label: "Grace (minutes)", kind: "text" as const }]
				: []),
		];
	};
	const values = (): FormValues => {
		const current = draft();
		if (!current) return {};
		return { ...current } as unknown as FormValues;
	};
	const field = createMemo(() => fields()[fieldIndex()]);
	const optionIndex = () => {
		const active = field();
		const options = active?.options ?? [];
		return choice() < options.length ? choice() : 0;
	};
	const setValue = (key: string, value: string) => {
		const current = draft();
		if (!current) return;
		if (value.length > (key === "inputs" ? 16000 : 256)) return;
		setDraft({ ...current, [key]: value } as Draft);
		// Changing the recurrence or the late policy changes the field list.
		if (key === "timing" || key === "late") setFieldIndex(0);
	};
	const openEditor = () => {
		if (!ready()) return;
		setFieldIndex(0);
		setPane("field");
		setEditing(false);
		setChoice(0);
		setDraft(draftFor(props.repositories, profileIds()));
	};
	const closeEditor = () => {
		setDraft(undefined);
		setEditing(false);
	};
	const timingOf = (current: Draft): Timing => {
		if (current.timing === "once")
			return { kind: "once", at: instant(current.at) };
		if (current.timing === "interval")
			return {
				kind: "interval",
				everyMs: count(current.every, 366 * 24 * 60, "Interval") * 60_000,
				anchor: instant(current.anchor),
			};
		const weekdays = current.weekdays
			.split(",")
			.map((day) => day.trim())
			.filter(Boolean)
			.map((day) => count(day, 7, "Weekday"));
		if (!weekdays.length) throw new Error("Choose at least one weekday");
		return {
			kind: "calendar",
			timezone: current.timezone.trim(),
			weekdays: [...new Set(weekdays)].sort((left, right) => left - right),
			hour: count(current.hour, 23, "Hour"),
			minute: count(current.minute, 59, "Minute"),
		};
	};
	const save = async () => {
		const current = draft();
		if (!current || !ready()) return;
		setEditing(false);
		if (!/^[A-Za-z0-9:_-]{1,128}$/.test(current.id.trim()))
			return report("Use letters, digits, ':', '_' or '-' for the identity");
		if (!current.skill || !current.profile || !current.repository)
			return report("Choose a skill, a profile and a repository");
		if (!current.topic.trim() || !current.inputs.trim())
			return report("A topic and inputs are required");
		let timing: Timing;
		try {
			timing = timingOf(current);
		} catch (error) {
			return report(error);
		}
		setBusy(true);
		try {
			await props.client.call("schedule.create", {
				id: current.id.trim(),
				invocation: {
					topicId: current.topic.trim(),
					skill: current.skill,
					profile: current.profile,
					repository: current.repository,
					baseRef: current.baseRef.trim() || "HEAD",
					inputs: current.inputs,
					requestId: `schedule:${current.id.trim()}`,
				},
				timing,
				lateGraceMs:
					current.late === "expire-after"
						? count(current.grace, 366 * 24 * 60, "Grace") * 60_000
						: null,
			});
			closeEditor();
			props.changed();
			props.notify(`Schedule ${current.id.trim()} saved`);
		} catch (error) {
			if (!disposed) report(error);
		} finally {
			if (!disposed) setBusy(false);
		}
	};
	const setState = async (state: "enabled" | "paused") => {
		const target = row();
		if (!ready() || !target) return;
		setBusy(true);
		try {
			await props.client.call("schedule.state", {
				id: String(target.id),
				revision: Number(target.revision),
				state,
			});
			props.changed();
			props.notify(`Schedule ${String(target.id)} ${state}`);
		} catch (error) {
			if (!disposed) report(error);
		} finally {
			if (!disposed) setBusy(false);
		}
	};
	const remove = async (id: string, revision: number) => {
		if (!ready()) return;
		setBusy(true);
		try {
			await props.client.call("schedule.delete", { id, revision });
			setDetail(false);
			props.changed();
			props.notify(
				`Schedule ${id} deleted; an already admitted task is untouched`,
			);
		} catch (error) {
			if (!disposed) report(error);
		} finally {
			if (!disposed) setBusy(false);
		}
	};

	// ---- keys ----
	const moveField = (delta: number) => {
		setFieldIndex((index) =>
			Math.max(0, Math.min(fields().length - 1, index + delta)),
		);
	};
	const handleEditor = (event: KeyEvent, key: string): boolean => {
		const active = field();
		if (!active) return false;
		if (event.ctrl && (key === "return" || key === "enter")) {
			void save();
			return true;
		}
		if (key === "f2") {
			void save();
			return true;
		}
		if (editing()) {
			if (key === "escape" || key === "tab") {
				setEditing(false);
				if (key === "tab") {
					moveField(event.shift ? -1 : 1);
					setPane("value");
				}
				return true;
			}
			return false;
		}
		if (key === "escape") {
			if (pane() === "value" && active.kind === "text") setPane("field");
			else closeEditor();
		} else if (key === "tab") {
			moveField(event.shift ? -1 : 1);
			setPane("value");
		} else if (pane() === "field") {
			if (key === "j" || key === "down") moveField(1);
			else if (key === "k" || key === "up") moveField(-1);
			else if (key === "l" || key === "right") setPane("value");
			else if (key !== "h" && key !== "left") return false;
		} else if (key === "h" || key === "left") setPane("field");
		else if (active.kind !== "select") {
			if (key === "e" || key === "enter" || key === "return") {
				setEditing(true);
				return true;
			}
			if (key === "backspace" || key === "delete")
				setValue(active.key, (values()[active.key] ?? "").slice(0, -1));
			else if (event.sequence?.length === 1 && event.sequence >= " ")
				setValue(active.key, (values()[active.key] ?? "") + event.sequence);
			else return false;
		} else {
			const options = active.options ?? [];
			if (key === "j" || key === "down")
				setChoice(Math.min(options.length - 1, optionIndex() + 1));
			else if (key === "k" || key === "up")
				setChoice(Math.max(0, optionIndex() - 1));
			else if (key === "space")
				setValue(active.key, options[optionIndex()] ?? "");
			else return false;
		}
		return true;
	};
	const handle = (event: KeyEvent): boolean => {
		const key = event.name.toLowerCase();
		if (draft() && event.ctrl && (key === "return" || key === "enter"))
			return handleEditor(event, key);
		if (event.ctrl || event.meta || event.option) return false;
		if (busy()) return true;
		if (draft()) return handleEditor(event, key);
		const confirmation = pendingDelete();
		if (confirmation) {
			if (key === "escape" || key === "n") setPendingDelete(undefined);
			else if (key === "y" || key === "enter" || key === "return") {
				setPendingDelete(undefined);
				void remove(confirmation.id, confirmation.revision);
			}
			return true;
		}
		if (key === "escape") {
			if (detail()) setDetail(false);
			else return false;
			return true;
		}
		if (key === "n" || key === "w") {
			openEditor();
			return true;
		}
		if (key === "j" || key === "down") {
			setSelected((index) =>
				Math.min(Math.max(0, props.schedules.length - 1), index + 1),
			);
			return true;
		}
		if (key === "k" || key === "up") {
			setSelected((index) => Math.max(0, index - 1));
			return true;
		}
		if (key === "enter" || key === "return") {
			if (row()) setDetail(true);
			return true;
		}
		if (key === "p") {
			const target = row();
			if (target)
				void setState(target.state === "paused" ? "enabled" : "paused");
			return true;
		}
		if (key === "d") {
			const target = row();
			if (target && ready())
				setPendingDelete({
					id: String(target.id),
					revision: Number(target.revision),
				});
			return true;
		}
		if (key === "f") return false;
		return false;
	};
	const bindings = [
		"escape",
		"return",
		"enter",
		"tab",
		"shift+tab",
		"f2",
		"ctrl+enter",
		"ctrl+return",
		"space",
		"up",
		"down",
		"left",
		"right",
		"backspace",
		"delete",
		..."abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789-_[]{};:\\|,.<>`~!@#$%^&*() /'\"="
			.split("")
			.map((key) => (key === " " ? "space" : key)),
	];
	const unregister = useKeymap().registerLayer({
		id: "v2.schedules",
		priority: 80,
		enabled: props.active,
		commands: [{ name: "schedules.handle", run: ({ event }) => handle(event) }],
		bindings: bindings
			.filter((key, index, all) => all.indexOf(key) === index)
			.map((key) => ({ key, cmd: "schedules.handle" })),
	});
	createEffect(() => {
		const current = draft();
		props.catalog([
			{
				title: current
					? "Schedule editor"
					: detail()
						? "Schedule"
						: "Schedules",
				keybinds: current
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
							{ key: "Tab", action: "next field", standard: true },
							{ key: "F2/Ctrl+Enter", action: "save schedule", short: "save" },
							{ key: "Esc", action: "finish editing / cancel", standard: true },
						]
					: pendingDelete()
						? [
								{ key: "y/Enter", action: "confirm delete", short: "confirm" },
								{ key: "Esc/n", action: "cancel", short: "cancel" },
							]
						: detail()
							? [
									{
										key: "PgUp/PgDn",
										action: "scroll details",
										standard: true,
									},
									{ key: "p", action: "pause/resume", short: "pause" },
									{ key: "d", action: "delete schedule", short: "delete" },
									{ key: "Esc", action: "back", standard: true },
								]
							: [
									{
										key: "j/k or ↑/↓",
										action: "move selection",
										standard: true,
									},
									{ key: "Enter", action: "open details", standard: true },
									{ key: "n", action: "new schedule", short: "new" },
									{ key: "p", action: "pause/resume", short: "pause" },
									{ key: "d", action: "delete schedule", short: "delete" },
									{ key: "Esc", action: "parent page", standard: true },
								],
			},
		]);
	});
	onCleanup(() => {
		disposed = true;
		unregister();
		props.catalog([]);
	});

	const renderRow = (
		entry: Accessor<Data>,
		selectedRow: Accessor<boolean>,
		index: Accessor<number>,
	) => (
		<Selectable
			height={3}
			selected={selectedRow()}
			onMouseUp={() => setSelected(index())}
			onActivate={() => dispatch("Enter")}
		>
			<box flexDirection="column" height={3}>
				<text fg={uiColors.textPrimary}>
					{String(entry().id)}
					{entry().state === "paused" ? " · paused" : ""}
				</text>
				<text fg={uiColors.textMuted}>{describe(entry())}</text>
			</box>
		</Selectable>
	);

	return (
		<box
			backgroundColor={uiColors.bgBase}
			style={{ width: "100%", height: "100%", flexDirection: "column" }}
		>
			<Show when={!props.connected}>
				<text fg={uiColors.warning}>Disconnected · editing withheld</text>
			</Show>
			<Show when={busy()}>
				<text fg={uiColors.textMuted}>Applying…</text>
			</Show>
			<Show when={draft()} keyed>
				{(current) => (
					<box flexDirection="column" gap={1}>
						<text fg={uiColors.primary}>
							{" "}
							New schedule · skill run on a native task · no OS wake
						</text>
						<Form
							fields={fields()}
							values={values()}
							activeIndex={fieldIndex()}
							focusedPane={pane()}
							choiceCursorIndex={optionIndex()}
							editing={false}
							header="Schedule"
						/>
						<Show when={cur_isText(field()?.kind)}>
							<Show when={editing()}>
								<box flexDirection="column">
									<text fg={uiColors.textMuted}>
										{field()?.label} · Enter adds a line · F2/Ctrl+Enter saves ·
										Esc leaves the text
									</text>
									<textarea
										initialValue={values()[field()?.key ?? ""] ?? ""}
										focused={true}
										height={8}
										width="100%"
										keyBindings={textareaBindings(editorKeybinds)}
										onContentChange={(event) => {
											const value =
												typeof event === "string" ? event : event.plainText;
											if (
												typeof value === "string" &&
												value !== values()[field()?.key ?? ""]
											)
												setValue(field()?.key ?? "", value);
										}}
									/>
								</box>
							</Show>
						</Show>
						<text fg={uiColors.textMuted}>{describeTiming(current)}</text>
					</box>
				)}
			</Show>
			<Show when={!draft()}>
				<Show
					when={detail() && row()}
					fallback={
						<Show when={!detail()}>
							<Show
								when={props.schedules.length}
								fallback={
									<text fg={uiColors.textMuted}>
										No schedules · n creates one; the server must run for an
										occurrence to be admitted
									</text>
								}
							>
								<ScrollableList
									items={props.schedules}
									itemKey={(entry) => String(entry.id)}
									selectedIndex={selected()}
									onSelect={setSelected}
									availableLines={12}
									estimatedItemHeight={3}
									showScrollIndicator={false}
									renderItem={(entry, selectedRow, index) =>
										renderRow(
											() => entry,
											selectedRow,
											() => index,
										)
									}
									renderReactiveItem={renderRow}
								/>
							</Show>
						</Show>
					}
				>
					{(target) => <ScheduleDetail schedule={target()} />}
				</Show>
			</Show>
			<Show when={pendingDelete()} keyed>
				{(confirmation) => (
					<box flexDirection="column">
						<text fg={uiColors.warning}>
							Delete {confirmation.id}? Future timing is removed; an admitted
							task is untouched.
						</text>
						<text fg={uiColors.textMuted}>y/Enter confirms · Esc cancels</text>
					</box>
				)}
			</Show>
			<Show when={!draft() && !pendingDelete()}>
				<ActionHeader
					scope={[props.schedules, ready()]}
					interactive={ready()}
					onActivate={() => {
						if (ready()) openEditor();
					}}
				>
					<text fg={uiColors.accent}>n New schedule</text>
				</ActionHeader>
			</Show>
		</box>
	);

	function ScheduleDetail(props_: { schedule: Data }) {
		const target = () => props_.schedule;
		const invocation = () =>
			(target().invocation && typeof target().invocation === "object"
				? (target().invocation as Data)
				: {}) as Data;
		const history = () =>
			Array.isArray(target().history) ? (target().history as Data[]) : [];
		return (
			<box flexDirection="column" gap={1}>
				<text fg={uiColors.primary}>
					{String(target().id)} · {String(target().state)} · revision{" "}
					{String(target().revision)}
				</text>
				<text wrapMode="word">{describe(target())}</text>
				<text wrapMode="word" fg={uiColors.textMuted}>
					{describeTiming(target())}
				</text>
				<For each={Object.keys(invocation())}>
					{(key) => (
						<text wrapMode="word" fg={uiColors.textSecondary}>
							{key}: {String(invocation()[key])}
						</text>
					)}
				</For>
				<Show when={target().lastError}>
					<text wrapMode="word" fg={uiColors.warning}>
						Last error: {String(target().lastError)}
					</text>
				</Show>
				<text fg={uiColors.primary}>History</text>
				<Show
					when={history().length}
					fallback={<text fg={uiColors.textMuted}>No occurrences yet</text>}
				>
					<For each={history().slice(-20)}>
						{(entry) => (
							<text wrapMode="word" fg={uiColors.textSecondary}>
								{new Date(Number(entry.due)).toISOString()} ·{" "}
								{entry.task === null
									? "not admitted"
									: `task #${String(entry.task)}`}{" "}
								· {String(entry.result)}
							</text>
						)}
					</For>
				</Show>
				<ActionHeader
					scope={[target(), ready()]}
					interactive={ready()}
					onActivate={() => {
						void setState(target().state === "paused" ? "enabled" : "paused");
					}}
				>
					<text fg={uiColors.accent}>
						p {target().state === "paused" ? "Resume" : "Pause"} schedule
					</text>
				</ActionHeader>
				<ActionHeader
					scope={[target(), ready()]}
					interactive={ready()}
					onActivate={() => {
						if (ready())
							setPendingDelete({
								id: String(target().id),
								revision: Number(target().revision),
							});
					}}
				>
					<text fg={uiColors.warning}>d Delete schedule</text>
				</ActionHeader>
			</box>
		);
	}
}

const cur_isText = (kind: string | undefined) => kind === "text";

function describe(schedule: Data) {
	const invocation =
		schedule.invocation && typeof schedule.invocation === "object"
			? (schedule.invocation as Data)
			: {};
	const next =
		typeof schedule.nextDue === "number"
			? new Date(schedule.nextDue).toISOString()
			: "never";
	return `${invocation.skill ?? "?"} · ${invocation.profile ?? "?"} · next ${next}${
		schedule.lastError ? " · paused after an error" : ""
	}`;
}

function describeTiming(schedule: Data) {
	const timing =
		schedule.timing && typeof schedule.timing === "object"
			? (schedule.timing as Data)
			: {};
	if (timing.kind === "once")
		return `Once at ${new Date(Number(timing.at)).toISOString()}`;
	if (timing.kind === "interval")
		return `Every ${Math.round(Number(timing.everyMs) / 60_000)} minutes from ${new Date(Number(timing.anchor)).toISOString()}`;
	if (timing.kind === "calendar")
		return `Weekly on ${Array.isArray(timing.weekdays) ? timing.weekdays.join(",") : ""} at ${String(timing.hour).padStart(2, "0")}:${String(timing.minute).padStart(2, "0")} ${String(timing.timezone)}`;
	return schedule.lateGraceMs === null || schedule.lateGraceMs === undefined
		? "No timing supplied · missed occurrences run late"
		: `No timing supplied · missed occurrences expire after ${Math.round(Number(schedule.lateGraceMs) / 60_000)} minutes`;
}
