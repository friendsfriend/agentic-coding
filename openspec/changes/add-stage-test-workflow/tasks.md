## 1. Start and target

- [ ] 1.1 Verify the research (non-repository) target's start path in `src/workflow/runtime/engine.ts` has no `core.research` coupling beyond task/repository-context handling; if it has, add a `stage` target kind to `src/workflow/registry.ts` and the start path instead.
- [ ] 1.2 Add `stage?: string` to `WorkflowMetadata` (`src/contracts/workflow.ts`); validate it against the stage catalog at start (`stage-not-configured` before any record is written); CLI `workflow start --workflow stage-test --stage IDENT --task … [--ticket REF] [--repo PATH]`.

## 2. Family, steps and roles

- [ ] 2.1 Step contracts and output schemas `core.stage-test-plan@1` and `core.stage-report@1` in `src/workflow/definitions/contracts.ts`; behaviors in `src/workflow/steps/stage-test.ts` (plan-gate transition from `createsData` + stage `planApproval`, review actions approve / approve-and-update-wiki / follow-up, retries ≤3, follow-ups ≤3), following the "Adding a step" checklist (role hooks, role parity, digest coverage).
- [ ] 2.2 Graph `src/workflow/definitions/graphs/stage-test.ts` reusing `core.wiki` / `core.wiki-approval` / `core.completed` / `core.closed` as in `graphs/research.ts`; register in `registerBuiltins.ts` per the version-bump rule (newest tier for new starts, older tiers only for pinned lookups); close stops browser sessions and releases the stage lease.
- [ ] 2.3 Role assets `stage-planner.md`, `stage-tester.md`, `stage-wiki.md` (wiki lookup order, route format, retry-once-then-verdict rule, snapshot-first and `view: false` screenshots, login before recording, data prefix and no destructive actions on foreign data, knowledge observation classification); preset role catalog entries with single classification, tester marked vision-required.

## 3. Restrictions, report and wiki

- [ ] 3.1 Browser routes: in a `stage-test` workflow refuse raw-URL and app-endpoint opens (`stage-test-browsing-restricted`) and any non-pinned stage (`stage-mismatch`).
- [ ] 3.2 Report validation in the execute step's evidence validation and the deterministic `stage-report.md` renderer (redacted); reuse the debug report review surface in the dashboard for line comments.
- [ ] 3.3 `src/workflow/wiki.ts`: permit `stage-wiki` on authenticated `core.wiki` runs; refuse managed draft writes containing a `.env` value without naming it.

## 4. Focused checks

- [ ] 4.1 Tests: start validation (unknown stage, metadata pinned), plan-gate routing for `always`/`when-writing`/`never`, review action routing and bounds, report validation refusals and rendering, browsing restriction, wiki role permission and secret refusal, digest/role-parity coverage for the new steps. Run only these files plus `bun run type-check` and `bun run lint` in `agentic-coding/`; tests use the fake browser driver and temporary config/wiki roots, never a real stage.
