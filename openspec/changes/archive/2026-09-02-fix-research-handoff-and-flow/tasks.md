## 1. Enriched handoff schema

- [x] 1.1 Extend the `ResearchHandoff` contract in `src/workflow/definitions.ts` to add a `directives` array (each `{ target, intent: "create"|"update", claims[], citations[] }`) alongside the existing subject, canonical target, freeform narrative, citations, and no-sources fields; require at least one directive, each with a non-empty target, valid intent, and at least one non-empty claim, and add bounded caps (directive count, per-field text length) while keeping the serialized byte guard. Verify by adding/updating contract unit tests that a valid enriched handoff parses and that missing directives, empty claims, and invalid intent are rejected with actionable messages.

## 2. Researcher-initiated record-and-transition

- [x] 2.1 In `src/workflow/runtime.ts`, make the `agent.research-handoff` handling (`recordResearchHandoff`) perform the transition: after parsing/validating the enriched handoff, run `validateSourceBaseline`, verify the workspace is ready, build the research context, expire the active researcher run(s) with `agent.stop`, and `transition(..., "request-wiki", researchContext)` into `core.wiki`; on any failure throw an actionable `WorkflowRuntimeError` and leave the run active at `core.research`. Verify with runtime tests: a valid handoff transitions to `core.wiki` and stops the researcher run; an invalid handoff, failed source-isolation, or missing workspace keeps the workflow at `core.research` with the run active.
- [x] 2.2 Remove the `request-research-wiki` developer action branch from `runtime.ts` action handling and drop it from the exposed `actions()` list for the active research step, leaving `close-research` and `research-follow-up` intact. Verify with a runtime test asserting `request-research-wiki` is no longer an available action during `core.research` and that dispatching it is rejected.

## 3. CLI and command surface

- [x] 3.1 Extend the `research-handoff` CLI command in `src/workflow/cli.ts` to accept the directives payload (e.g. a JSON `--directives` flag) and the freeform narrative, keeping `--subject`, `--target`, `--citations`, `--no-sources`, and update its usage/help text. Verify with a CLI test that the command builds a valid enriched handoff and drives the transition, and that it remains restricted to the authenticated active `core.research` researcher run.
- [x] 3.2 Confirm/adjust the `agent.research-handoff` command parsing in `src/workflow/contracts.ts` so the enriched `handoff` payload flows through unchanged and is validated via `researchHandoffContract.parse`. Verify with a contracts/CLI test covering the round-trip.

## 4. Wiki assignment consumption

- [x] 4.1 Update the `core.wiki` assignment input in `src/workflow/effect-runner.ts` so the wiki run receives the directives as its primary actionable input (which concepts to create/update and the facts to record) plus the narrative and citations, keeping the untrusted-evidence framing and corroborate-against-repository-and-wiki guidance, and update the researcher assignment/permissions text to describe the single researcher-initiated command. Verify with an effects test asserting the `core.wiki` assignment contains the directive content and no longer references a developer dashboard wiki action.

## 5. Dashboard

- [x] 5.1 Remove the "Create wiki draft" (`request-research-wiki`) menu item from the active research phase in `src/tui/dash/data.ts`, leaving follow-up and close-research. Verify with the dash data test (or a new assertion) that the active-research action list excludes the wiki-draft item.

## 6. Instruction assets

- [x] 6.1 Rewrite the "Wiki drafting handoff" section of `agent-definitions/instructions/research.md` to describe gathering per-concept directives during research and dispatching the single researcher-initiated command on explicit user request (no dashboard step), and update the "Interactive follow-ups and lifecycle" / "Generic handoff" text that references `request-research-wiki` as a developer action. Update `src/workflow/assignment.ts` handoff-guidance text for `core.research` to match. Verify by reading the rendered assignment text in a test/assertion.
- [x] 6.2 Rewrite the "Research handoff input" section of `agent-definitions/instructions/wiki.md` so it directs the wiki agent to treat the structured directives as the actionable starting point for which concepts to create/update, while still corroborating against repository evidence and the centralized wiki. Verify by inspecting the updated instruction content.
- [x] 6.3 Run `bun run build` to regenerate `src/workflow/embedded.generated.ts` so the instruction digests match the edited assets; do not hand-edit the generated file. Verify that `bun run type-check` and the registry digest checks pass.

## 7. Validation

- [x] 7.1 Run the change-relevant test files (research handoff/transition, wiki assignment, CLI, dash data) and `bun run type-check` and `bun run lint`, and confirm zero diagnostics and passing focused tests for the changed behavior.
