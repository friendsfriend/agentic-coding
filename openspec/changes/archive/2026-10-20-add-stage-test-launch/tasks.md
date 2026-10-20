## 1. Dashboard

- [x] 1.1 Add the Stage test type to the independent-work creation form in `src/tui/dash/`: stage picker fed by `GET /api/v1/stages` (excluded stages disabled with their first diagnostic, empty-catalog message), multi-line ticket text, optional ticket reference; submit through the existing start path with `stage` and `ticket`.
- [x] 1.2 If a key is added, declare it in the owning keybind catalog and check the footer and `?` help. — no key was added: the stage step reuses the picker's existing `j/k`, `/`, Enter and Esc, so the dashboard catalog and its footer/help rendering are unchanged.

## 2. Orchestrator

- [x] 2.1 Accept and forward `stage` in the orchestrator's `start_workflow` for `stage-test`; surface `stage-not-configured` in the tool result.
- [x] 2.2 Update the orchestrator guidance and `docs/orchestrator.md` ("Before starting a workflow") with the stage rule.

## 3. Focused checks

- [x] 3.1 Tests for the form (picker states, submit payload) and for the orchestrator tool (forwarding, refusal); run only these files plus `bun run type-check` and `bun run lint` in `agentic-coding/`.
