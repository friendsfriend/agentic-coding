/** @jsxImportSource @opentui/solid */
import {
	createEffect,
	createMemo,
	createSignal,
	onCleanup,
	Show,
	useContext,
} from "solid-js";
import type {
	SkillFileCandidate,
	SkillFileDocument,
} from "../../../protocol/index.ts";
import type { ClientConnection } from "../../client/connection.ts";
import { ActionHeader } from "../../ui/ActionHeader.tsx";
import { LocalChoiceContext } from "../../ui/LocalChoice.ts";
import { LocalJsonEditor } from "../../ui/LocalJsonEditor.tsx";
import { SuppliedObservation } from "../../ui/SuppliedObservation.tsx";
import { color } from "../../ui/theme/index.ts";
export type SkillFileDraft = { name: string; content: string };
export function SkillFileEditor(props: {
	client: ClientConnection;
	selection: string | null;
	connected: boolean;
	fresh: boolean;
	focused: boolean;
	editing: boolean;
	edit: (value: boolean) => void;
	memory: SkillFileDraft;
	remember: (draft: SkillFileDraft) => void;
}) {
	const choices = useContext(LocalChoiceContext);
	const [document, setDocument] = createSignal<SkillFileDocument | null>(null),
		[candidate, setCandidate] = createSignal<SkillFileCandidate | null>(null),
		[approval, setApproval] = createSignal(""),
		[focus, setFocus] = createSignal<"name" | "content" | "approval" | null>(
			null,
		),
		[pending, setPending] = createSignal(false),
		[error, setError] = createSignal<string | null>(null),
		[attempt, setAttempt] = createSignal<{
			id: string;
			name: string;
			digest: string;
			status: "uncertain" | "acknowledged";
			result?: unknown;
		} | null>(null);
	let epoch = 0,
		disposed = false;
	const context = createMemo(
		() => ({
			selection: props.selection,
			connected: props.connected,
			fresh: props.fresh,
		}),
		undefined,
		{
			equals: (a, b) =>
				a?.selection === b.selection &&
				a?.connected === b.connected &&
				a?.fresh === b.fresh,
		},
	);
	const interactive = () =>
		!disposed &&
		props.connected &&
		props.fresh &&
		!pending() &&
		(choices?.interactive() ?? true);
	const source = createMemo(() => [
		context(),
		document(),
		candidate(),
		props.memory.name,
		props.memory.content,
		approval(),
		focus(),
		pending(),
	]);
	const invalidate = () => {
		epoch++;
		setCandidate(null);
		setApproval("");
	};
	let previous = context();
	createEffect(() => {
		const next = context();
		if (next === previous) return;
		previous = next;
		invalidate();
		setDocument(null);
		setFocus(null);
		props.edit(false);
	});
	onCleanup(() => {
		disposed = true;
		epoch++;
		props.edit(false);
	});
	const chooseFocus = (value: "name" | "content" | "approval" | null) => {
		if (disposed || (value !== null && !interactive())) return;
		setFocus(value);
		props.edit(value !== null);
	};
	const change = (draft: SkillFileDraft) => {
		if (
			!interactive() ||
			(draft.name === props.memory.name &&
				draft.content === props.memory.content)
		)
			return;
		invalidate();
		setError(null);
		if (draft.name !== props.memory.name) setDocument(null);
		props.remember(draft);
	};
	const validCandidate = (sealed: SkillFileCandidate) =>
		interactive() &&
		candidate() === sealed &&
		sealed.name === props.memory.name &&
		sealed.content === props.memory.content &&
		document()?.name === sealed.name &&
		document()?.revision === sealed.baseRevision &&
		document()?.directoryIdentity === sealed.directoryIdentity &&
		/^[a-f0-9]{64}$/.test(sealed.digest) &&
		Number.isSafeInteger(sealed.expiresAt) &&
		sealed.expiresAt > Date.now();
	const run = async (operation: "read" | "preview" | "apply") => {
		if (!interactive()) return;
		const generation = epoch,
			owner = context(),
			draft = { ...props.memory };
		const current = () =>
			!disposed &&
			generation === epoch &&
			context() === owner &&
			props.memory.name === draft.name &&
			props.memory.content === draft.content;
		// Validate before pending suppresses interactive controls.
		const sealed = candidate(),
			confirmed =
				!!sealed &&
				validCandidate(sealed) &&
				approval() === `approve:${sealed.digest}`;
		setPending(true);
		setError(null);
		chooseFocus(null);
		let attempted = false;
		try {
			if (operation === "read") {
				if (draft.content.length)
					throw new Error(
						"Existing text, including whitespace, is preserved; explicitly discard before reading another destination",
					);
				const value = await props.client.call("skill-file.read", {
					name: draft.name,
				});
				if (current()) {
					setDocument(value);
					props.remember({ name: value.name, content: value.content });
					setCandidate(null);
					setApproval("");
				}
			} else if (operation === "preview") {
				const base = document();
				if (!base || base.name !== draft.name)
					throw new Error(
						"Explicitly read this exact existing/missing destination before sealing a preview",
					);
				const value = await props.client.call("skill-file.preview", {
					name: draft.name,
					baseRevision: base.revision,
					content: draft.content,
				});
				if (current()) {
					setCandidate(value);
					setApproval("");
				}
			} else {
				if (!sealed || !confirmed)
					throw new Error(
						"Manually type the exact unexpired snapshot confirmation for the unchanged destination/draft",
					);
				setCandidate(null);
				setApproval("");
				setDocument(null);
				attempted = true;
				const observed = {
					id: sealed.id,
					name: sealed.name,
					digest: sealed.digest,
					status: "uncertain" as const,
				};
				setAttempt(observed);
				const saved = await props.client.call("skill-file.apply", {
					id: sealed.id,
					approval: `approve:${sealed.digest}`,
				});
				// Captured acknowledgement remains bound to its OLD request, never
				// populates a new editor owner or restores a consumed candidate.
				if (!disposed && attempt() === observed)
					setAttempt({ ...observed, status: "acknowledged", result: saved });
			}
		} catch (cause) {
			if (current())
				setError(
					`${cause instanceof Error ? cause.message : "Skill operation refused"}${attempted ? ". One attempt consumed; destination/directories may have changed. Inspect explicitly; no automatic retry." : ""}`,
				);
		} finally {
			if (!disposed) setPending(false);
		}
	};
	return (
		<box flexDirection="column" border={true} padding={1} gap={1}>
			<text fg={color("primary")}>Native user skill file authoring</text>
			<text wrapMode="word" fg={color("warning")}>
				CONFIG_DIR must already exist. Fixed CONFIG_DIR/skills/slug/SKILL.md
				only; flat lower-case slugs, never system skills or arbitrary paths.
				Loaded catalog stays unchanged. Writes require exact manually confirmed
				snapshots and current file/directory identities, not policy grants,
				reloads, task launches or restarts. Drafts are memory-only; no
				credentials. Symlink/hard-link/invalid UTF-8/Windows destinations
				refuse. Nested layouts stay loaded/read-only, never adopted.
			</text>
			<Show when={!props.connected || !props.fresh}>
				<text fg={color("warning")}>
					Cached/disconnected owner; no read, preview or write. Previous attempt
					observations do not grant replay or prove current disk state.
				</text>
			</Show>
			<ActionHeader
				scope={source()}
				interactive={interactive()}
				onActivate={() => chooseFocus("name")}
			>
				<text fg={color("accent")}>Edit explicit user-skill slug</text>
			</ActionHeader>
			<Show when={context()} keyed>
				{(owner) => (
					<input
						value={props.memory.name}
						maxLength={64}
						focused={
							context() === owner &&
							interactive() &&
							props.focused &&
							props.editing &&
							focus() === "name"
						}
						onInput={(name) => {
							if (
								context() === owner &&
								interactive() &&
								props.editing &&
								focus() === "name"
							)
								change({ ...props.memory, name });
						}}
						onMouseDown={() => {
							if (context() === owner) chooseFocus("name");
						}}
						onSubmit={() => {
							if (context() === owner && interactive()) chooseFocus(null);
						}}
					/>
				)}
			</Show>
			<ActionHeader
				scope={source()}
				interactive={interactive()}
				onActivate={() => void run("read")}
			>
				<text fg={color("accent")}>
					Read exact current/missing destination (never overwrites a draft)
				</text>
			</ActionHeader>
			<Show when={document()} keyed>
				{(saved) => (
					<box flexDirection="column" gap={1}>
						<text wrapMode="word">
							Observed file {saved.name} · revision {saved.revision} · directory{" "}
							{saved.directoryIdentity}. Non-atomic disk observation, not
							running catalog or current write authority.
						</text>
						<SuppliedObservation
							value={saved.content}
							scope={saved}
							filetype="markdown"
							label="Exact explicitly read user-skill source"
						/>
					</box>
				)}
			</Show>
			<ActionHeader
				scope={source()}
				interactive={interactive()}
				onActivate={() => {
					if (!interactive()) return;
					invalidate();
					props.remember({ name: props.memory.name, content: "" });
					chooseFocus(null);
				}}
			>
				<text fg={color("warning")}>
					Explicitly discard local draft and confirmation (not an attempt
					rollback)
				</text>
			</ActionHeader>
			<ActionHeader
				scope={source()}
				interactive={interactive()}
				onActivate={() => {
					if (!interactive()) return;
					if (props.memory.content.length) {
						setError(
							"Existing draft preserved, including whitespace; discard explicitly first",
						);
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
			<ActionHeader
				scope={source()}
				interactive={interactive()}
				onActivate={() => chooseFocus("content")}
			>
				<text fg={color("accent")}>Edit unsaved instruction text</text>
			</ActionHeader>
			<LocalJsonEditor
				value={props.memory.content}
				scope={JSON.stringify([
					"skill-file",
					context().selection,
					context().connected,
					context().fresh,
					props.memory.name,
					document()?.directoryIdentity,
				])}
				editing={props.focused && props.editing && focus() === "content"}
				interactive={interactive()}
				maxLength={64000}
				onLimit={() =>
					setError(
						"Native skill text limit is 64000 UTF-16 units; prior exact draft restored",
					)
				}
				enter={() => chooseFocus("content")}
				change={(content) => change({ ...props.memory, content })}
			/>
			<ActionHeader
				scope={source()}
				interactive={interactive()}
				onActivate={() => void run("preview")}
			>
				<text fg={color("accent")}>Seal immutable file preview only</text>
			</ActionHeader>
			<Show when={candidate()} keyed>
				{(sealed) => (
					<box flexDirection="column" gap={1}>
						<text wrapMode="word" fg={color("warning")}>
							Immutable candidate {sealed.id} · native digest {sealed.digest} ·
							expires {sealed.expiresAt} (epoch ms). Manual confirmation only;
							no loaded-skill update.
						</text>
						<SuppliedObservation
							value={sealed.snapshot}
							scope={sealed}
							filetype="json"
							label="Exact sealed file/directory/content snapshot"
						/>
						<ActionHeader
							scope={source()}
							interactive={validCandidate(sealed)}
							onActivate={() => {
								if (validCandidate(sealed)) chooseFocus("approval");
							}}
						>
							<text fg={color("accent")}>
								Focus exact snapshot confirmation
							</text>
						</ActionHeader>
						<input
							value={approval()}
							maxLength={80}
							placeholder="Manually type approve:DIGEST"
							focused={
								validCandidate(sealed) &&
								props.focused &&
								props.editing &&
								focus() === "approval"
							}
							onInput={(value) => {
								if (
									validCandidate(sealed) &&
									props.editing &&
									focus() === "approval"
								)
									setApproval(value);
							}}
							onMouseDown={() => {
								if (validCandidate(sealed)) chooseFocus("approval");
							}}
							onSubmit={() => {
								if (validCandidate(sealed)) chooseFocus(null);
							}}
						/>
						<ActionHeader
							scope={source()}
							interactive={validCandidate(sealed)}
							onActivate={() => {
								if (validCandidate(sealed)) void run("apply");
							}}
						>
							<text fg={color("warning")}>
								Submit one explicitly confirmed skill-file write
							</text>
						</ActionHeader>
					</box>
				)}
			</Show>
			<Show when={attempt()} keyed>
				{(observed) => (
					<box flexDirection="column" gap={1}>
						<text
							fg={
								observed.status === "acknowledged"
									? color("success")
									: color("warning")
							}
						>
							Captured local attempt for {observed.name} · {observed.status}.
							Not a durable journal, current disk observation, rollback or
							permission to retry. Explicitly inspect disk before another
							independently confirmed intention; running skills/tasks remain
							unchanged.
						</text>
						<SuppliedObservation
							value={observed}
							scope={observed}
							label="Captured attempt identity and native acknowledgement, if received"
						/>
					</box>
				)}
			</Show>
			<Show when={error()}>
				<text wrapMode="word" fg={color("error")}>
					{error()}
				</text>
			</Show>
			<Show when={pending()}>
				<text fg={color("textMuted")}>
					Native skill-file operation pending; destination/draft edits withheld
				</text>
			</Show>
		</box>
	);
}
