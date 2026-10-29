import { createHash } from "node:crypto";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import {
	type Conversation,
	defineDoc,
	type Harness,
	type JsonObject,
} from "@earendil-works/pi-durable";
import {
	SchedulingError,
	type TargetReceipt,
} from "../contracts/scheduling.ts";

export interface ScheduledEnvelope {
	occurrenceId: string;
	digest: string;
	text: string;
	expectedHostId: string;
	expectedConversationId: string;
	runId: string;
}
interface Reservation extends JsonObject {
	envelope: string;
	digest: string;
	authorized: boolean;
	fence: number;
}
interface PendingScheduled extends JsonObject {
	items: Record<
		string,
		{ conversationId: string; occurrenceId: string; digest: string }
	>;
}
const pendingScheduled = defineDoc<PendingScheduled>({
	kind: "agentic.schedule-pending",
	version: 1,
	scope: "session",
	checkpointWhen: () => false,
	initial: () => ({ items: {} }),
});
function token(id: string) {
	return defineDoc<Reservation>({
		kind: `agentic.schedule.${createHash("sha256").update(id).digest("hex")}`,
		version: 1,
		scope: "conversation",
		history: "latest",
		fork: "initial",
		checkpointWhen: () => false,
		initial: () => ({ envelope: "", digest: "", authorized: false, fence: 0 }),
	});
}
export function schedulingDigest(text: string): string {
	return createHash("sha256").update(text).digest("hex");
}
function validate(envelope: ScheduledEnvelope): void {
	if (
		!envelope.occurrenceId ||
		envelope.occurrenceId.length > 256 ||
		Buffer.byteLength(envelope.text) > 160_000 ||
		schedulingDigest(envelope.text) !== envelope.digest
	)
		throw new SchedulingError(
			"invalid-input",
			"Invalid scheduled admission envelope.",
		);
}
/** Native conversation transactions own reservation and content provenance. Native requestId receipts own enqueue deduplication. */
export async function reserveScheduled(
	conversation: Conversation,
	envelope: ScheduledEnvelope,
): Promise<TargetReceipt> {
	validate(envelope);
	await conversation.commit(async (tx) => {
		const doc = await tx.doc(token(envelope.occurrenceId), conversation.id);
		if (
			doc.digest &&
			(doc.digest !== envelope.digest ||
				doc.envelope !== JSON.stringify(envelope))
		)
			throw new SchedulingError(
				"conflict",
				"Occurrence reservation identity/content changed.",
			);
		doc.digest = envelope.digest;
		doc.envelope = JSON.stringify(envelope);
	}, BACKGROUND_CONTEXT);
	return queryScheduled(conversation, envelope.occurrenceId, envelope.digest);
}
export async function activateScheduled(
	conversation: Conversation,
	envelope: ScheduledEnvelope,
	fence: number,
): Promise<TargetReceipt> {
	validate(envelope);
	await conversation.commit(async (tx) => {
		const doc = await tx.doc(token(envelope.occurrenceId), conversation.id);
		if (
			doc.digest !== envelope.digest ||
			doc.envelope !== JSON.stringify(envelope)
		)
			throw new SchedulingError(
				"conflict",
				"Missing or mismatched scheduled reservation.",
			);
		if (fence < doc.fence)
			throw new SchedulingError(
				"conflict",
				"Stale scheduled activation fence.",
			);
		doc.authorized = true;
		doc.fence = fence;
		const pending = await tx.doc(pendingScheduled);
		pending.items[`${conversation.id}:${envelope.occurrenceId}`] = {
			conversationId: String(conversation.id),
			occurrenceId: envelope.occurrenceId,
			digest: envelope.digest,
		};
	}, BACKGROUND_CONTEXT);
	// The scheduler already durably admitted this reservation. A crash here is recovered with the SAME requestId.
	// Native submit commits inbox admission and its deduplication receipt atomically; an app-side before/after receipt alone would not suffice.
	await conversation.submit(
		{
			type: "input",
			content: envelope.text,
			requestId: `schedule:${envelope.occurrenceId}`,
			whenBusy: "followUp",
		},
		BACKGROUND_CONTEXT,
	);
	return queryScheduled(conversation, envelope.occurrenceId, envelope.digest);
}
/** Lifecycle stop is not cancellation. Native abort withdraws inbox inputs;
 * leave a queued scheduled input for harness.close/resume instead. Explicit
 * developer abort continues to use the ordinary cancellation path. */
export async function hasQueuedScheduled(
	harness: Pick<Harness, "snapshot">,
	conversation: Conversation,
): Promise<boolean> {
	const pending = await harness.snapshot(pendingScheduled, BACKGROUND_CONTEXT);
	const reservations = Object.values(pending?.items ?? {}).filter(
		(value) => value.conversationId === String(conversation.id),
	);
	for (const envelope of reservations) {
		if (
			(
				await queryScheduled(
					conversation,
					envelope.occurrenceId,
					envelope.digest,
				)
			).state === "queued"
		)
			return true;
	}
	return false;
}

export async function queryScheduled(
	conversation: Conversation,
	occurrenceId: string,
	digest: string,
): Promise<TargetReceipt> {
	let submission: TargetReceipt["submission"];
	const result = await conversation.commit(async (tx) => {
		const doc = await tx.doc(token(occurrenceId), conversation.id);
		if (!doc.digest || doc.digest !== digest)
			throw new SchedulingError(
				"conflict",
				"Scheduled reservation is absent or mismatched.",
			);
		const receipt = await tx.submissionByRequest(
			conversation.id,
			`schedule:${occurrenceId}`,
		);
		if (receipt) {
			submission = {
				conversationId: String(conversation.id),
				id: String(receipt.id),
				...("entry" in receipt && receipt.entry != null
					? { inputEntryId: String(receipt.entry) }
					: {}),
				...("answer" in receipt && receipt.answer != null
					? { answerEntryId: String(receipt.answer) }
					: {}),
			};
		}
		if (receipt?.status === "done" || receipt?.status === "unanswered") {
			const pending = await tx.doc(pendingScheduled);
			delete pending.items[`${conversation.id}:${occurrenceId}`];
		}
		const state: TargetReceipt["state"] =
			receipt?.status === "done"
				? "succeeded"
				: receipt?.status === "unanswered"
					? "execution-failed"
					: receipt?.status === "placed"
						? "processing"
						: receipt?.status === "queued"
							? "queued"
							: doc.authorized
								? "admitted"
								: "reserved";
		return {
			id: occurrenceId,
			digest,
			state,
			...(submission
				? {
						submission,
					}
				: {}),
		};
	}, BACKGROUND_CONTEXT);
	if (result.state === "succeeded" && submission?.answerEntryId) {
		const view = await conversation.viewState(BACKGROUND_CONTEXT);
		try {
			const answer = view.value.entries.find(
				(entry) => String(entry.id) === submission?.answerEntryId,
			);
			const text =
				answer?.kind === "pi.assistant"
					? answer.model
							?.flatMap((message) =>
								message.role === "assistant"
									? message.content
											.filter((block) => block.type === "text")
											.map((block) => block.text)
									: [],
							)
							.join("\n")
					: undefined;
			if (text !== undefined && text.length > 0) {
				const limit = 60_000;
				return {
					...result,
					result:
						text.length > limit
							? `${text.slice(0, limit)}\n[Output truncated; retained native answer entry ${submission.answerEntryId}.]`
							: text,
				};
			}
		} finally {
			view.dispose();
		}
	}
	return result;
}
