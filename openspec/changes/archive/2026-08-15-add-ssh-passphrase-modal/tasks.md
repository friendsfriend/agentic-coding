# Tasks

## 1. Credential-aware git runner

- [x] 1.1 Add `agentic-coding/src/workflow/credentials.ts` exporting `runGitWithCredentials(cwd, args, prompt?)` and `installAskpassShim(dir)`: spawn git with `SSH_ASKPASS`/`SSH_ASKPASS_REQUIRE=force`/`GIT_ASKPASS`/`LANG=C`, 0700 shim + FIFO rendezvous, ~120 s timeout, cleanup in `finally`.
- [x] 1.2 Without a prompt provider, fail fast with an actionable diagnostic (include prompt text) instead of hanging.
- [x] 1.3 Masking heuristic: mask input unless the prompt matches `/username/i`.

## 2. Effect-runner integration

- [x] 2.1 Extend `drainEffects(engine, repo, credentials?)` and `agentEffectHandlers(..., { credentialPrompt })` in `agentic-coding/src/workflow/cli.ts` and `agentic-coding/src/workflow/effect-runner.ts`.
- [x] 2.2 Route `delivery.push` through the credential-aware runner when a provider is attached; keep local effects on the plain sync helper.

## 3. Dashboard popup

- [x] 3.1 Add `agentic-coding/src/tui/dash/ui/CredentialsModal.tsx` (masked input, prompt title, Enter submit / Esc cancel) and a module-level pending-request bridge.
- [x] 3.2 Wire the bridge into the `engine.ts` drain calls; register a non-busy-gated `credentials` keymap layer in `App.tsx` and render the modal above other modals.

## 4. Wizard cleanup

- [x] 4.1 Remove the `Agent routing` summary entry in `agentic-coding/src/tui/dash/ui/NewWorkflowModal.tsx` (confirm summary).
- [x] 4.2 Confirm the new-workflow wizard contains no passphrase input step (formalize removal; no code change expected).

## 5. Tests and verification

- [x] 5.1 Add `agentic-coding/test/workflow-credentials.test.ts`: prompt detected → callback invoked with verbatim prompt → answer fed → command completes; no prompt → no callback; cancel/empty → command fails; no provider → fail-fast error; masking heuristic; timeout.
- [x] 5.2 Add `agentic-coding/test/dash/credentialsModal.test.tsx` (render + masked input) and a NewWorkflowModal confirm-summary test asserting no `Agent routing` row.
- [x] 5.3 Run `bun test`, `bun run type-check`, `bun run build`; all pass with no regressions.
