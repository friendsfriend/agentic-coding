/** @jsxImportSource @opentui/solid */
import { createEffect, createMemo, onCleanup, Show } from "solid-js";
import type { Data } from "../../../protocol/index.ts";
import type {
	ProviderActionCandidate,
	ProviderActionReceipt,
} from "../../../protocol/provider-actions.ts";
import { ActionHeader } from "../../ui/ActionHeader.tsx";
import { DetailsFold } from "../../ui/DetailsFold.tsx";
import { LocalJsonEditor } from "../../ui/LocalJsonEditor.tsx";
import { PreparedCandidate } from "../../ui/PreparedCandidate.tsx";
import { SuppliedObservation } from "../../ui/SuppliedObservation.tsx";
import { SuppliedRecordWindow } from "../../ui/SuppliedRecordWindow.tsx";
import { color } from "../../ui/theme/index.ts";
/** Local intentions, sealed source and a read-only native attempt journal.
 * Nothing here automatically dispatches, follows a link or retries a receipt. */
export function ProviderWritePanel(props: {
	provider: string | null;
	catalog: Data[];
	draft: string;
	change: (draft: string) => void;
	editing: boolean;
	edit: (value: boolean) => void;
	connected: boolean;
	fresh: boolean;
	error: string | null;
	candidate: ProviderActionCandidate | null;
	attempts: ProviderActionReceipt[];
	prepare: (command: string) => void;
}) {
	let disposed = false;
	onCleanup(() => {
		disposed = true;
	});
	const editorOwner = createMemo(() =>
		JSON.stringify([props.provider, props.connected, props.fresh]),
	);
	let previousEditor = editorOwner();
	createEffect(() => {
		const next = editorOwner();
		if (next !== previousEditor) {
			previousEditor = next;
			props.edit(false);
		}
	});
	const journal = createMemo(() => ({
		rows: props.attempts,
		provider: props.provider,
		catalog: props.catalog,
		connected: props.connected,
		fresh: props.fresh,
	}));
	const controls = createMemo(() => [
		journal(),
		props.draft,
		props.candidate,
		props.error,
	]);
	const ready = () =>
		!disposed &&
		props.connected &&
		props.fresh &&
		!props.error &&
		props.provider !== null &&
		props.catalog.filter((row) => row.name === props.provider).length === 1;
	const prepare = (command: string) => {
		if (ready()) {
			props.edit(false);
			props.prepare(command);
		}
	};
	const member = (attempt: ProviderActionReceipt) =>
		!disposed &&
		props.attempts.some((row) => row === attempt) &&
		attempt.provider === props.provider &&
		props.catalog.filter((row) => row.name === attempt.provider).length === 1 &&
		props.attempts.filter(
			(row) => row.id === attempt.id && row.provider === attempt.provider,
		).length === 1 &&
		/^[A-Za-z0-9_-]{1,128}$/.test(attempt.id);
	return (
		<box flexDirection="column" gap={1}>
			<text fg={color("primary")}>Provider changes</text>
			<Show when={props.error}>
				<text fg={color("warning")}>{props.error}</text>
			</Show>
			<Show when={!props.connected || !props.fresh}>
				<text fg={color("warning")}>Disconnected · changes withheld</text>
			</Show>
			<DetailsFold
				label="Supported changes"
				summary="will be approved one at a time"
				scope={controls()}
			>
				<text wrapMode="word" fg={color("textMuted")}>
					comment-change, approve-exact-change (full reviewed 40-hex SHA),
					unapprove-change, comment-issue, close-issue, retry-job, cancel-job,
					rebase-change (GitLab), reply-discussion, resolve-discussion (GitLab),
					set-issue-labels, set-issue-assignees. GitHub CI numbers are run IDs,
					not job IDs.
				</text>
			</DetailsFold>
			<ActionHeader
				scope={controls()}
				interactive={!disposed && props.connected}
				onActivate={() => {
					if (!disposed && props.connected) props.edit(!props.editing);
				}}
			>
				<text fg={color("accent")}>
					{props.editing ? "Leave editor" : "Edit change"}
				</text>
			</ActionHeader>
			<Show when={props.editing}>
				<LocalJsonEditor
					value={props.draft}
					scope={editorOwner()}
					maxLength={128000}
					editing={props.editing}
					interactive={!disposed && props.connected}
					height={10}
					enter={() => {
						if (!disposed && props.connected) props.edit(true);
					}}
					change={props.change}
				/>
			</Show>
			<Show when={ready()}>
				<ActionHeader
					scope={controls()}
					interactive={ready()}
					onActivate={() => prepare("/provider-preview")}
				>
					<text fg={color("accent")}>Preview change</text>
				</ActionHeader>
				<ActionHeader
					scope={controls()}
					interactive={ready()}
					onActivate={() => prepare("/provider-new OPERATION")}
				>
					<text fg={color("accent")}>Start a new change</text>
				</ActionHeader>
				<ActionHeader
					scope={controls()}
					interactive={ready()}
					onActivate={() => prepare("/provider-attempts")}
				>
					<text fg={color("accent")}>Refresh attempts</text>
				</ActionHeader>
			</Show>
			<PreparedCandidate
				candidate={props.candidate}
				scope={controls()}
				ready={ready() && props.candidate?.provider === props.provider}
				label="Provider change"
				metadata={
					props.candidate ? { provider: props.candidate.provider } : undefined
				}
				prepare={(id) =>
					prepare(`/provider-apply ${id} approve:TYPE_THE_SNAPSHOT_DIGEST`)
				}
			/>
			<SuppliedRecordWindow
				rows={props.attempts}
				scope={journal()}
				label="provider attempts"
				title={(attempt) =>
					`${attempt.id} · ${attempt.operation} · ${attempt.target} · ${attempt.status}`
				}
				search={(attempt) => JSON.stringify(attempt)}
			>
				{(attempt) => (
					<box flexDirection="column" gap={1}>
						<text
							fg={
								attempt.status === "uncertain"
									? color("warning")
									: color("textMuted")
							}
							wrapMode="word"
						>
							{attempt.id} · {attempt.operation} · {attempt.target} ·{" "}
							{attempt.status} · {attempt.updatedAt} (epoch ms)
						</text>
						<ActionHeader
							scope={controls()}
							interactive={ready() && member(attempt)}
							onActivate={() => {
								if (member(attempt)) prepare(`/provider-receipt ${attempt.id}`);
							}}
						>
							<text fg={color("accent")}>
								Prepare full native receipt read (no remote call)
							</text>
						</ActionHeader>
						<text wrapMode="word">
							Native intention digest {attempt.digest}.{" "}
							{attempt.status === "uncertain"
								? "Outcome unknown, including preflight/rejection/crash. Inspect remote state before any new separately approved request ID."
								: "Retained native acknowledgement only; no automatic follow-up or retry."}
						</text>
						<Show when={!member(attempt)}>
							<text fg={color("warning")}>
								Ambiguous/missing receipt identity; command preparation
								withheld.
							</text>
						</Show>
						<SuppliedObservation
							value={attempt.destination}
							scope={journal()}
							filetype="json"
							label="Recorded destination/credential-reference metadata; not current account/configuration proof"
						/>
						<Show when={attempt.result !== null}>
							<SuppliedObservation
								value={attempt.result}
								scope={journal()}
								label="Complete supplied native receipt result; not original remote bytes"
							/>
						</Show>
					</box>
				)}
			</SuppliedRecordWindow>
		</box>
	);
}
