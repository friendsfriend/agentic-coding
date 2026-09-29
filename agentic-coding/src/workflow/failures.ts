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
/** The selected classifier provider cannot serve a request right now — an
 * uninstalled/unstarted local sidecar or a failed local verification. This is
 * the ONE classifier failure that fails open (routing keeps the pool default;
 * triage and gates force-run), because a local-provider failure must never
 * block a workflow. A hosted transport/status failure stays a
 * `TransientFailure`/`PermanentFailure` so the durable outbox still retries it. */
export class ClassifierUnavailable extends Error {
	readonly name = "ClassifierUnavailable";
}
