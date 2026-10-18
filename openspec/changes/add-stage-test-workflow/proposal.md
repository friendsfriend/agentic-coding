## Why

With stage configuration and credential-safe sessions (phase 1, `add-stage-testing-foundation`) and journaled multi-application evidence (phase 2, `add-stage-flow-evidence`) in place, the developer still has to drive a stage test by hand through a `debug` run, which needs a branch and a detached worktree and has no plan step, no plan gate, no wiki loop and a free-form report (`openspec/specs/debug-workflow/spec.md`). The goal is a workflow where the developer hands in only the ticket text and a stage, and gets back an evidence report with a verdict per expected behaviour — while the process knowledge the agent needed is read from the wiki and improved through the existing review gate.

## What Changes

- **New built-in workflow family `stage-test`** on the application-owned non-repository target (as `research`), optional read-only repository context, never delivers code. Steps: `stage.plan` (role `stage-planner`) → optional `stage.plan-review` (developer) → `stage.execute` (role `stage-tester`) → `stage.review` (developer: approve / approve-and-update-wiki / follow-up) → `core.wiki` (role `stage-wiki`) → `core.wiki-approval` → `core.completed` → `core.closed`.
- **Pinned stage.** `workflow start --workflow stage-test --stage IDENT --task "<ticket text>" [--ticket REF] [--repo PATH]` validates the stage against the catalog before anything is written and stores `stage` in workflow metadata (snapshot JSON; store schema stays 6).
- **Plan gate decided by the engine:** `stage.plan`'s completion is turned into `needs-approval` when the stage's `planApproval` is `always`, or `when-writing` and the plan declares data creation on a writable stage.
- **Stage-only browsing:** in this family, `browser_open` with a raw `url` or an app endpoint is refused; only the pinned stage's applications can be opened.
- **Structured outputs and an engine-rendered report:** `core.stage-test-plan@1` and `core.stage-report@1`; the engine renders `stage-report.md` (ticket summary, stage and versions, plan, findings per expectation with `pass | fail | blocked | inconclusive`, timeline/reproduction steps, created data, proposed wiki updates, not tested) from the outputs, journal and manifest, redacted, and refuses a report without evidence for a pass/fail or with dangling ids.
- **Process knowledge in the wiki:** page structure `projects/<system>/processes/<process>` (type `process`), `projects/<system>/stages/<stage>` (type `stage-notes`), `projects/<system>/processes/index`; the planner reads it before testing, the tester records knowledge observations, the `stage-wiki` role writes back only after the developer chooses approve-and-update-wiki, contradictions suspected as regressions are flagged as disputed instead of overwritten, confirmations are not written.
- **`stage-wiki`** joins the roles permitted to write wiki drafts; a managed wiki write containing a declared `.env` secret value is refused.
- Close stops the workflow's browser sessions and releases its stage lease.

## Capabilities

### New Capabilities

- `stage-test-workflow`: the family, its steps, gates, roles, start requirements, browsing restriction, outputs, report rendering and validation, follow-ups and close.
- `stage-process-knowledge`: the wiki page structure for process flows, how a ticket finds its page, knowledge observations, write-back rules and staleness/contradiction flagging.

### Modified Capabilities

- `knowledge-wiki`: the dedicated `stage-wiki` role may write drafts in an authenticated `core.wiki` run of a stage test; managed writes refuse declared secret values.

## Impact

- `src/workflow/definitions/graphs/stage-test.ts`, `src/workflow/steps/stage-test.ts`, step contracts and output schemas in `src/workflow/definitions/contracts.ts`, registration in `registerBuiltins.ts` per the version-bump rule, role assets (`stage-planner.md`, `stage-tester.md`, `stage-wiki.md`), preset role catalog.
- `src/contracts/workflow.ts` (`stage?: string` metadata), engine start validation, CLI `start --stage`.
- `src/workflow/wiki.ts` (permitted role, secret refusal), dashboard report review reuse (`src/tui/dash/App.tsx` report comments).
- Depends on `add-stage-testing-foundation` and `add-stage-flow-evidence`.
