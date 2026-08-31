## Context

The workflow runtime currently exports `QUESTION_WAIT_MS` as five minutes. The runtime uses it when creating each question's persisted `expiresAt`; the authenticated CLI command also uses it as its default wait and as the upper bound for an optional `--timeout` override. The dashboard and answer path already treat the persisted timestamp as the expiry authority. The requested behavior is a longer wait during meetings without removing the safety bound that prevents an agent process from remaining blocked indefinitely.

## Goals / Non-Goals

**Goals:**

- Make 24 hours the default and maximum wait for developer questions.
- Ensure newly persisted questions remain answerable for 24 hours unless explicitly cancelled or expired.
- Keep the existing authenticated flow, FIFO dialogue behavior, cancellation handling, and expiry diagnostics unchanged.
- Add focused tests for the new duration and its boundaries.

**Non-Goals:**

- Do not remove automatic expiry or introduce an indefinite wait.
- Do not change dashboard presentation, authorization, dialogue storage, or answer payloads.
- Do not migrate already-created questions whose `expiresAt` has already been persisted.
- Do not require a repository-wide test command as part of the implementation task.

## Decisions

### Use one shared 24-hour constant

Change `QUESTION_WAIT_MS` to `24 * 60 * 60_000` in the workflow runtime. Reusing this constant for persisted expiry and the CLI default/validation keeps the two layers aligned and avoids a second configuration value.

**Alternative considered:** Add separate runtime and CLI timeout settings. Rejected because it could let the CLI wait longer than the persisted question remains valid, or vice versa, and this change does not require configurable policy.

### Retain a positive bounded `--timeout` override

Keep accepting explicit CLI timeouts from 1 millisecond through the new 24-hour maximum. The override controls how long that invocation waits before it requests expiry; the workflow record continues to use the shared 24-hour persisted deadline, as it does today.

**Alternative considered:** Remove `--timeout` or permit values beyond 24 hours. Rejected because callers may need a shorter bounded wait, while values beyond the persisted policy would create misleading local waits.

### Preserve existing persisted deadlines

No migration will rewrite `expiresAt` values in existing workflow snapshots. A question already created under the five-minute policy retains its recorded deadline; all questions created after deployment receive the 24-hour deadline.

**Alternative considered:** Extend all pending historical questions on first read. Rejected because the original creation policy is not recoverable from the record and silently changing already-visible deadlines could violate user expectations.

## Risks / Trade-offs

- [Longer pending records] → A developer question can occupy one of the bounded dialogue records for up to 24 hours; the existing 100-record and content-size limits remain in force.
- [CLI process lifetime] → A waiting agent process may remain active for up to 24 hours; the existing signal handlers and explicit timeout override still provide cancellation/shortening.
- [Restart behavior] → A restarted CLI invocation observes the durable question status and persisted deadline through the existing runtime state, rather than resetting it.

## Migration Plan

No data migration or dependency change is required. Deploy the constant and focused test changes. New questions use the 24-hour deadline; existing questions keep their stored deadlines. Rollback is a code/configuration rollback; it does not alter stored dialogue records.

## Open Questions

_None._
