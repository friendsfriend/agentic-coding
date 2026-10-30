// An operator attests one exact interactive input, not a reusable human role.
import { Schema } from "effect";
import { integer, text } from "./decode.ts";

export const orchestratorDeveloperInputSchema = Schema.Struct({
	hostId: text(256),
	conversationId: text(256),
	runId: text(256),
	requestId: text(256),
	text: text(32768),
	whenBusy: Schema.Literals(["followUp", "steer", "reject"]),
	/** Short-lived authority; a retry uses the same native request identity. */
	expiresAt: integer(1),
});
export type OrchestratorDeveloperInput =
	typeof orchestratorDeveloperInputSchema.Type;
export const orchestratorDeveloperInputVerificationSchema = Schema.Struct({
	input: orchestratorDeveloperInputSchema,
	proof: text(128),
});
export type OrchestratorDeveloperInputVerification =
	typeof orchestratorDeveloperInputVerificationSchema.Type;
