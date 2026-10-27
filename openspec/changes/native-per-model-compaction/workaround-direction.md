# Developer direction: host-side compaction overlap workaround

The developer explicitly directed: "No. just build a workaround" after the upstream compaction-overlap gate was reported.

This supersedes waiting for an upstream fix. Continue the existing per-model compaction work with a narrow, tested host-side workaround. Do not fork or patch pi-durable, upgrade dependencies speculatively, or disable automatic compaction globally.

Requirements:

- Prevent concurrent summarizers for the same conversation across manual, native threshold/overflow, and host cost-ceiling paths. An admission mutex covering only host manual calls is insufficient because native generation also admits compaction.
- Retain independent progress across conversations and correct per-model policy resolution.
- Inspect native task ownership and summary-placement behavior before choosing a wait strategy: do not introduce a cycle in which generation waits for manual compaction whose summary placement waits for generation.
- Handle cancellation, failed compaction, shutdown and host reopen without leaked guards or indefinitely blocked conversations. Do not use a process-global compaction-disable flag or assume that a settings getter identifies the current conversation.
- Keep and strengthen test/agent-host-compaction-overlap.test.ts. Its existing 250 ms observation is an initial repro, not sufficient deterministic proof of absence of overlap: prefer explicit latches/admission observations, prove deferred progress after release, and assert maximum concurrent summarizers per conversation.
- Cover both admission orders, concurrent manual requests, failure/cancellation cleanup and two independent conversations. Retain the original per-model, overflow, cost-ceiling, recovery and isolation acceptance criteria.
- Explain the workaround and its limitations in the design and docs. If the safe workaround requires broader behavior changes than this direction, ask the developer rather than silently relaxing acceptance.

Continue in this workflow's current worktree. Preserve existing draft artifacts and untracked regression test. Tests use temporary storage and isolated HOME, AGENTIC_CODING_CONFIG_DIR, PI_CODING_AGENT_DIR and HERDR_WIKI_DIR. No live developer services or real workflow stores may be rebuilt, restarted or exercised by tests.
