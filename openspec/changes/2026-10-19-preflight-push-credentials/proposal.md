## Why

A `delivery.push` that cannot authenticate is attempted, retried unchanged
through the durable outbox, and attempted again. Measured in the imported
telemetry (efficiency review item 16): six `git_operations_failed` events across
three workflows, every one `Permission denied (publickey)` on `git push`; one
workflow retried 11 s and 12 s later with nothing changed, another twice 4.5 min
apart, and the reproduction round added three more workflows whose monitor notes
each listed one workflow id twelve times (3,216 B) behind a ~2 h stall. Every
attempt spends the same seconds to reproduce the same failure, and each one adds
another line to answer.

## What Changes

- Ask the credential question **once**, before `delivery.push` runs any push:
  `git remote get-url --push --all -- <remote>` resolves the URL a push would use
  and `git ls-remote --heads -- <remote>` asks whether this machine holds a
  credential that URL accepts, under `GIT_TERMINAL_PROMPT=0`,
  `GIT_SSH_COMMAND=<the command git would use> -o BatchMode=yes` and the same
  `GIT_ALLOW_PROTOCOL` allowlist the push carries, with the askpass relays
  removed from the environment and a 10 s deadline.
- Block **once**, and only on a positive authentication failure
  (`Permission denied (publickey|password|keyboard-interactive)`,
  `authentication failed`, `invalid username or password`, `access denied`):
  one `PermanentFailure` carrying a note that names the remote and its URL, the
  matched line, and how to fix it. The effect is `failed` with one attempt, the
  workflow enters `attention-required` with that single line, and nothing retries
  it; the operator retry action (`retry-effect:<id>`) gives a fixed push a fresh
  attempt budget.
- Stay fail-open everywhere the check cannot prove an authentication failure: a
  timeout, an unreachable host, a missing repository, an unrecognized error, a
  remote that is a local path, a remote name that does not exist, and no remote
  at all never block a push, and the check's own failure is never an error.
- Skip the check when the push can ask the developer for a credential itself
  (the dashboard and the execution coordinator always attach a credential
  prompt): `BatchMode=yes` cannot reproduce the answer that prompt would give,
  so a non-interactive verdict is not evidence about that push. The
  `credentials-popup` capability's "Push requires a passphrase" scenario is
  therefore unchanged. That path still blocks once — the handler attempts the
  push, and a push that fails with one of the same authentication lines raises
  the same note (`source: push`) instead of being retried unchanged.
- Emit one bounded `delivery.push_preflight` adapter event per attempt (verdict,
  source, masked remote, bounded detail; error outcome only for `auth-failed`),
  and never print, persist or emit credential material: a URL's userinfo password
  is masked and known credential shapes are redacted before anything is reported.
- No new effect kind, no new step, no transition, no store change:
  `STORE_SCHEMA_VERSION` stays 6 and no migration or compatibility shim is added.
  Monitor-note deduplication and digesting stay with efficiency item 18; this
  change only makes the delivery failure happen once.

## Capabilities

### New Capabilities

None.

### Modified Capabilities

- `workflow-state-runtime`: the durable delivery path now preflights its push
  credentials and converts a demonstrated authentication failure into a single
  permanent failure with attention, under the existing durable failure policy.

## Impact

- `src/workflow/push-preflight.ts` (new), `src/workflow/effect-runner.ts` (the
  `delivery.push` handler and one telemetry emitter),
  `scripts/workflow-architecture.ts` (the new module's source layer),
  `test/workflow-push-preflight.test.ts` (new), and
  `docs/workflow-architecture.md` / `docs/workflow-effect-migration.md`.
- `delivery-timeline.git_failures` counts only the legacy `git_operations_*`
  vocabulary and stays at its baseline; the modern shape of the failure is an
  `attention-required` workflow with a failed `delivery.push` effect, which this
  change produces once instead of repeatedly. The new event is visible to the
  existing `events` and `effect-failures` queries, so
  `scripts/efficiency/lib/queries.ts` needs no change.
