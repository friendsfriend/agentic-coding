// Transcript authority is assigned at host admission, never inferred from
// content, a model-supplied role, or an arbitrary native pi.user entry.
import type { EntryRecord } from "@earendil-works/pi-durable";

export const ORCHESTRATOR_DEVELOPER_ENTRY = "herdr.orchestrator.developer";
export const ORCHESTRATOR_INTERNAL_ENTRY = "herdr.orchestrator.internal";

export interface ClarificationTranscriptMessage {
	readonly hostId: string;
	readonly conversationId: string;
	readonly messageId: string;
	/** Native immutable entry ID order, unaffected by active-context compaction. */
	readonly sequence: number;
	readonly role: "assistant" | "developer";
	readonly text: string;
}

export function clarificationTranscriptMessage(
	hostId: string,
	conversationId: string,
	entry: EntryRecord,
): ClarificationTranscriptMessage | undefined {
	if (String(entry.conversationId) !== conversationId) return undefined;
	const role =
		entry.kind === ORCHESTRATOR_DEVELOPER_ENTRY
			? "developer"
			: entry.kind === "pi.assistant"
				? "assistant"
				: undefined;
	const message = entry.model?.[0];
	if (
		!role ||
		!message ||
		message.role !== (role === "developer" ? "user" : "assistant")
	)
		return undefined;
	const sequence = Number(entry.id);
	if (!Number.isSafeInteger(sequence) || sequence < 1) return undefined;
	const text =
		typeof message.content === "string"
			? message.content
			: message.content
					.filter((part) => part.type === "text")
					.map((part) => ("text" in part ? part.text : ""))
					.join("\n");
	// Never certify a silently truncated proposal. A caller can present a short
	// explicit summary as an ordinary assistant turn instead.
	if (!text.trim() || Buffer.byteLength(text) > 8192) return undefined;
	return {
		hostId,
		conversationId,
		messageId: String(entry.id),
		sequence,
		role,
		text,
	};
}
