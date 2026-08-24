## Context

The workflow engine launches agents through `agent.launch` effects. Pane allocation (`paneForRunFactory` in `src/workflow/cli.ts`) and agent resolution (`resolveLiveAgent` in `src/workflow/effect-runner.ts`) implement reuse-before-spawn: resolve a live agent first (stored handle → canonical name → legacy name), spawn a fresh tab only when nothing resolves.

Agent identity comes from `canonicalAgentName(changeId, definitionId, run)`:

- Persistent steps (plan, implementation, archive): `<role>-<hash8>` where hash8 = SHA-256 over change/definition/step/role. Stable across runs → reuse works.
- Round-scoped steps (`core.triage`, `core.verification`): `<shortrole>-<hash8>-<runId8>`. The run-id suffix was added so each round gets a *fresh* agent.

The problem: every re-entry of these steps creates new runs with fresh UUIDs (`WorkflowEngine.createRun` → `randomUUID()`). Re-entries happen constantly — verification "fix" loop, plan-review loops that bounce back through implementation → verification, the follow-up `test-verifier` run after other verifiers pass. Each re-entry produces new canonical names, so `resolveLiveAgent` never finds the previous round's verifiers and every launch falls through to `tab create`. Old verifier panes stay open but unused. The user-visible symptom is verifiers being spawned anew instead of reused.

## Goals / Non-Goals

**Goals:**

- One stable agent identity per (change, definition, step, role) for ALL steps, including triage and verification.
- Verifiers are reused across rounds: a new round delivers its prompt into the existing verifier pane via the existing `agent.launch` observe path.
- Preserve injectivity: distinct workflows/steps/roles never share a name; 32-char cap respected.
- Grouped-round split geometry keeps working (sibling anchoring resolves by identity, not raw pane ids).

**Non-Goals:**

- Changing the env-pointer / telemetry bridge contract (already supports reused agents).
- Killing or closing orphaned panes from rounds launched before this change (legacy migration only covers name resolution).
- Changing run lifecycle, retry, or round semantics in the engine.

## Decisions

### D1: Drop the run-id discriminator from `canonicalAgentName`

Round-scoped names become `<shortrole>-<hash8>` (same shape as persistent roles; shortrole prefix retained for readability, clamped to fit). Rationale: the hash already encodes change+definition+step+role injectively; the run id added per-round isolation that directly caused the respawn behavior. Rounds are sequential per workflow, so there is never a concurrent same-role pair that needed distinct names.

*Alternative considered:* keying by round index (`-r<N>`) — rejected because it preserves one-fresh-agent-per-round, which is exactly the bug.

### D2: Keep `roundScoped()` for geometry, remove it from naming

`roundScoped(stepId)` stays as the switch for the split-layout branch in `paneForRunFactory` (verifier grids), but no longer alters identity. Naming collapses to one derivation for all roles.

### D3: Sibling resolution must not require persisted handles

In `paneForRunFactory`, sibling lookup currently does `if (!sibling.handle) continue;`. After an engine restart or on a freshly created round, new run rows have no handles even though their role-stable agents are alive. Change to always call `resolveLiveAgent` for siblings of the same step/attempt and use whatever resolves; handles remain the fast path. With role-stable names this is what makes grid geometry anchor onto the surviving panes across rounds.

### D4: Legacy fallback unchanged

`legacyRunName` (pre-canonical scheme) keeps its current shape including run-id suffixes for round-scoped runs, so in-flight workflows launched before both refactors still migrate once. The `legacy === canonical` early-out still applies.

### D5: Prompt delivery replaces round context

Reusing a verifier means its pane carries prior-round conversation context. This is acceptable (and desired — the agent remembers its earlier findings); each round's prompt contains the full assignment, evidence digests, and output contract, so delivery is self-contained. The env pointer is rewritten at every reused-prompt delivery (`writeAgentEnvPointer` in the observe path), so telemetry recovers the *current* run's env even though the pane is shared.

## Risks / Trade-offs

- [Verifier context pollution across rounds] → Prompts are self-contained assignments with explicit output contracts; the interaction protocol already requires completing only the assigned run. If a future round needs isolation, the escape hatch is re-introducing a discriminator — documented, not built now.
- [Stale pointer race: two runs sharing one agent name writing `by-agent/<name>`] → Cannot happen within a workflow (sequential rounds); across workflows names differ by change-id hash. Pointer writes are atomic renames.
- [Launch-window duplicate spawn] → A just-spawned agent may briefly report status `unknown`; a concurrent retry could treat it as dead and spawn again. Pre-existing behavior, unchanged here; retries are lease-serialized in `EffectRunner.drain`.
- [Old per-round panes linger after deploy] → Cosmetic; users close them manually. Out of scope per Non-Goals.

## Migration Plan

Single-repo change, deployed together. No state migration: existing run rows keep their handles; first resolution after deploy adopts canonical names (handle path matches by pane id regardless of stored name keying). Rollback = revert commit; agents spawned under new names simply stop resolving and get fresh tabs under old names.

## Open Questions

(none)
