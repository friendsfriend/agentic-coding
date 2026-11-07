/** @jsxImportSource @opentui/solid */
import type { TextareaRenderable } from "@opentui/core";
import { createEffect, createSignal, onCleanup, Show } from "solid-js";
import type {
	SkillFileCandidate,
	SkillFileDocument,
} from "../../../protocol/index.ts";
import type { ClientConnection } from "../../client/connection.ts";
import { ActionHeader } from "../../ui/ActionHeader.tsx";
import { editorKeybinds, textareaBindings } from "../../ui/keybinds.ts";
import { color } from "../../ui/theme/index.ts";
export type SkillFileDraft = { name: string; content: string };
export function SkillFileEditor(props: {
	client: ClientConnection;
	selection: string | null;
	connected: boolean;
	focused: boolean;
	editing: boolean;
	edit: (value: boolean) => void;
	memory: SkillFileDraft;
	remember: (draft: SkillFileDraft) => void;
}) {
	const [document, setDocument] = createSignal<SkillFileDocument | null>(null),
		[candidate, setCandidate] = createSignal<SkillFileCandidate | null>(null),
		[approval, setApproval] = createSignal(""),
		[focus, setFocus] = createSignal<"name" | "content" | "approval" | null>(
			null,
		),
		[pending, setPending] = createSignal(false),
		[error, setError] = createSignal<string | null>(null),
		[receipt, setReceipt] = createSignal<string | null>(null);
	let epoch = 0,
		disposed = false,
		editor: TextareaRenderable | undefined;
	const invalidate = () => {
		epoch++;
		setCandidate(null);
		setApproval("");
		setReceipt(null);
	};
	let lastSelection = props.selection,
		lastConnected = props.connected;
	createEffect(() => {
		const selection = props.selection,
			connected = props.connected;
		if (selection === lastSelection && connected === lastConnected) return;
		lastSelection = selection;
		lastConnected = connected;
		invalidate();
		setDocument(null);
		setFocus(null);
		props.edit(false);
	});
	createEffect(() => {
		const content = props.memory.content;
		if (editor && editor.plainText !== content) editor.setText(content);
	});
	onCleanup(() => {
		disposed = true;
		epoch++;
		props.edit(false);
	});
	const chooseFocus = (value: "name" | "content" | "approval" | null) => {
		setFocus(value);
		props.edit(value !== null);
	};
	const change = (draft: SkillFileDraft) => {
		invalidate();
		setError(null);
		if (draft.name !== props.memory.name) setDocument(null);
		props.remember(draft);
	};
	const run = async (operation: "read" | "preview" | "apply") => {
		if (pending() || !props.connected) return;
		const generation = epoch,
			draft = { ...props.memory };
		setPending(true);
		setError(null);
		chooseFocus(null);
		let attempted = false;
		try {
			if (operation === "read") {
				if (draft.content.trim())
					throw new Error(
						"Discard the local draft explicitly before reading another file; it will not be overwritten",
					);
				const value = await props.client.call("skill-file.read", {
					name: draft.name,
				});
				if (!disposed && generation === epoch) {
					setDocument(value);
					props.remember({ name: value.name, content: value.content });
					setCandidate(null);
					setApproval("");
				}
			} else if (operation === "preview") {
				const base = document();
				if (!base || base.name !== draft.name)
					throw new Error(
						"Read the exact existing/missing destination before sealing a preview",
					);
				const value = await props.client.call("skill-file.preview", {
					name: draft.name,
					baseRevision: base.revision,
					content: draft.content,
				});
				if (!disposed && generation === epoch) {
					setCandidate(value);
					setApproval("");
				}
			} else {
				const sealed = candidate();
				if (
					!sealed ||
					approval() !== `approve:${sealed.digest}` ||
					sealed.expiresAt <= Date.now()
				)
					throw new Error(
						"Manually type the exact unexpired snapshot confirmation",
					);
				setCandidate(null);
				setApproval("");
				setDocument(null);
				attempted = true;
				const saved = await props.client.call("skill-file.apply", {
					id: sealed.id,
					approval: `approve:${sealed.digest}`,
				});
				if (!disposed && generation === epoch) {
					setDocument(null);
					setReceipt(
						`Saved ${saved.name} · byte revision ${saved.revision}. Running skills/tasks unchanged; restart separately authorized. Discard draft and explicitly read current disk before another edit.`,
					);
				}
			}
		} catch (cause) {
			if (!disposed && generation === epoch)
				setError(
					`${cause instanceof Error ? cause.message : "Skill operation refused"}${attempted ? ". One attempt consumed; file/directories may have changed. Inspect disk before any separately confirmed new intention; no automatic retry." : ""}`,
				);
		} finally {
			if (!disposed) setPending(false);
		}
	};
	return (
		<box flexDirection="column" border={true} padding={1} gap={1}>
			<text fg={color("primary")}>Native user skill file authoring</text>
			<text wrapMode="word" fg={color("warning")}>
				Configuration directory must already exist (native settings authoring
				can establish it). Fixed CONFIG_DIR/skills/slug/SKILL.md only;
				lower-case flat slugs, never system skills or arbitrary paths. Loaded
				catalog stays immutable. Writes require an exact manually confirmed
				snapshot and current file/directory identities; this does not reload,
				launch tasks, grant policy or restart. Memory-only drafts; no
				credentials in instructions. Symlink/hard-link/invalid UTF-8/Windows
				destinations refuse. Existing nested layouts remain loaded/read-only,
				not rewritten or adopted.
			</text>
			<ActionHeader onActivate={() => chooseFocus("name")}>
				<text fg={color("accent")}>Edit explicit user-skill slug</text>
			</ActionHeader>
			<input
				value={props.memory.name}
				maxLength={64}
				focused={
					props.focused && props.editing && focus() === "name" && !pending()
				}
				onInput={(name) => change({ ...props.memory, name })}
				onMouseDown={() => chooseFocus("name")}
				onSubmit={() => chooseFocus(null)}
			/>
			<Show when={props.connected && !pending()}>
				<ActionHeader onActivate={() => void run("read")}>
					<text fg={color("accent")}>
						Read exact current/missing destination (never overwrites a draft)
					</text>
				</ActionHeader>
			</Show>
			<Show when={document()}>
				<text wrapMode="word">
					Observed file revision {document()?.revision} · directory identity{" "}
					{document()?.directoryIdentity}; non-atomic disk observation, not the
					running catalog.
				</text>
			</Show>
			<ActionHeader
				onActivate={() => {
					invalidate();
					props.remember({ name: props.memory.name, content: "" });
					chooseFocus(null);
				}}
			>
				<text fg={color("warning")}>
					Explicitly discard local draft and confirmation
				</text>
			</ActionHeader>
			<ActionHeader
				onActivate={() => {
					if (props.memory.content.trim()) {
						setError("Existing draft preserved; discard explicitly first");
						return;
					}
					if (!/^[a-z][a-z0-9-]{0,63}$/.test(props.memory.name)) {
						setError("Choose an explicit supported slug first");
						return;
					}
					change({
						name: props.memory.name,
						content: `---\nname: ${props.memory.name}\ndescription: Describe this user skill\n---\n\nWrite instructions here. Task policy and shell approvals remain native.\n`,
					});
					chooseFocus("content");
				}}
			>
				<text fg={color("accent")}>
					Prepare local instruction template only
				</text>
			</ActionHeader>
			<ActionHeader onActivate={() => chooseFocus("content")}>
				<text fg={color("accent")}>Edit unsaved instruction text</text>
			</ActionHeader>
			<textarea
				ref={(value) => {
					editor = value;
				}}
				initialValue={props.memory.content}
				height={12}
				keyBindings={textareaBindings(editorKeybinds)}
				focused={
					props.focused && props.editing && focus() === "content" && !pending()
				}
				onMouseDown={() => chooseFocus("content")}
				onContentChange={(value) =>
					change({
						...props.memory,
						content:
							typeof value === "string" ? value : (editor?.plainText ?? ""),
					})
				}
			/>
			<Show when={props.connected && !pending()}>
				<ActionHeader onActivate={() => void run("preview")}>
					<text fg={color("accent")}>Seal immutable file preview only</text>
				</ActionHeader>
			</Show>
			<Show when={candidate()}>
				{(sealed) => (
					<box flexDirection="column" gap={1}>
						<text wrapMode="word" fg={color("warning")}>
							{sealed().snapshot} · digest {sealed().digest} · expires{" "}
							{sealed().expiresAt} epoch ms
						</text>
						<ActionHeader onActivate={() => chooseFocus("approval")}>
							<text fg={color("accent")}>
								Focus exact snapshot confirmation
							</text>
						</ActionHeader>
						<input
							value={approval()}
							maxLength={80}
							placeholder="Manually type approve:DIGEST"
							focused={
								props.focused &&
								props.editing &&
								focus() === "approval" &&
								!pending()
							}
							onInput={setApproval}
							onMouseDown={() => chooseFocus("approval")}
							onSubmit={() => chooseFocus(null)}
						/>
						<Show when={props.connected && !pending()}>
							<ActionHeader onActivate={() => void run("apply")}>
								<text fg={color("warning")}>
									Submit one explicitly confirmed skill-file write
								</text>
							</ActionHeader>
						</Show>
					</box>
				)}
			</Show>
			<Show when={receipt()}>
				<text wrapMode="word" fg={color("success")}>
					{receipt()}
				</text>
			</Show>
			<Show when={error()}>
				<text wrapMode="word" fg={color("error")}>
					{error()}
				</text>
			</Show>
			<Show when={pending()}>
				<text fg={color("textMuted")}>Native skill-file operation pending</text>
			</Show>
		</box>
	);
}
