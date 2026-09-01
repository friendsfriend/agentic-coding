## Context

See `proposal.md` - Why. Relevant existing code:

- `paneForRunFactory` in `src/workflow/cli.ts` returns `{ paneId: string; tabId?: string }` from one of several return points: an adopted live agent's pane (`resolveLiveAgent`), an existing sibling/bottom-row pane found via `herdr.call("pane", "layout", ...)` (the `bottomPane` helper), a pane created by `split()`, or a pane created by `tab create`.
- `AdapterEffectOptions.paneForRun` in `src/workflow/effect-runner.ts` is the contract the `agent.launch` effect handler calls to get a pane before invoking `adapter.launch()`. On a thrown error from `adapter.launch()`, the handler currently always calls `options.herdr.call("pane", "close", pane.paneId)` before rethrowing, regardless of whether that pane was just created or was an existing agent's pane being reused.

## Goals / Non-Goals

**Goals:**
- Make the pane-allocation result self-describing about ownership so the launch-failure cleanup can be conditioned on it without re-deriving reuse-vs-create logic in the effect handler.
- Preserve existing cleanup behavior for genuinely newly created panes (tab create, split) - no pane leaks on failure for those paths.
- Keep `resolveLiveAgent`, canonical naming, and the reuse-before-spawn resolution order completely unchanged; this is a failure-path cleanup fix only.

**Non-Goals:**
- Not reworking round-scoped geometry (`verificationPosition`, `bottomPane`, `split` anchoring) - only tagging their existing return points with an ownership flag.
- Not adding pane-leak detection/reconciliation for panes that fail to launch and are correctly left open (out of scope; Herdr-side pane lifecycle is unaffected).
- Not changing `agent.launch`'s `cancel` handler (concurrent-cancellation path), which stops the launched handle rather than closing a pane and is unaffected by this bug.

## Decisions

- **Ownership flag on the pane-allocation result, not a side lookup.** Add an `owned: boolean` field to the object `paneForRun` resolves to (`{ paneId, tabId?, owned }`). Every return point in `paneForRunFactory` sets it explicitly: `resolved.paneId` (live-agent reuse) and the `bottomPane(...)` reuse paths set `owned: false`; every `split(...)` result and the `tab create` result set `owned: true`. This keeps the ownership decision co-located with the code that already knows whether it created or found the pane, instead of asking the effect handler to re-derive it from `paneId` alone (which cannot distinguish reuse from creation).
  - Alternative considered: infer ownership in the effect handler by checking whether `pane.paneId` matches a live agent right before closing. Rejected - adds a second Herdr round-trip on the failure path, race-prone (the agent may have just died for unrelated reasons), and duplicates knowledge the allocator already has for free.
- **Default `owned` to `false` when absent from the `paneForRun` contract's return value, rather than making it a required field with no default.** The interface declares `owned: boolean` as present on the resolved value, but the effect handler treats `pane.owned === true` as the only closing condition (not `pane.owned !== false`). This keeps existing/[future] test doubles that stub `paneForRun` without the field safe by construction: forgetting to set it fails safe (never closes) rather than failing dangerous (closes a live pane).
- **Scope the fix to the single `catch` block around `adapter.launch()` in the `agent.launch` handler.** No other call site closes a pane on launch failure; the `cancel` handler stops the agent handle, not the pane, and is unaffected.

## Risks / Trade-offs

- [Forgetting to set `owned: true` on a genuinely new pane would leak it on failure] → Mitigated by keeping all pane-creation code paths (`split`, `tab create`) in one function (`paneForRunFactory`) and covering both branches (reused vs. created) with explicit regression tests asserting the presence/absence of the `pane close` call.
- [`bottomPane` reuse is geometry-based, not liveness-based - the "existing" pane it finds could in principle be empty/dead] → Out of scope for this fix: marking it `owned: false` is still strictly safer than today's unconditional close, and matches the proposal's explicit instruction ("Never close a reused verifier pane"); tightening `bottomPane` liveness confirmation is a separate concern already governed by the "Reuse before spawn" requirement's existing scenarios.

