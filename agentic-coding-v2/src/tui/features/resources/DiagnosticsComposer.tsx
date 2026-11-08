/** @jsxImportSource @opentui/solid */
import {
	createEffect,
	createMemo,
	createSignal,
	For,
	onCleanup,
	Show,
	useContext,
} from "solid-js";
import type { Data, Session } from "../../../protocol/index.ts";
import { ActionHeader } from "../../ui/ActionHeader.tsx";
import { LocalChoiceContext } from "../../ui/LocalChoice.ts";
import { LocalJsonEditor } from "../../ui/LocalJsonEditor.tsx";
import { SuppliedRecordWindow } from "../../ui/SuppliedRecordWindow.tsx";
import { color } from "../../ui/theme/index.ts";

export type DiagnosticDraft = {
	task: string;
	kind: "http" | "sql";
	app: string;
	target: string;
	body: string;
};
/** Protected local input only. The chosen owner must still be unique, supplied,
 * writable and a workspace-write task when preparing an UNSENT request. */
export function DiagnosticsComposer(props: {
	memory: DiagnosticDraft;
	remember: (draft: DiagnosticDraft) => void;
	tasks: Data[];
	sessions: Session[];
	connected: boolean;
	fresh: boolean;
	focused: boolean;
	editing: boolean;
	edit: (value: boolean) => void;
	prepare: (conversation: number, content: string) => boolean;
}) {
	const choices = useContext(LocalChoiceContext);
	const [draft, setDraft] = createSignal<DiagnosticDraft>({ ...props.memory });
	const [error, setError] = createSignal<string | null>(null);
	const [field, setField] = createSignal<"app" | "target" | "body">("body");
	const [editing, setEditing] = createSignal(false);
	let disposed = false;
	const active = () => !disposed && (choices?.interactive() ?? true);
	createEffect(() => {
		if (!disposed) props.remember(draft());
	});
	onCleanup(() => {
		disposed = true;
		props.edit(false);
	});
	const catalog = createMemo(() => ({
		tasks: props.tasks,
		sessions: props.sessions,
	}));
	const owners = createMemo(() =>
		props.sessions.filter((session) => {
			if (
				!session.writable ||
				!Number.isSafeInteger(session.id) ||
				session.id <= 0 ||
				session.task === null ||
				!Number.isSafeInteger(session.task) ||
				session.task <= 0
			)
				return false;
			const task = props.tasks.filter((entry) => entry.id === session.task);
			return (
				task.length === 1 &&
				task[0]?.skill === "workspace-write" &&
				props.sessions.filter((entry) => entry.id === session.id).length ===
					1 &&
				props.sessions.filter(
					(entry) => entry.task === session.task && entry.writable,
				).length === 1
			);
		}),
	);
	const ownerMember = (session: Session) =>
		owners().some((entry) => entry === session);
	const selectOwner = (session: Session) => {
		if (disposed || !props.connected || !props.fresh || !ownerMember(session))
			return false;
		setDraft({ ...draft(), task: String(session.task) });
		setError(null);
		setEditing(false);
		props.edit(false);
		return true;
	};
	const scope = createMemo(() => [
		catalog(),
		draft(),
		field(),
		editing(),
		props.connected,
		props.fresh,
		props.focused,
		props.editing,
	]);
	const enter = (name: "app" | "target" | "body") => {
		if (!active()) return;
		setField(name);
		setEditing(true);
		props.edit(true);
	};
	const finish = () => {
		if (!active()) return;
		setEditing(false);
		props.edit(false);
	};
	const prepare = () => {
		if (!active() || !props.connected || !props.fresh) return;
		const value = draft();
		const sessions = owners().filter(
			(session) => String(session.task) === value.task,
		);
		if (
			sessions.length !== 1 ||
			!value.app.trim() ||
			!value.target.trim() ||
			!value.body.trim()
		) {
			setError(
				"Choose an exact unique writable workspace-write owner and supply the requiring app, endpoint/infrastructure ident and path/SQL. Nothing submitted.",
			);
			return;
		}
		const session = sessions[0];
		if (!session || !ownerMember(session)) return;
		const content =
			value.kind === "http"
				? `Prepare an owned read-only environment HTTP operation for app ${JSON.stringify(value.app.trim())}, endpoint ${JSON.stringify(value.target.trim())}, method GET, path ${JSON.stringify(value.body)}. Resolve the exact currently held native run, display the masked snapshot and wait for exact human approve:<digest>. Do not start an app, obtain credentials, follow redirects or execute until reviewed. If no currently held matching run exists, refuse.`
				: `Prepare an owned read-only PostgreSQL operation for requiring app ${JSON.stringify(value.app.trim())}, infrastructure ${JSON.stringify(value.target.trim())}, SQL source ${JSON.stringify(value.body)}. Resolve the exact currently held native run and configured query connection, display the masked snapshot and wait for exact human approve:<digest>. Do not start infrastructure, obtain credentials or execute until reviewed. If no currently held matching run exists, refuse.`;
		if (props.prepare(session.id, content)) {
			setEditing(false);
			props.edit(false);
			setError(
				"Request prepared but not submitted. Credentials stay in native environment references; exact reviewed worker-tool approval remains required.",
			);
		}
	};
	return (
		<box
			flexDirection="column"
			gap={1}
			border={["top"]}
			borderColor={color("border")}
			paddingTop={1}
		>
			<text fg={color("primary")}>
				Protected read-only diagnostics composer
			</text>
			<text wrapMode="word" fg={color("textMuted")}>
				No backend request on navigation, editor focus or selection. This only
				prepares an unsent request in an existing owned workspace-write
				conversation. Draft stays local, outside input history, bookmarks and
				viewpoints.
			</text>
			<Show when={!props.connected || !props.fresh}>
				<text fg={color("warning")}>
					Cached ownership or disconnected client; owner selection and request
					preparation unavailable. Local text remains editable.
				</text>
			</Show>
			<SuppliedRecordWindow
				rows={owners()}
				scope={catalog()}
				label="eligible diagnostic owners"
				title={(session) =>
					`task #${String(session.task)} · conversation #${session.id} · ${session.title}`
				}
				search={(session) => JSON.stringify(session)}
				pick={selectOwner}
			>
				{(session) => (
					<ActionHeader
						scope={scope()}
						interactive={active() && props.connected && props.fresh}
						onActivate={() => {
							if (active()) selectOwner(session);
						}}
					>
						<text fg={color("accent")}>
							Choose supplied owner task #{String(session.task)} / conversation
							#{session.id}
							{String(session.task) === draft().task ? " (selected)" : ""}
						</text>
					</ActionHeader>
				)}
			</SuppliedRecordWindow>
			<Show when={!owners().length}>
				<text fg={color("warning")}>
					No unique writable workspace-write task/conversation owner supplied.
					Nothing will be submitted or automatically created.
				</text>
			</Show>
			<ActionHeader
				scope={scope()}
				interactive={active()}
				onActivate={() => {
					if (!active()) return;
					setDraft({
						...draft(),
						kind: draft().kind === "http" ? "sql" : "http",
					});
					setError(null);
				}}
			>
				<text fg={color("accent")}>
					Operation:{" "}
					{draft().kind === "http"
						? "reviewed HTTP GET"
						: "reviewed PostgreSQL SELECT/WITH"}{" "}
					· switch locally
				</text>
			</ActionHeader>
			<For each={["app", "target", "body"] as const}>
				{(name) => (
					<ActionHeader
						scope={scope()}
						interactive={active()}
						onActivate={() => enter(name)}
					>
						<text wrapMode="word">
							Edit{" "}
							{name === "target"
								? "exact endpoint / infrastructure ident"
								: name === "body"
									? "origin-relative path / SQL source"
									: "exact requiring app ident"}
							:{" "}
							{name === "body"
								? `${draft()[name].length} UTF-16 units`
								: draft()[name] || "unset"}
						</text>
					</ActionHeader>
				)}
			</For>
			<Show when={editing()}>
				<LocalJsonEditor
					value={draft()[field()]}
					scope={`diagnostic:${draft().task}:${draft().kind}:${field()}`}
					editing={props.focused && props.editing && editing()}
					interactive={active()}
					height={8}
					maxLength={20000}
					onLimit={() =>
						setError(
							"Local field limit is 20000 UTF-16 units; previous exact draft retained.",
						)
					}
					enter={() => enter(field())}
					change={(value) => {
						if (active() && editing()) {
							setDraft({ ...draft(), [field()]: value });
							setError(null);
						}
					}}
				/>
				<ActionHeader
					scope={scope()}
					interactive={active()}
					onActivate={finish}
				>
					<text fg={color("accent")}>
						Finish editing (no read, dispatch or approval)
					</text>
				</ActionHeader>
			</Show>
			<ActionHeader
				scope={scope()}
				interactive={active() && props.connected && props.fresh}
				onActivate={prepare}
			>
				<text fg={color("accent")}>
					Prepare unsent request in exact selected owner's conversation
				</text>
			</ActionHeader>
			<ActionHeader
				scope={scope()}
				interactive={active()}
				onActivate={() => {
					if (!active()) return;
					setDraft({ task: "", kind: "http", app: "", target: "", body: "" });
					setEditing(false);
					props.edit(false);
					setError(null);
				}}
			>
				<text fg={color("textMuted")}>Discard protected diagnostic draft</text>
			</ActionHeader>
			<Show when={error()}>
				<text fg={color("warning")}>{error()}</text>
			</Show>
		</box>
	);
}
