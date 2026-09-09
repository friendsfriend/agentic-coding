// Shared failure classes for the effect-runner's typed recovery policy
// (migrate-workflow-execution-to-effect, task 1.3). Handlers and boundary
// adapters throw these to classify a failure explicitly; the runner maps
// them, the `WorkflowFailure` tagged union, and unknown errors onto the
// durable outbox outcome (see `classifyFailure` in `effect-runner.ts`).
// Plain `Error`s are defects by default: they surface immediately instead of
// consuming the transient retry budget.

/** Confirmed recoverable infrastructure condition: may request one durable
 * outbox retry. */
export class TransientFailure extends Error {
	readonly name = "TransientFailure";
}
/** Known permanent configuration/validation failure: attention immediately,
 * never consumes the transient retry budget. */
export class PermanentFailure extends Error {
	readonly name = "PermanentFailure";
}
