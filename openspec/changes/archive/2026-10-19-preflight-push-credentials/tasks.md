## 1. The preflight

- [x] 1.1 Add `src/workflow/push-preflight.ts`: the verdict model (`ok`,
  `auth-failed`, `inconclusive`, `skipped-interactive`, `skipped-local`,
  `skipped-no-remote`), the positive-authentication allowlist, the local-path and
  URL predicates, the masking/redaction of a reported remote, the non-interactive
  environment and ssh command, the actionable note, and `pushPreflightEffect`
  over `runProcessEffect` with an injected deadline.
- [x] 1.2 Resolve the remote a push would use
  (`git remote get-url --push --all -- <remote>`; a configured URL resolves to
  itself) and skip without a subprocess when there is no remote or it is local.
- [x] 1.3 Bound the check: `PUSH_PREFLIGHT_TIMEOUT_MS` 10 s, 5 s for the
  `core.sshCommand` read, 64 KiB of output, a 300-character reported fragment,
  and a check that can never prompt (askpass relays removed, `BatchMode=yes`
  appended to git's own ssh command, `GIT_ALLOW_PROTOCOL` allowlisted).

## 2. The delivery push handler

- [x] 2.1 Run the preflight inside `delivery.push`'s `execute` after the remote
  and branch safety checks; block with one `PermanentFailure(pushAuthFailureNote)`
  on `auth-failed` and otherwise push exactly as before.
- [x] 2.2 Skip the preflight when the handler has a credential prompt attached,
  and classify the real push's own authentication failure (`Effect.either` →
  `source: push`) into the same block, so the interactive path blocks once too
  without changing any other failure's classification.
- [x] 2.3 Emit one `delivery.push_preflight` adapter envelope per attempt
  (`herdr.delivery.push.{preflight,source,remote,detail}`), wrapped so telemetry
  cannot alter the outcome.

## 3. Registration and documentation

- [x] 3.1 Classify `workflow/push-preflight.ts` as a runtime source layer in
  `scripts/workflow-architecture.ts`, and list it in the layer matrix and the
  Effect-migration module group.
- [x] 3.2 Document the preflight, the fail-open rule, the interactive skip, the
  block-once and `retry-effect` recovery path, the telemetry keys, the
  verification queries, and the `git_operations_failed` legacy note in
  `docs/workflow-architecture.md`.

## 4. Verification

- [x] 4.1 Unit tests: the recognized/ignored failure lines, local-path and URL
  classification, masking and the note's content (no credential, names the remote
  and URL, says the effect is not retried), the ssh command's precedence, and the
  environment (askpass removed, `GIT_TERMINAL_PROMPT=0`, `PATH` kept,
  `GIT_ALLOW_PROTOCOL` set).
- [x] 4.2 Verdict tests against a stand-in `ssh`: refused credentials →
  `auth-failed`, unreachable host → `inconclusive`, accepted → `ok`, a slow check
  under an injected deadline → `inconclusive` and fast, plus the three skips
  (local remote, missing remote, interactive push) starting no subprocess.
- [x] 4.3 Handler tests through a real `EffectRunner.drain`: a refused preflight
  leaves the effect `failed` with one attempt, one attention note, no push at all
  and no ref in the bare remote, then completes after the credential is fixed and
  `retry-effect` is dispatched; an unreachable preflight does not block the push
  and records no attention; a push that the preflight left to a credential prompt
  blocks once from the push; and a local remote is a skip rather than a block.
- [x] 4.4 `bun run type-check` 0 errors, `bun run test` passes, `bun run lint` is
  clean, and `openspec validate --changes --strict` passes.
