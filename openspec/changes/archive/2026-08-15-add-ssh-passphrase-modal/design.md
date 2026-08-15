## Context

Engine git effects run in-process via `agentEffectHandlers` (`agentic-coding/src/workflow/effect-runner.ts`). `delivery.push` executes `git push --set-upstream <remote> <branch>` through a synchronous `Bun.spawnSync` helper. With a passphrase-protected key and no ssh-agent, ssh cannot prompt (no tty, no askpass program) and the effect fails with `Permission denied (publickey)`; the outbox retry policy retries, then the delivery step fails and the workflow cannot complete.

Dashboard actions run the engine in-process (`agentic-coding/src/tui/dash/engine.ts` → `drainEffects`), so the UI and the effect runner share one process and one event loop. The CLI (`agentic-coding/src/workflow/cli.ts` `run`) drains the same handlers without any UI. `drainEffects` is called from `getWorkflowView`, `runWorkflowAction`, `startWorkflowInProcess` (dash) and the CLI commands.

lazygit reference behavior (jesseduffield/lazygit): network commands (push, pull, fetch, remote, tag) are marked `PromptOnCredentialRequest` and run in a PTY with `LANG=C LC_ALL=C LC_MESSAGES=C`; output is scanned byte-by-byte for prompt regexes (`Enter passphrase for key '...':`, `Password:`, `Username for '...':`, PIN, 2FA token); on match a masked popup appears, the answer is written to the process stdin and the command continues; cancel writes empty input, which aborts the process; background commands use `FailOnCredentialRequest` (kill the process on prompt).

## Goals / Non-Goals

**Goals:**
- Ask for the SSH passphrase only when a git command run by the engine actually requires one, via a masked on-demand popup (lazygit-style UX).
- Feed the answer to the already-running command so the workflow continues without restart.
- Fail fast and clearly in non-interactive (CLI) contexts.
- Remove the Agent routing summary row from the new-workflow confirm step.

**Non-Goals:**
- Adding a passphrase/credential step to the new-workflow wizard (removal is the goal; the step is already gone from the code).
- Handling gh/glab credentials for `pull-request.create` — they manage their own auth flows.
- Managing ssh-agent, credential storage, or git config.
- Changing the git tab's lazygit behavior — lazygit already shows its own credentials popup.

## Decisions

### D1: Askpass bridge instead of PTY output scanning

Network git commands run with env: `SSH_ASKPASS=<shim>`, `SSH_ASKPASS_REQUIRE=force` (OpenSSH ≥ 8.4), `GIT_ASKPASS=<shim>` (HTTPS prompts), `LANG=C LC_ALL=C LC_MESSAGES=C`, and `AGENTIC_CODING_ASKPASS_DIR=<per-process 0700 temp dir>`.

The shim is a tiny `#!/bin/sh` script written to that dir (mode 0700): it writes the prompt text (ssh passes it as `$1`, e.g. `Enter passphrase for key '/home/me/.ssh/id_ed25519':`) to a request FIFO, then blocks reading a response FIFO and echoes the answer (empty on timeout).

`runGitWithCredentials(cwd, args, prompt)` spawns `git` asynchronously (`Bun.spawn`, piped stdio), watches the request FIFO, calls the injected `prompt(promptText)` which resolves to the user's answer, writes it to the response FIFO, and the running command continues. No PTY is needed: ssh itself decides when a credential is required, so the popup appears only on demand and shows the verbatim prompt text.

Alternatives considered and rejected:

- **PTY + output scanning (lazygit's exact mechanism)**: Bun has no native PTY API; wrapping with `script -qec` is platform-fragile, adds ANSI noise, complicates output capture, and needs extra spawn layers. The askpass bridge reproduces the same on-demand popup UX with the verbatim prompt and plain pipes.
- **Pre-unlock via `ssh-add` at workflow start (legacy `unlock_ssh_keys` approach)**: re-introduces proactive secret handling, asks for a secret before it is known to be needed, and does not help commands that run later (delivery). Rejected.
- **GIT_ASKPASS only**: does not cover ssh passphrase prompts (ssh uses SSH_ASKPASS); both are set.

### D2: Scope — the credential-aware runner applies to network git effects

Today only `delivery.push` touches the network. `delivery.commit`, `workspace.setup` (branch switch), and `workspace.cleanup` are local and stay on the plain sync helper. The runner is generic so future network effects (e.g. a start-time fetch) can opt in. `pull-request.create` (gh/glab) is out of scope.

### D3: Bridge injection — dashboard interactive, CLI fail-fast

`drainEffects(engine, repo, credentials?)` and `agentEffectHandlers(..., { credentialPrompt })` gain an optional prompt provider. The dashboard (`engine.ts`) passes a bridge backed by a module-level pending-request store consumed by the `CredentialsModal`; the CLI passes nothing, so a credential request fails the effect immediately with an actionable diagnostic including the prompt and a hint to unlock the key or run from the dashboard — the analogue of lazygit's `FAIL` strategy for background commands.

### D4: Popup wiring

New `CredentialsModal` (GenericModal-based, masked `*` input, title = verbatim prompt text, help: Enter submit / Esc cancel). A new `credentials` keymap layer in `App.tsx` handles keys while the popup is open; it must **not** be gated on `busy()` — the delivery drain runs while the dashboard is busy (`finishDeveloperReview` / action runner set `busy(true)`), so a busy gate would swallow the popup's keys. The modal renders above other modals (zIndex). Esc or empty submit cancels: the answer is empty → ssh aborts → the push fails with its original stderr → the existing effect retry policy applies (delivery failure loops, maxAttempts 3). If a second credential request arrives while one popup is open, the pending request is replaced by the latest prompt.

### D5: Security

Per-process temp dir `0700`, shim `0700`, FIFOs `0600`, answer unlinked immediately after read; the passphrase never appears in argv, env, or logs; input is masked in the UI; the shim times out (~120 s) so a missing/backgrounded UI can never hang the git process; cleanup in `finally`.

### D6: Masking heuristic

Mask input unless the prompt matches `/username/i` (lazygit masks passphrase/password/PIN/token, not username).

## Risks / Trade-offs

- **Askpass coverage**: requires OpenSSH ≥ 8.4 for `SSH_ASKPASS_REQUIRE=force`; older ssh without DISPLAY would not invoke askpass — the effect then fails with the original error rather than hanging (acceptable, matches current behavior).
- **Concurrent requests**: only one in-flight request is supported (`delivery.push` is single-threaded); a second request supersedes the first with the latest prompt.
- **Backgrounded UI**: if the dashboard is not visible while push runs, the shim waits up to the timeout, then the command fails cleanly — no hang.
- **FIFO choreography** is the most intricate piece; it is covered by unit tests that exercise the shim contract with a fake askpass consumer (no real ssh or network needed).
