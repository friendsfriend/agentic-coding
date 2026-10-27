# Native per-model compaction

## Effective policy and precedence

The developer approved the per-model design and subsequently authorized the narrow overlap workaround in `workaround-direction.md`.

1. Select the nonempty user-scope `agentHost.compaction` section, otherwise `agents.compaction`, otherwise defaults. This is whole-section precedence, not an overlay between the two sources. Project configuration does not capture settings edits.
2. Merge that section's exact `modelOverrides["provider/modelId"]` entry field by field over its global fields. Provider identity is significant; model IDs may contain further slashes. Entries can set enabled, reserveTokens, backgroundTokens, keepRecentTokens and ceilingTokens. No arbitrary per-conversation threshold API is introduced.
3. Resolve percentage fields against that model's catalog window. Preserve absolute values, existing floors/clamps, default reserve `max(32000, 30% of window)` (capped at half the window), default tail 20000, background lead 32000 and absolute cost ceiling 150000. Ceiling remains absolute-only; 0 disables it. An active ceiling still caps the kept tail at half its value.
4. Without a known window, percentages use their existing absolute defaults. An exact unknown-model entry still applies, but no other conversation supplies a window. An unlisted unknown identity uses global absolute fallback.

The shared native settings getter generates fully resolved exact entries for the catalog and handwritten identities on each read. Native pi-durable chooses the entry from its conversation's current agent model. Startup/resume does not depend on rebuilding the host run map. Model switches and live config reads therefore do not change another conversation's policy. Host ceilings use the same exact config and that run's model window; stage-tester's existing ceiling cap and all growth/admission/loop guards remain.

Example user configuration (JSON):

```json
{
  "agents": {
    "compaction": {
      "keepRecentTokens": "10%",
      "modelOverrides": {
        "local/small": { "reserveTokens": 16000, "backgroundTokens": 4096 },
        "provider/family/large": { "reserveTokens": "35%", "ceilingTokens": 100000 }
      }
    }
  }
}
```

Overrides are handwritten, not a new settings editor. Ordinary settings writes preserve them. Validation reports qualified identity/field errors, including errors in the selected agentHost section. Parsing remains tolerant, as before: unusable field forms fall back instead of preventing durable launch. Settings displays no-window fallback values and explains actual-model resolution.

## Native ownership and model audit (pinned 1.4.0)

The installed README/changelog and targeted implementation audit establish:

- Generation threshold checks and overflow recovery resolve the current model's exact policy. Overflow admits at most one recovery compaction/retry per generation attempt sequence.
- Compaction `select` independently resolves its current agent model and policy. Its request pins model, thinking, stream options and output budget to the checkpoint. The output budget remains `min(0.8 * reserveTokens, model.maxTokens)`; this host does not introduce a separate summarizer model or substitute summarizer capacity for active-model capacity.
- A blocking compaction is owned by generation and appends its summary directly. A manual/background compaction is conversation-owned; it terminates after admitting a summary **write submission**, not after that write is placed. Native stale-cut protection governs placement.

## Host-side overlap workaround

A mandatory registry extension runs a `beforeCompact` hook for all compaction reasons. It reads that conversation's native `pi.live.compactions` and waits for tasks with a lower durable task ID using public `Harness.waitForTask`. Native IDs establish a strict acyclic order. The hook's invocation Context carries cancellation; the scheduler removes the wait on abort/close. There is no process-global disable flag, local lease, copied scheduler, dependency patch, storage migration or new persisted guard.

The first compaction may finish its model call and enqueue a write while generation is waiting. The later task waits only for **task completion**, never for summary placement, avoiding the generation → pending write → generation cycle. Failed/aborted predecessors also release successors. On reopen, waiting select phases rerun and reconstruct ordering from native live state. The host instance is published before scheduler resume so the extension has its public Harness adapter during recovery.

Limitations are deliberate:

- Native task admissions can overlap; summarizer requests are serialized. A later selection was made before the hook wait, so it can produce a redundant summary. Native stale-cut handling is retained rather than reimplementing selection or placement.
- This does not cancel external provider work that ignores native cancellation. Native abort/restart delivery semantics remain unchanged.
- Already checkpointed summarizers created by a host predating this workaround bypass `beforeCompact` on resume; existing legacy duplicate summarize checkpoints cannot be retroactively serialized by this select-phase hook. Newly selected tasks observe those existing live predecessors. No migration or native task rewrite is introduced.
- Native conversation-owned background work survives conversation abort; tests verify a subsequent submission progresses after cancellation/reopen, rather than redefining upstream background ownership.

## Validation

Focused tests use temporary host/config storage and externally isolated HOME, AGENTIC_CODING_CONFIG_DIR, PI_CODING_AGENT_DIR and HERDR_WIKI_DIR. Latches and an explicit waiting-hook observation replace the original 250ms absence check. Tests measure maximum concurrent summarizers, await all native compaction tasks finishing, check independent progress, both admission orders, concurrent manuals, background → blocking, failure, cancellation and temporary SQLite reopen. Pure and real-host tests cover exact identity/fallback, live edits, switches, mixed windows, invalid config, threshold and overflow. Existing ceiling and failure/settings regressions remain gates.
