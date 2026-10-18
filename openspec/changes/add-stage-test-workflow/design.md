## Context

The architecture, options and open questions are in `openspec/changes/add-stage-testing-foundation/design.md` (D1, D6, D7, D8, D9). Verified current state this change builds on: the `debug` family's report-as-output pattern and review actions (`src/workflow/steps/debug.ts`, `src/workflow/definitions/graphs/debug.ts`); the research family's non-code wiki chain `core.wiki` → `core.wiki-approval` with `wiki.verify` on approve and comments looping to `core.wiki` (≤6) (`src/workflow/definitions/graphs/research.ts`); the non-repository research target in engine start (`src/workflow/runtime/engine.ts:1300-1370`); the permitted wiki writer roles and the draft reset on managed writes (`src/workflow/wiki.ts:966-975`); the version-bump rule for registering families (`agentic-coding/docs/workflow-architecture.md`, "Manifest policy and the version-bump rule"); the "Adding a step" checklist (same document).

## Goals / Non-Goals

**Goals:** ticket text in, verdict report out; human gates only where they matter (plan before writing, report, wiki); the wiki improves without silently rewriting knowledge.

**Non-Goals:** dashboard/orchestrator start (phase 4); ticket-system integration; data cleanup automation; adding the steps to the blueprint catalog.

## Decisions

- **Family, not debug flag or blueprint** — see D1 of the foundation design.
- **Target.** Reuse the research (application-owned, non-repository) target: no branch, no worktree, task required, optional read-only repository context. Task 1.1 verifies there is no `core.research` coupling on the start path; if there is, a `stage` target kind is introduced in the same change instead.
- **Three agent roles.** Planner and tester are separate so the plan is a reviewable artifact, the tester starts with a complete route instead of orienting itself (RC3 of `docs/efficiency/03-synthesis.md`), and follow-ups do not repeat planning. No reporter agent: the engine renders the report deterministically (no turns, server timestamps). The wiki writer is its own role because wiki authoring is isolated to dedicated roles.
- **Roles and models.** `stage-planner`, `stage-tester` (vision-capable required), `stage-wiki` join the preset role catalog with single classification; defaults follow the configured default profile. The `stage-tester` preset entry should set a compaction ceiling well below the default, because screenshot-heavy runs are the long runs the efficiency synthesis measured.
- **Gate decisions are engine-owned.** The plan gate is a deterministic `onAgentComplete` transition from the plan output (`createsData`) and the stage's `planApproval`, so the agent cannot skip it. `stage.review` offers three developer actions: approve (→ `core.completed`), approve-and-update-wiki (→ `core.wiki`, offered only when the report has knowledge observations to write), follow-up comment (→ `stage.execute`, ≤3).
- **Retries.** `stage.plan` and `stage.execute` blocked/failed outcomes retry ≤3 (as debug). A stage that is down or a login that fails is not a workflow failure: the tester completes with `blocked` verdicts and the reason.
- **Report validation in `validateEvidence`.** Every expectation has a verdict; `pass`/`fail` cite at least one evidence id; every cited evidence/step id exists; `fail` has a severity. Refusal re-runs the tester with the validation error (bounded by the same retry).
- **Wiki write-back.** The `stage-wiki` role is directive-first (like `research-wiki`) from the approved knowledge observations; rules in the `stage-process-knowledge` spec. A managed wiki write that contains any declared `.env` secret value is refused, a deterministic backstop against a credential reaching the wiki.
- **Stage-only browsing.** For this family the browser routes refuse raw-URL and app-endpoint opens (`stage-test-browsing-restricted`); the pinned stage is the only one openable. The allow-list therefore covers the tester's entire browser surface.

## Risks / Trade-offs

- [Flaky assertions] → retry-once-then-verdict rule, `inconclusive` verdict, `stage_wait` instead of sleeps; the review gate lets the developer ask for a follow-up.
- [Plan gate friction] → only when writing by default; `never` per stage.
- [Contradiction misclassified] → regressions never rewrite the wiki; the developer sees the classification in the report before choosing approve-and-update-wiki and again at `core.wiki-approval`.
- [Long, expensive tester runs] → bounded waits, screenshot cap, `view: false`, journal as memory, compaction ceiling in the preset, follow-ups ≤3.
- [Target reuse leaks research semantics] → verification task; fallback is a dedicated kind.
