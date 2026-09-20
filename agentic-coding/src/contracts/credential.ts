// Credential wire contract: the credential-interaction responses the shell
// posts back to the server. Pure schema.
import { Schema } from "effect";

export const credentialRespondSchema = Schema.Struct({
	ownerId: Schema.String,
	interactionId: Schema.String,
	value: Schema.String,
});

/** Decoded request type for `credentialRespondSchema`. */
export type CredentialRespondRequest = typeof credentialRespondSchema.Type;
