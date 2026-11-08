/** @jsxImportSource @opentui/solid */
import { createHash } from "node:crypto";
import { SyntaxStyle } from "@opentui/core";
import { useRenderer } from "@opentui/solid";
import { createMemo, createSignal, For, onCleanup, Show } from "solid-js";
import type { EvidenceDocument } from "../../../protocol/evidence.ts";
import type { Data, TaskDetails } from "../../../protocol/index.ts";
import { ActionHeader } from "../../ui/ActionHeader.tsx";
import { EvidenceView } from "../../ui/EvidenceView.tsx";
import { SuppliedObservation } from "../../ui/SuppliedObservation.tsx";
import { SuppliedRecordWindow } from "../../ui/SuppliedRecordWindow.tsx";
import { color } from "../../ui/theme/index.ts";
import { SuppliedCode } from "../sessions/SuppliedCode.tsx";

export const taskIdentity = (id: unknown): id is number =>
	Number.isSafeInteger(id) && Number(id) > 0;
const token = (id: unknown): id is string =>
	typeof id === "string" &&
	id.length > 0 &&
	id.length <= 128 &&
	!/\s/.test(id) &&
	Array.from(id).every(
		(char) => char.charCodeAt(0) >= 32 && char.charCodeAt(0) !== 127,
	);
const fingerprint = (value: unknown) =>
	createHash("sha256")
		.update(JSON.stringify(value) ?? "not supplied")
		.digest("hex");
/** A captured detail response, never a restored execution/worker authority.
 * Every command rechecks supplied catalog/review scope; the backend remains final. */
export function TaskObservation(props: {
	details: TaskDetails;
	current: () => boolean;
	scope: object;
	catalog: Data[];
	reviews: Data[];
	fresh: boolean;
	connected: boolean;
	error: string | null;
	expanded: string[];
	toggle: (id: string) => void;
	prepare: (command: string) => void;
	select: (id: number) => void;
	openSession: (() => void) | null;
	evidence: EvidenceDocument | null;
}) {
	const saved = props.details;
	const syntax = SyntaxStyle.fromStyles(
		{
			default: { fg: color("text") },
			"markup.heading": { fg: color("primary"), bold: true },
			"markup.strong": { fg: color("text"), bold: true },
			"markup.raw": { fg: color("accent") },
		},
		useRenderer().nativeScene,
	);
	let disposed = false;
	onCleanup(() => {
		disposed = true;
		syntax.destroy();
	});
	const [rendered, setRendered] = createSignal(true);
	const active = () => !disposed && props.current();
	const owner = () => props.catalog.filter((row) => row.id === saved.id);
	const live = () =>
		active() &&
		props.fresh &&
		props.connected &&
		!props.error &&
		owner().length === 1 &&
		saved.native !== null &&
		owner()[0]?.status === saved.native.status &&
		saved.native.status !== "terminal";
	const controls = createMemo(() => [
		props.scope,
		props.evidence,
		props.openSession,
		rendered(),
		props.expanded,
	]);
	const prepare = (command: string) => {
		if (active() && props.fresh && props.connected && !props.error)
			props.prepare(command);
	};
	const disclosure = (name: string, label: string, value: unknown) => {
		const key = `task-detail:${saved.id}:${name}:${fingerprint(value)}`;
		return (
			<box flexDirection="column" gap={1}>
				<ActionHeader
					scope={controls()}
					interactive={active()}
					onActivate={() => {
						if (active()) props.toggle(key);
					}}
				>
					<text fg={color("accent")}>
						{props.expanded.includes(key) ? "▾" : "▸"} {label}
					</text>
				</ActionHeader>
				<Show when={props.expanded.includes(key)}>
					<SuppliedObservation
						value={value}
						filetype={name.endsWith(":snapshot") ? "diff" : undefined}
						label={label}
						scope={props.scope}
					/>
				</Show>
			</box>
		);
	};
	const reviewMember = (review: Data) =>
		active() &&
		token(review.id) &&
		taskIdentity(review.revision) &&
		typeof review.digest === "string" &&
		/^[a-f0-9]{64}$/.test(review.digest) &&
		typeof review.snapshot === "string" &&
		review.taskId === saved.id &&
		saved.reviews.filter((entry) => entry.id === review.id).length === 1 &&
		props.reviews.filter((entry) => entry.id === review.id).length === 1 &&
		props.reviews.some(
			(entry) =>
				entry.id === review.id &&
				entry.taskId === saved.id &&
				entry.revision === review.revision &&
				entry.digest === review.digest &&
				entry.state === review.state,
		);
	const attachmentMember = (item: TaskDetails["attachments"][number]) =>
		active() &&
		item.taskId === saved.id &&
		/^[a-f0-9]{64}$/.test(item.id) &&
		saved.attachments.filter((entry) => entry.id === item.id).length === 1;
	const related = () =>
		taskIdentity(saved.metadata.relatedTo) &&
		saved.metadata.relatedTo !== saved.id &&
		props.catalog.filter((row) => row.id === saved.metadata.relatedTo)
			.length === 1;
	return (
		<box
			flexDirection="column"
			gap={1}
			border={["top"]}
			borderColor={color("border")}
			paddingTop={1}
		>
			<text fg={color("primary")}>
				Task #{saved.id} ·{" "}
				{props.connected
					? "last explicitly observed native detail (non-atomic)"
					: "cached detail; current activity unknown"}
			</text>
			<text fg={color("textMuted")}>
				Native status: {saved.native?.status ?? "missing"} · abort requested:{" "}
				{String(saved.native?.abortRequested ?? "unknown")}
			</text>
			<text wrapMode="word">
				Skill {String(saved.metadata.skill ?? "not supplied")} · profile{" "}
				{String(saved.metadata.profile ?? "not supplied")} · policy{" "}
				{String(saved.metadata.policy ?? "not supplied")}
			</text>
			<text wrapMode="word">
				Topic {String(saved.metadata.topicId ?? "not supplied")} · related task{" "}
				{String(saved.metadata.relatedTo ?? "none recorded")} · base{" "}
				{String(saved.metadata.baseCommit ?? "not retained")}
			</text>
			<text wrapMode="word">
				Repository: {String(saved.metadata.repository ?? "not supplied")}
				{"\n"}Workspace: {String(saved.metadata.workspace ?? "not prepared")}
			</text>
			<Show when={related()}>
				<ActionHeader
					scope={controls()}
					interactive={active()}
					onActivate={() => {
						if (active() && related() && taskIdentity(saved.metadata.relatedTo))
							props.select(saved.metadata.relatedTo);
					}}
				>
					<text fg={color("accent")}>
						Open unique supplied related app task #
						{String(saved.metadata.relatedTo)}
					</text>
				</ActionHeader>
			</Show>
			<Show when={props.openSession}>
				<ActionHeader
					scope={controls()}
					interactive={active()}
					onActivate={() => {
						if (active()) props.openSession?.();
					}}
				>
					<text fg={color("accent")}>
						Open unique supplied native child transcript (not worker-ID
						adoption)
					</text>
				</ActionHeader>
			</Show>
			<Show
				when={
					!props.fresh ||
					(saved.native && owner()[0]?.status !== saved.native.status)
				}
			>
				<text fg={color("warning")}>
					Detail and current catalog differ or ownership is cached; refresh
					explicitly before preparing lifecycle/review commands.
				</text>
			</Show>
			<Show when={live()}>
				<ActionHeader
					scope={controls()}
					interactive={live()}
					onActivate={() => {
						if (live()) prepare(`/cancel ${saved.id}`);
					}}
				>
					<text fg={color("warning")}>
						Prepare cancellation command (does not submit)
					</text>
				</ActionHeader>
			</Show>
			<Show when={saved.native?.outcome}>
				{(outcome) => (
					<box flexDirection="column" gap={1}>
						<text fg={color("primary")}>
							Recorded terminal outcome ·{" "}
							{String(outcome().status ?? "not supplied")}
						</text>
						<Show when={typeof outcome().result === "string"}>
							<ActionHeader
								scope={controls()}
								interactive={active()}
								onActivate={() => {
									if (active()) setRendered(!rendered());
								}}
							>
								<text fg={color("accent")}>
									{rendered()
										? "Show exact inert outcome source"
										: "Show window-local rendered outcome markdown"}
								</text>
							</ActionHeader>
							<SuppliedCode
								content={String(outcome().result)}
								identity={`task-outcome:${saved.id}:${fingerprint(outcome())}`}
								filetype="markdown"
								presentation={rendered() ? "markdown" : "code"}
								syntax={syntax}
							/>
						</Show>
						{disclosure(
							"outcome",
							"Complete supplied native outcome",
							outcome(),
						)}
					</box>
				)}
			</Show>
			<text fg={color("primary")}>
				Supplied reviews · {saved.reviews.length}
			</text>
			<SuppliedRecordWindow
				rows={saved.reviews}
				scope={props.scope}
				label="task review records"
				title={(review) =>
					`${String(review.title)} · ${String(review.state)} · ${String(review.id)}@${String(review.revision)}`
				}
				search={(review) => JSON.stringify(review)}
			>
				{(review, index) => (
					<box
						flexDirection="column"
						border={true}
						borderColor={
							review.state === "pending" ? color("warning") : color("border")
						}
						padding={1}
						gap={1}
					>
						<text fg={color("primary")}>
							{index() + 1}. {String(review.title)} · {String(review.state)}
						</text>
						<text wrapMode="word">
							{String(review.id)}@{String(review.revision)} · path{" "}
							{String(review.path ?? "not supplied")}
							{"\n"}Native immutable snapshot digest:{" "}
							{String(review.digest ?? "not supplied")}
						</text>
						{disclosure(
							`review:${index()}:snapshot`,
							"Exact supplied immutable review snapshot",
							review.snapshot,
						)}
						<Show
							when={review.comments !== undefined && review.comments !== null}
						>
							{disclosure(
								`review:${index()}:comments`,
								"Recorded decision comments",
								review.comments,
							)}
						</Show>
						{disclosure(
							`review:${index()}:record`,
							"Complete supplied review record (not approval)",
							review,
						)}
						<Show when={!reviewMember(review)}>
							<text fg={color("warning")}>
								Review owner/revision/digest/state is missing, ambiguous or
								differs from current inventory; decision preparation withheld.
							</text>
						</Show>
						<Show
							when={
								live() &&
								reviewMember(review) &&
								review.state === "pending" &&
								!saved.native?.abortRequested
							}
						>
							<text fg={color("textMuted")}>
								Prepare only; edit comments in the prompt and explicitly submit.
								Native ownership/revision checks remain final.
							</text>
							<For each={["approve", "changes", "reject"]}>
								{(decision) => (
									<ActionHeader
										scope={controls()}
										interactive={live() && reviewMember(review)}
										onActivate={() => {
											if (
												live() &&
												reviewMember(review) &&
												review.state === "pending" &&
												!saved.native?.abortRequested
											)
												prepare(
													`/${decision} ${String(review.id)}@${String(review.revision)} `,
												);
										}}
									>
										<text fg={color("accent")}>Prepare {decision} command</text>
									</ActionHeader>
								)}
							</For>
						</Show>
					</box>
				)}
			</SuppliedRecordWindow>
			<text fg={color("primary")}>
				Current supplied owned native worker tree · bounded, non-atomic
				inspection
			</text>
			<text fg={color("textMuted")}>
				Worker IDs are diagnostic identities, not app tasks or permission. No
				checkpoint/input bytes, arbitrary conversation adoption or
				reconstruction of missing/terminal workers. Local windows may begin
				mid-tree.
			</text>
			<SuppliedRecordWindow
				rows={saved.ownedWork.items}
				scope={props.scope}
				label="owned worker observations"
				title={(work) =>
					`#${work.id} · parent ${String(work.parent)} · ${work.state} · ${work.reason ?? ""}`
				}
				search={(work) => JSON.stringify(work)}
			>
				{(work, index) => (
					<box
						flexDirection="column"
						paddingLeft={work.parent === null ? 0 : 2}
						gap={1}
					>
						<text wrapMode="word">
							{index() + 1}. Worker #{work.id} · parent{" "}
							{work.parent ?? "app task root"} · conversation #
							{work.conversationId} · {work.state}
							{work.until === null
								? ""
								: ` · sleeping until ${work.until} (epoch ms)`}
						</text>
						<Show when={work.reason}>
							<text wrapMode="word" fg={color("warning")}>
								{work.reason}
								{work.reasonTruncated ? " (native reason clipped)" : ""}
							</text>
						</Show>
						{disclosure(
							`worker:${index()}`,
							"Supplied diagnostic worker record; no navigation authority",
							work,
						)}
					</box>
				)}
			</SuppliedRecordWindow>
			<Show when={saved.ownedWork.truncated}>
				<text fg={color("warning")}>
					Native owned worker inspection clipped at 128 records; local paging
					cannot recover omitted records.
				</text>
			</Show>
			<text fg={color("primary")}>
				Retained task-owned evidence · {saved.attachments.length}
			</text>
			<SuppliedRecordWindow
				rows={saved.attachments}
				scope={props.scope}
				label="task evidence descriptors"
				title={(item) => `${item.caption} · ${item.mediaType} · ${item.id}`}
				search={(item) => JSON.stringify(item)}
			>
				{(item, index) => (
					<box flexDirection="column" paddingLeft={1} gap={1}>
						<text wrapMode="word">
							{index() + 1}. {item.caption} · {item.mediaType} · owner #
							{item.taskId}
						</text>
						<text fg={color("textMuted")} wrapMode="word">
							Content identity: {item.id}. Metadata is not process/visual proof;
							explicit native byte reads are owner/digest-fenced, not arbitrary
							file/URL opens.
						</text>
						<Show when={attachmentMember(item)}>
							<ActionHeader
								scope={controls()}
								interactive={
									active() && props.connected && props.fresh && !props.error
								}
								onActivate={() => {
									if (attachmentMember(item))
										prepare(`/evidence ${item.taskId} ${item.id}`);
								}}
							>
								<text fg={color("accent")}>
									Prepare explicit retained evidence read
								</text>
							</ActionHeader>
						</Show>
						<Show when={!attachmentMember(item)}>
							<text fg={color("warning")}>
								Evidence descriptor owner/identity is missing or ambiguous; read
								preparation withheld.
							</text>
						</Show>
						<Show
							when={
								attachmentMember(item) &&
								props.evidence?.id === item.id &&
								props.evidence?.taskId === saved.id &&
								props.evidence?.mediaType === item.mediaType
							}
						>
							<Show when={props.evidence} keyed>
								{(document) => (
									<EvidenceView
										document={document}
										syntax={syntax}
										prepare={(command) => {
											if (attachmentMember(item) && props.evidence === document)
												prepare(command);
										}}
									/>
								)}
							</Show>
						</Show>
					</box>
				)}
			</SuppliedRecordWindow>
			{disclosure(
				"metadata",
				"Complete supplied retained task metadata",
				saved.metadata,
			)}
		</box>
	);
}
