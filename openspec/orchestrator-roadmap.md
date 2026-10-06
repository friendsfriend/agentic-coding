# Orchestrator roadmap

Follow-ups to `add-home-orchestrator` (implemented baseline: Home chat, model
setting, orchestrator capability, review-preserving policy). Each change is
small enough for one implementation workflow; order follows dependencies.

| # | Change | Depends on | Delivers |
| --- | --- | --- | --- |
| 0 | `add-home-orchestrator` | — | Baseline spec of what is implemented (archive first). |
| 1 | `attribute-orchestrator-actions` | 0 | `startedBy`, `principal` on event actors, sidebar mark. |
| 2 | `add-orchestrator-workflow-monitoring` | 1 | Event-driven wake-ups and review notifications. |
| 3 | `cap-orchestrator-launches` | 1 | `max_active` / `max_starts_per_day`, server-enforced. |
| 4 | `add-definition-family-traits` | — | Declared traits + new tier, no behavior change. |
| 5 | `read-family-traits-instead-of-ids` | 4 | Engine reads traits; id-literal guard. |
| 6 | `persist-custom-workflow-definitions` | 5 | Store v5, resolver, `workflow define`. |
| 7 | `add-workflow-blueprint-compiler` | 4, 6 (`compileWorkflow`) | Pure blueprint → manifest, review invariant. |
| 8 | `add-orchestrator-blueprint-workflows` | 1, 3, 6, 7 | Server routes + orchestrator tools for blueprints. |
| 9 | `show-custom-workflow-graph` | 6 (8 for rationale) | Origin badge, rationale, graph dialog. |

Tracks 1–3 (operations) and 4–7 (custom graphs) are independent and can run in
parallel. Open question deferred beyond this roadmap: blueprint step parameters
(verifier role subsets, per-step instructions).
