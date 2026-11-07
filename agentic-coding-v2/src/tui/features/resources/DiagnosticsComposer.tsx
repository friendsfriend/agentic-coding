/** @jsxImportSource @opentui/solid */
import type { TextareaRenderable } from "@opentui/core";
import { createEffect, createSignal, For, onCleanup, Show } from "solid-js";
import type { Data, Session } from "../../../protocol/index.ts";
import { ActionHeader } from "../../ui/ActionHeader.tsx";
import { editorKeybinds, textareaBindings } from "../../ui/keybinds.ts";
import { color } from "../../ui/theme/index.ts";
export type DiagnosticDraft = {
	task: string;
	kind: "http" | "sql";
	app: string;
	target: string;
	body: string;
};
/** Compose only: actual HTTP/SQL remains the owning worker's separately reviewed tool. */
export function DiagnosticsComposer(props: {
	memory: DiagnosticDraft;
	remember: (value: DiagnosticDraft) => void;
	tasks: Data[];
	sessions: Session[];
	connected: boolean;
	focused: boolean;
	editing: boolean;
	edit: (value: boolean) => void;
	prepare: (conversation: number, content: string) => void;
}) {
	const [draft, setDraft] = createSignal(props.memory),
		[editing, setEditing] = createSignal(false),
		[field, setField] = createSignal<"app" | "target" | "body">("body"),
		[error, setError] = createSignal<string | null>(null);
	let editor: TextareaRenderable | undefined;
	createEffect(() => props.remember(draft()));
	createEffect(() => {
		const value = draft()[field()];
		if (editor && editor.plainText !== value) editor.setText(value);
	});
	createEffect(() => {
		if (!props.connected) {
			setEditing(false);
			props.edit(false);
		}
	});
	onCleanup(() => props.edit(false));
	const prepare = () => {
		try {
			const value = draft(),
				task = props.tasks.find((task) => String(task.id) === value.task),
				session = props.sessions.find(
					(session) => String(session.task) === value.task && session.writable,
				);
			if (
				!props.connected ||
				!task ||
				!session ||
				task.policy !== "workspace-write"
			)
				throw new Error(
					"Select a currently writable native workspace-write task; unavailable owners are never adopted or replaced",
				);
			if (
				!value.app.trim() ||
				!value.target.trim() ||
				value.app.length > 64 ||
				value.target.length > 64 ||
				!value.body.trim() ||
				value.body.length > (value.kind === "http" ? 2048 : 20000)
			)
				throw new Error(
					"Explicit app, endpoint/infra and bounded path/query required",
				);
			if (
				value.kind === "http" &&
				(!value.body.startsWith("/") || value.body.startsWith("//"))
			)
				throw new Error(
					"HTTP input must be an origin-relative path, never a URL",
				);
			const args =
				value.kind === "http"
					? { app: value.app, endpoint: value.target, path: value.body }
					: { app: value.app, infra: value.target, sql: value.body, limit: 50 };
			setEditing(false);
			props.edit(false);
			setError(null);
			props.prepare(
				session.id,
				`Diagnostic request for your own existing task scope only. Use ${value.kind === "http" ? "env_http_get" : "db_query"} with exactly ${JSON.stringify(args)}. This message is not approval: request and wait for the native human review of the exact operation. Refuse if you do not own the exact live app and required infrastructure; do not start, restart, release, adopt, discover credentials or substitute another owner/run. Do not retry an uncertain issuance. Retain the bounded native receipt and explain any refusal.`,
			);
		} catch (error) {
			setError(
				error instanceof Error
					? error.message
					: "Diagnostic preparation refused",
			);
		}
	};
	return (
		<box
			flexDirection="column"
			gap={1}
			border={true}
			borderColor={color("border")}
			padding={1}
		>
			<text fg={color("primary")}>
				Owner-scoped HTTP / SQL diagnostic composer
			</text>
			<text wrapMode="word" fg={color("textMuted")}>
				Unsent memory-only draft. Selecting an owner never probes or takes over
				its lease. Prepare moves a request into that native worker's
				conversation; explicit submission and a separate immutable human review
				still apply. READ ONLY / GET is not proof of no external effects. No
				credentials belong in these fields.
			</text>
			<For
				each={props.sessions.filter(
					(session) => session.task !== null && session.writable,
				)}
			>
				{(session) => (
					<ActionHeader
						onActivate={() => {
							setDraft({ ...draft(), task: String(session.task) });
							setError(null);
						}}
					>
						<text
							fg={
								String(session.task) === draft().task
									? color("accent")
									: color("textMuted")
							}
						>
							Task {session.task} · {session.title}{" "}
							{String(session.task) === draft().task ? "(selected)" : ""}
						</text>
					</ActionHeader>
				)}
			</For>
			<Show
				when={
					!props.sessions.some(
						(session) => session.task !== null && session.writable,
					)
				}
			>
				<text fg={color("warning")}>
					No writable native task owner. Nothing will be submitted or
					automatically created.
				</text>
			</Show>
			<ActionHeader
				onActivate={() =>
					setDraft({
						...draft(),
						kind: draft().kind === "http" ? "sql" : "http",
					})
				}
			>
				<text fg={color("accent")}>
					Operation:{" "}
					{draft().kind === "http"
						? "reviewed HTTP GET"
						: "reviewed PostgreSQL SELECT/WITH"}{" "}
					· switch
				</text>
			</ActionHeader>
			<For each={["app", "target", "body"] as const}>
				{(name) => (
					<ActionHeader
						onActivate={() => {
							setField(name);
							setEditing(true);
							props.edit(true);
						}}
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
								? `${draft()[name].length} characters`
								: draft()[name] || "unset"}
						</text>
					</ActionHeader>
				)}
			</For>
			<Show when={editing()}>
				<textarea
					ref={(value) => {
						editor = value;
						value.setText(draft()[field()]);
					}}
					minHeight={3}
					height={8}
					focused={props.focused && props.editing && editing()}
					keyBindings={textareaBindings(editorKeybinds)}
					onContentChange={() => {
						const value = editor?.plainText ?? draft()[field()];
						if (value.length <= 20000)
							setDraft({ ...draft(), [field()]: value });
						else editor?.setText(draft()[field()]);
					}}
					onSubmit={() => {
						setEditing(false);
						props.edit(false);
					}}
				/>
				<ActionHeader
					onActivate={() => {
						setEditing(false);
						props.edit(false);
					}}
				>
					<text fg={color("accent")}>
						Finish editing (no read, dispatch or approval)
					</text>
				</ActionHeader>
			</Show>
			<ActionHeader onActivate={prepare}>
				<text fg={color("accent")}>
					Prepare unsent request in selected owner's conversation
				</text>
			</ActionHeader>
			<ActionHeader
				onActivate={() => {
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
