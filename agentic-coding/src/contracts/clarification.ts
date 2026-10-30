import { Schema } from "effect";
import { integer, text } from "./decode.ts";
import type { DeveloperDialogueRecord } from "./workflow.ts";

export function ordinaryClarification(
	item: Pick<DeveloperDialogueRecord, "kind" | "targetRole">,
): boolean {
	return (
		item.kind !== "login-handoff" &&
		(item.targetRole === undefined || item.targetRole === "orchestrator")
	);
}

export const clarificationActions = new Set([
	"clarification.attach",
	"clarification.stage",
	"clarification.confirm",
	"clarification.grounded",
	"clarification.ack",
	"clarification.cancel",
]);
export const clarificationSourceSchema = Schema.Struct({
	kind: Schema.Literals(["task", "design", "developer-decision"]),
	id: text(4096),
	digest: text(128),
});
export const clarificationResponsesSchema = Schema.Array(
	Schema.Struct({
		questionId: text(4096),
		kind: Schema.Literals(["option", "custom"]),
		value: text(8192),
	}),
).pipe(
	Schema.check(Schema.isMinLength(1)),
	Schema.check(Schema.isMaxLength(100)),
);
export const clarificationReconcileSchema = Schema.Struct({
	hostId: text(256),
	conversationId: text(256),
	repo: Schema.optionalKey(text(4096)),
});
export const clarificationAttachSchema = Schema.Struct({
	hostId: text(256),
	conversationId: text(256),
	homeRunId: text(256),
});
export type ClarificationAttach = typeof clarificationAttachSchema.Type;
export const clarificationMutationSchema = Schema.Struct({
	epoch: integer(1),
	questionId: text(4096),
	askingRunId: text(4096),
	homeRunId: text(256),
	responses: Schema.optionalKey(clarificationResponsesSchema),
	proposalMessageId: Schema.optionalKey(text(256)),
	confirmationMessageId: Schema.optionalKey(text(256)),
	version: Schema.optionalKey(integer(1)),
	receipt: Schema.optionalKey(text(256)),
	rationale: Schema.optionalKey(text(4096)),
	sources: Schema.optionalKey(
		Schema.Array(clarificationSourceSchema).pipe(
			Schema.check(Schema.isMinLength(1)),
			Schema.check(Schema.isMaxLength(16)),
		),
	),
});
export type ClarificationMutation = typeof clarificationMutationSchema.Type;
