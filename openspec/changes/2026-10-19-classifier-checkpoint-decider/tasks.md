## 1. Shadow recording

- [ ] 1.1 Add `shadow`, `decider` and `advisor` to `[agents.checkpoint]` validation (defaults: no shadow, `rules`, `off`) with validation tests
- [ ] 1.2 Ask the configured classifier the checkpoint `choice` question from the host with the digest as the only state and a 10 s bound; record the shadow answer in `runtime.checkpoint` and, within the per-run cap, as an unapplied `progress-checkpoint` record; tests with a fake classifier for answer, no-answer and timeout

## 2. Classifier decider

- [ ] 2.1 Apply the classifier decision behind the rule guards (`hard-limit`, `no-progress-twice`, `steer-ignored`), map `steer` to the strongest present signal's catalog nudge, fall back to the rule decision on any unusable answer; unit tests for each path, including that `confidence` never changes the outcome
- [ ] 2.2 Implement the off-by-default advisor fallback with structured single-label output; tests that it is never called by default and that a non-vocabulary answer falls back to the rules

## 3. Gate and verification

- [ ] 3.1 Add the `checkpoint-decider-eval` query with fixture tests (gate not met below the minimum counts; each of the three criteria computed)
- [ ] 3.2 Run the focused tests of the touched modules with a temporary `HOME`, `AGENTIC_CODING_CONFIG_DIR` and `HERDR_WIKI_DIR`; `bun run lint` and `bun run type-check` end clean; `openspec validate 2026-10-19-classifier-checkpoint-decider --strict` passes
