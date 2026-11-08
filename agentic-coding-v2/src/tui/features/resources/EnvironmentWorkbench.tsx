/** @jsxImportSource @opentui/solid */
import type { TextareaRenderable } from "@opentui/core";
import {
	createEffect,
	createMemo,
	createSignal,
	type JSX,
	onCleanup,
	Show,
	untrack,
} from "solid-js";
import {
	type EnvironmentCandidate,
	type EnvironmentMutation,
	type EnvironmentRead,
	environmentMutations,
	environmentReads,
} from "../../../protocol/environment-workbench.ts";
import { type Data, record } from "../../../protocol/index.ts";
import type { ClientConnection } from "../../client/connection.ts";
import { dataList } from "../../client/connection.ts";
import { ActionHeader as NativeActionHeader } from "../../ui/ActionHeader.tsx";
import { editorKeybinds, textareaBindings } from "../../ui/keybinds.ts";
import type { LocalChoice } from "../../ui/LocalChoice.ts";
import { StructuredData } from "../../ui/StructuredData.tsx";
import { color } from "../../ui/theme/index.ts";
import { TelemetryView } from "./TelemetryView.tsx";
import { mutationFields, readFields } from "./workbench-fields.ts";
/** Ephemeral workbench. Nothing is persisted to navigation/history/viewpoints.
 * Only explicit submission invokes a native boundary. */
export type WorkbenchMemory = {
	body: string;
	mode: "read" | "write";
	read: EnvironmentRead;
	mutation: EnvironmentMutation;
};
export function EnvironmentWorkbench(props: {
	scope: object;
	interactive: boolean;
	fresh: boolean;
	projects: Data[];
	choose: (choice: LocalChoice) => void;
	memory: WorkbenchMemory;
	remember: (value: WorkbenchMemory) => void;
	focused: boolean;
	editing: boolean;
	client: ClientConnection;
	connected: boolean;
	resource: string | null;
	edit: (value: boolean) => void;
}) {
	const [mode, setMode] = createSignal<"read" | "write">(props.memory.mode),
		[read, setRead] = createSignal<EnvironmentRead>(props.memory.read),
		[mutation, setMutation] = createSignal<EnvironmentMutation>(
			props.memory.mutation,
		),
		[body, setBody] = createSignal(props.memory.body),
		[candidate, setCandidate] = createSignal<EnvironmentCandidate | null>(null),
		[confirmation, setConfirmation] = createSignal(""),
		[result, setResult] = createSignal<unknown>(null),
		[error, setError] = createSignal<string | null>(null),
		[pending, setPending] = createSignal(false),
		[editing, setEditing] = createSignal(false),
		[confirmationFocused, setConfirmationFocused] = createSignal(false);
	let editor: TextareaRenderable | undefined,
		epoch = 0,
		disposed = false;
	createEffect(() =>
		props.remember({
			body: body(),
			mode: mode(),
			read: read(),
			mutation: mutation(),
		}),
	);
	const invalidate = () => {
		epoch++;
		setCandidate(null);
		setConfirmation("");
	};
	const source = createMemo(
		() => ({
			resource: props.resource,
			connected: props.connected,
			client: props.client,
			scope: props.scope,
		}),
		undefined,
		{
			equals: (left, right) =>
				left.resource === right.resource &&
				left.connected === right.connected &&
				left.client === right.client &&
				left.scope === right.scope,
		},
	);
	createEffect(() => {
		source();
		invalidate();
		setEditing(false);
		setConfirmationFocused(false);
		setResult(null);
		untrack(() => props.edit(false));
	});
	createEffect(() => {
		const value = body();
		if (editor && editor.plainText !== value) editor.setText(value);
	});
	onCleanup(() => {
		disposed = true;
		epoch++;
		props.edit(false);
	});
	const edit = (value: boolean) => {
		if (value && (!props.interactive || pending() || disposed)) return;
		setEditing(value);
		setConfirmationFocused(false);
		props.edit(value);
	};
	const execute = async (apply = false) => {
		if (pending() || !props.connected || !props.interactive || disposed) return;
		const revision = epoch,
			client = props.client,
			scope = props.scope;
		const current = () =>
			!disposed &&
			revision === epoch &&
			props.client === client &&
			props.scope === scope &&
			props.connected;
		setPending(true);
		setError(null);
		edit(false);
		let attempted = false;
		try {
			let value: unknown;
			if (apply) {
				const sealed = candidate();
				if (
					!sealed ||
					confirmation() !== `approve:${sealed.digest}` ||
					sealed.expiresAt <= Date.now()
				)
					throw new Error(
						"Manually enter the exact unexpired snapshot confirmation",
					);
				setCandidate(null);
				setConfirmation("");
				attempted = true;
				value = await client.call("environment.apply", {
					id: sealed.id,
					approval: `approve:${sealed.digest}`,
				});
			} else {
				const selection = record(JSON.parse(body()));
				if (mode() === "read")
					value = await client.call("environment.inspect", {
						operation: read(),
						selection,
					});
				else {
					const sealed = await client.call("environment.preview", {
						operation: mutation(),
						body: selection,
					});
					if (current()) setCandidate(sealed);
					value = {
						state:
							"sealed-text-only; native payload validation occurs on explicitly approved application",
						digest: sealed.digest,
						expiresAt: sealed.expiresAt,
					};
				}
			}
			if (current()) setResult(value);
		} catch (cause) {
			if (current())
				setError(
					`${cause instanceof Error ? cause.message : "Environment request refused"}${attempted ? ". This local intention is consumed; effects may be uncertain. Inspect native receipts/live state before any separately approved new intention. No automatic retry." : ""}`,
				);
		} finally {
			if (!disposed) setPending(false);
		}
	};
	const switchOperation = (value: string) => {
		invalidate();
		setError(null);
		setResult(null);
		edit(false);
		if (
			mode() === "read" &&
			environmentReads.includes(value as EnvironmentRead)
		)
			setRead(value as EnvironmentRead);
		if (
			mode() === "write" &&
			environmentMutations.includes(value as EnvironmentMutation)
		)
			setMutation(value as EnvironmentMutation);
	};
	const controlScope = createMemo(() => [
		source(),
		mode(),
		read(),
		mutation(),
		body(),
		candidate()?.id,
		pending(),
		props.interactive,
	]);
	const ActionHeader = (action: {
		onActivate: () => void;
		children: JSX.Element;
	}) => (
		<NativeActionHeader
			scope={controlScope()}
			interactive={props.interactive && !pending()}
			onActivate={action.onActivate}
		>
			{action.children}
		</NativeActionHeader>
	);
	const operationChoice = () => {
		if (!props.interactive || pending()) return;
		const version = epoch,
			scope = props.scope,
			selectedMode = mode(),
			text = body();
		const operations =
			selectedMode === "read" ? environmentReads : environmentMutations;
		const valid = () =>
			!disposed &&
			epoch === version &&
			props.scope === scope &&
			mode() === selectedMode &&
			body() === text &&
			!pending();
		props.choose({
			title: "Choose native environment operation",
			rows: operations.map((value) => ({
				key: value,
				label: value,
				detail:
					selectedMode === "read"
						? readFields[value as EnvironmentRead]
						: mutationFields[value as EnvironmentMutation],
			})),
			initialKey: selectedMode === "read" ? read() : mutation(),
			note: "Local selection only · no inspection, preview or application",
			valid,
			choose: (key) => {
				if (!valid() || !operations.some((value) => value === key))
					return false;
				switchOperation(key);
				return true;
			},
		});
	};
	const supportsApp = () =>
		mode() === "read"
			? ["logs", "telemetry"].includes(read())
			: ["capture-base", "save-source", "remove-source", "preflight"].includes(
					mutation(),
				);
	const bodyChoice = (field: "app" | "target") => {
		if (!props.interactive || pending() || !props.fresh || !supportsApp())
			return;
		try {
			const selection = record(JSON.parse(body())),
				text = body(),
				scope = props.scope,
				version = epoch;
			const projects = props.projects.filter(
				(row) =>
					typeof row.id === "string" &&
					row.id.length > 0 &&
					!/\s/.test(row.id) &&
					props.projects.filter((entry) => entry.id === row.id).length === 1,
			);
			const project = projects.find((row) => row.id === selection.app);
			const values =
				field === "app"
					? projects
					: dataList(project?.targets).filter(
							(row, _index, rows) =>
								typeof row.id === "string" &&
								row.id.length > 0 &&
								!/\s/.test(row.id) &&
								rows.filter((entry) => entry.id === row.id).length === 1,
						);
			const signature = JSON.stringify(values);
			const valid = () =>
				!disposed &&
				epoch === version &&
				props.scope === scope &&
				body() === text &&
				props.fresh &&
				(field === "app" ||
					!project ||
					(props.projects.filter((row) => row.id === project.id).length === 1 &&
						JSON.stringify(
							props.projects.find((row) => row.id === project.id),
						) === JSON.stringify(project))) &&
				!pending() &&
				JSON.stringify(
					field === "app"
						? props.projects.filter((row) =>
								projects.some((entry) => entry.id === row.id),
							)
						: dataList(
								props.projects.find((row) => row.id === selection.app)?.targets,
							).filter((row) => values.some((entry) => entry.id === row.id)),
				) === signature;
			props.choose({
				title:
					field === "app"
						? "Choose supplied native app"
						: "Choose supplied native target",
				rows: values.map((row) => ({
					key: String(row.id),
					label: String(row.id),
					detail:
						field === "app"
							? String(row.repository ?? row.kind)
							: `${String(row.action)} · ${String(row.runtime)} · profile: ${String(row.profile ?? "not supplied")}`,
				})),
				initialKey:
					typeof selection[field] === "string"
						? (selection[field] as string)
						: undefined,
				note: "Edit local JSON only · other revision/digest/approval fields remain unvalidated",
				valid,
				choose: (key) => {
					if (!valid() || !values.some((row) => row.id === key)) return false;
					const next = { ...selection, [field]: key };
					if (field === "app" && key !== selection.app) delete next.target;
					invalidate();
					setResult(null);
					setError(null);
					setBody(JSON.stringify(next, null, 2));
					edit(false);
					return true;
				},
			});
		} catch {
			setError(
				"Local JSON must be an object before choosing supplied app/target fields",
			);
		}
	};
	return (
		<box flexDirection="column" gap={1} border={true} padding={1}>
			<text fg={color("primary")}>
				Native environment authoring & diagnostics workbench
			</text>
			<text wrapMode="word" fg={color("warning")}>
				Explicit reads only; no probe on navigation. Staging is inert private
				text, not deployment. Preflight, promotion, revocation and cleanup
				retain their native ownership/revision/inspection/approval fences. A UI
				snapshot approval does not replace the native promotion approval in the
				payload. No credentials in drafts. No implicit restart, release or
				retry.
			</text>
			<ActionHeader
				onActivate={() => {
					if (!props.interactive || pending()) return;
					invalidate();
					setResult(null);
					setError(null);
					edit(false);
					setMode((value) => (value === "read" ? "write" : "read"));
				}}
			>
				<text fg={color("accent")}>
					{mode() === "read"
						? "Read-only diagnostics / records · switch to authoring"
						: "Authoring intention · switch to read-only"}
				</text>
			</ActionHeader>
			<ActionHeader onActivate={operationChoice}>
				<text fg={color("accent")}>
					Choose native operation · {mode() === "read" ? read() : mutation()}
				</text>
			</ActionHeader>
			<Show when={supportsApp()}>
				<ActionHeader onActivate={() => bodyChoice("app")}>
					<text fg={color("accent")}>Choose supplied app into local JSON</text>
				</ActionHeader>
				<Show when={mode() === "write"}>
					<ActionHeader onActivate={() => bodyChoice("target")}>
						<text fg={color("accent")}>
							Choose supplied target/profile bundle into local JSON
						</text>
					</ActionHeader>
				</Show>
			</Show>
			<text wrapMode="word" fg={color("textMuted")}>
				{mode() === "read" ? readFields[read()] : mutationFields[mutation()]}
			</text>
			<text wrapMode="word">
				Selected {mode() === "read" ? read() : mutation()} · JSON{" "}
				{mode() === "read" ? "selection" : "native payload"} (unknown fields
				refused). Lists use {"{}"}; record reads use {'{"id":"…"}'}; discovery
				uses repository/directory; logs use app/options; telemetry uses
				app/run/options; history uses run/operation/cursor. Save uses
				requestId/content with id/revision only for edits. Other native
				intentions require their exact revision/digest/inspection fields.
			</text>
			<ActionHeader onActivate={() => edit(!editing())}>
				<text fg={color("accent")}>
					{editing() ? "Leave local editor" : "Edit local JSON"}
				</text>
			</ActionHeader>
			<textarea
				ref={(value) => {
					editor = value;
				}}
				initialValue={body()}
				height={9}
				focused={
					props.focused &&
					props.editing &&
					editing() &&
					!pending() &&
					props.interactive
				}
				keyBindings={textareaBindings(editorKeybinds)}
				onMouseDown={() => edit(true)}
				onContentChange={(value) => {
					const next =
						typeof value === "string" ? value : (editor?.plainText ?? "");
					if (props.interactive && editing() && next !== body()) {
						setResult(null);
						setError(null);
						invalidate();
						setBody(next);
					}
				}}
			/>
			<Show when={props.connected && !pending()}>
				<ActionHeader onActivate={() => void execute()}>
					<text fg={color("accent")}>
						{mode() === "read"
							? "Submit explicit native read"
							: "Seal exact text only (no payload validation or native mutation)"}
					</text>
				</ActionHeader>
			</Show>
			<Show when={candidate()}>
				{(sealed) => (
					<box flexDirection="column" gap={1}>
						<text wrapMode="word" fg={color("warning")}>
							Exact immutable, unvalidated intention · {sealed().digest} ·
							expires {sealed().expiresAt} (epoch ms)
						</text>
						<text wrapMode="word">{sealed().snapshot}</text>
						<ActionHeader
							onActivate={() => {
								if (!props.interactive || pending()) return;
								edit(false);
								setConfirmationFocused(true);
								props.edit(true);
							}}
						>
							<text fg={color("accent")}>Focus exact approval input</text>
						</ActionHeader>
						<input
							value={confirmation()}
							placeholder="Manually type approve:DIGEST"
							maxLength={80}
							onInput={(value) => {
								if (props.interactive && confirmationFocused() && !pending())
									setConfirmation(value);
							}}
							focused={
								props.focused &&
								props.editing &&
								confirmationFocused() &&
								!pending() &&
								props.interactive
							}
							onMouseDown={() => {
								if (!props.interactive || pending()) return;
								edit(false);
								setConfirmationFocused(true);
								props.edit(true);
							}}
							onSubmit={() => edit(false)}
						/>
						<Show when={props.connected && !pending()}>
							<ActionHeader onActivate={() => void execute(true)}>
								<text fg={color("warning")}>
									Submit one explicitly confirmed native intention
								</text>
							</ActionHeader>
						</Show>
					</box>
				)}
			</Show>
			<Show when={pending()}>
				<text fg={color("warning")}>
					Native request pending; not proof of execution or completion
				</text>
			</Show>
			<Show when={error()}>
				<text fg={color("error")} wrapMode="word">
					{error()}
				</text>
			</Show>
			<Show when={result() !== null}>
				<Show
					when={
						mode() === "read" &&
						read() === "telemetry" &&
						typeof result() === "object"
					}
					fallback={
						<StructuredData
							value={result()}
							label="Last explicitly requested native observation / acknowledgement"
						/>
					}
				>
					<TelemetryView value={result()} />
				</Show>
			</Show>
		</box>
	);
}
