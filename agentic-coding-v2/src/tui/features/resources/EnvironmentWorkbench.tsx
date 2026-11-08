/** @jsxImportSource @opentui/solid */
import type { TextareaRenderable } from "@opentui/core";
import { createEffect, createSignal, onCleanup, Show } from "solid-js";
import {
	type EnvironmentCandidate,
	type EnvironmentMutation,
	type EnvironmentRead,
	environmentMutations,
	environmentReads,
} from "../../../protocol/environment-workbench.ts";
import { record } from "../../../protocol/index.ts";
import type { ClientConnection } from "../../client/connection.ts";
import { ActionHeader } from "../../ui/ActionHeader.tsx";
import { editorKeybinds, textareaBindings } from "../../ui/keybinds.ts";
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
		[operationFocused, setOperationFocused] = createSignal(false),
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
	createEffect(() => {
		props.resource;
		props.connected;
		invalidate();
		setEditing(false);
		setOperationFocused(false);
		setConfirmationFocused(false);
		setResult(null);
		props.edit(false);
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
		setEditing(value);
		setOperationFocused(false);
		setConfirmationFocused(false);
		props.edit(value);
	};
	const execute = async (apply = false) => {
		if (pending() || !props.connected) return;
		const revision = epoch;
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
				value = await props.client.call("environment.apply", {
					id: sealed.id,
					approval: `approve:${sealed.digest}`,
				});
			} else {
				const selection = record(JSON.parse(body()));
				if (mode() === "read")
					value = await props.client.call("environment.inspect", {
						operation: read(),
						selection,
					});
				else {
					const sealed = await props.client.call("environment.preview", {
						operation: mutation(),
						body: selection,
					});
					if (!disposed && revision === epoch) setCandidate(sealed);
					value = {
						state: "preview-only",
						digest: sealed.digest,
						expiresAt: sealed.expiresAt,
					};
				}
			}
			if (!disposed && revision === epoch) setResult(value);
		} catch (cause) {
			if (!disposed && revision === epoch)
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
					invalidate();
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
			<ActionHeader
				onActivate={() => {
					edit(false);
					setOperationFocused(true);
					props.edit(true);
				}}
			>
				<text fg={color("accent")}>Choose native operation</text>
			</ActionHeader>
			<select
				height={5}
				options={(mode() === "read"
					? environmentReads
					: environmentMutations
				).map((value) => ({ name: value, description: "", value }))}
				focused={
					props.focused && props.editing && operationFocused() && !pending()
				}
				onSelect={(_index, option) => {
					if (typeof option?.value === "string") switchOperation(option.value);
				}}
			/>
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
				focused={props.focused && props.editing && editing() && !pending()}
				keyBindings={textareaBindings(editorKeybinds)}
				onMouseDown={() => edit(true)}
				onContentChange={(value) => {
					const next =
						typeof value === "string" ? value : (editor?.plainText ?? "");
					if (next !== body()) {
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
							: "Seal preview only (no native mutation)"}
					</text>
				</ActionHeader>
			</Show>
			<Show when={candidate()}>
				{(sealed) => (
					<box flexDirection="column" gap={1}>
						<text wrapMode="word" fg={color("warning")}>
							Exact immutable intention · {sealed().digest} · expires{" "}
							{sealed().expiresAt} (epoch ms)
						</text>
						<text wrapMode="word">{sealed().snapshot}</text>
						<ActionHeader
							onActivate={() => {
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
							onInput={setConfirmation}
							focused={
								props.focused &&
								props.editing &&
								confirmationFocused() &&
								!pending()
							}
							onMouseDown={() => {
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
