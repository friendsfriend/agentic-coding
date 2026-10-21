## Why

Every workflow agent receives the same ~18 KB managed-workflow protocol, whatever its role: a stage tester reads how to delegate debug requests, a planner reads how to drive a browser, a verifier reads implementation guidance. Measured on the current tree, the static part of a first assignment is 20.5–28.5 KB per role, and 62–86 % of it is that shared protocol, most of which restates the tool descriptions the same run already receives (~26 KB) and, when `codemode` is on, receives a second time in the `codemode` prompt section (~27 KB). The noise makes agents treat rules for other roles as their own, reach for tools their step never needs and hedge. Each role should get what its step needs and nothing else, without changing what the workflow enforces.

## What Changes

- **Measurement first.** A reproducible prompt inventory (helper module plus script, temp `HOME`/config/pi dirs, no real store) reports, per step and role, the bytes and rough tokens of the assembled prompt split into protocol sections, role instruction, envelope boilerplate and run data, plus the system-side blocks (preamble, context files, tool descriptions, `codemode` section). A budget test fails when a role's static prompt exceeds its family budget; budgets ratchet down phase by phase.
- **Per-role protocol sections.** `workflow-agent-protocol.md` becomes a short always-on core plus optional sections (environment, browser, debug tools, delegated debug requests, file signals, `ask_jev`). Each step declares which optional sections its roles receive; the renderer includes only those. Text that the tool descriptions, the server or the output schemas already carry is deleted rather than reworded.
- **Rules move to where they apply.** The interaction-mode guidance becomes one line beside `Interaction:`; the "never re-ask" rule travels inside the prior-dialogue input block; the peer-question rule travels in the peer-question message; the security-verifier sentence moves into the security brief.
- **Tightened role instructions.** Every role brief is rewritten short and imperative, per family (verifiers and triage; planning family; wiki and research; stage family; debug and env-setup; archive, rebase, implementation). Verifier briefs stay one self-contained asset per role (the existing spec forbids a shared verification asset); their common scaffolding is shortened to one identical wording instead. The stage-test semantics tuned in `stage-test-plan.md`/`stage-test-execute.md` are kept and pinned by tests.
- **Compact `codemode` section.** The `codemode` system-prompt section lists callable tools by name and first sentence instead of repeating every full tool description already sent as the tool definitions.
- No change to `STORE_SCHEMA_VERSION`, workflow definitions or graphs, step ids, role names, step instruction asset lists, output schemas or the event catalog; no migration or compatibility shim. Permission, secrecy, handoff and output-contract rules are kept verbatim in meaning.
- Out of scope, drafted as follow-up `scope-agent-tools-per-step`: registering only the tools a step needs and trimming the tool descriptions themselves (a capability change, not a prompt-text change).

## Capabilities

### New Capabilities
- `agent-prompt-budgets`: the reproducible prompt inventory and the per-family static prompt budgets enforced by a test.

### Modified Capabilities
- `workflow-agent-assignment`: the protocol is rendered per role from a core plus step-selected sections, the interaction mode carries its own one-line guidance, and the prior-dialogue block carries the re-ask rule.
- `durable-agent-tools`: the `codemode` prompt section lists callable tools without repeating their full descriptions.

## Impact

- Instruction assets: every file under `agent-definitions/instructions/` (protocol and role briefs; no file added, renamed or removed). They are embedded: `bun run scripts/generate-embedded.ts` in `agentic-coding/` regenerates the committed `src/workflow/embedded.generated.ts`, and a rebuild/restart is needed before running agents see the new text (in-flight workflows re-materialize their asset copy on the new `AGENT_DEFINITION_VERSION`).
- Code: `src/workflow/assignment.ts`, a new `src/workflow/prompt-sections.ts` and `src/workflow/prompt-inventory.ts`, `src/workflow/steps/types.ts` plus the step behavior modules (one declarative `protocolSections` hook), `src/workflow/effect-runner.ts` (prior-dialogue block line), `src/workflow/runtime/dialogue.ts` (peer-question message line), `src/agent-host/codemode.ts` (section), new `scripts/prompt-inventory.ts`.
- Tests asserting prompt text are updated deliberately (`workflow-assets`, `workflow-steps`, `workflow-plan-fusion`, `workflow-question`, `agent-environment-discovery`, `agent-host-codemode`, `agent-host-tool-surface`, `workflow-wiki-scope`, `debug-workflow`, `env-setup-workflow`, `debug-subagent-request`, stage-test tests); new section-selection and budget tests.
- Docs: `agentic-coding/docs/workflow-architecture.md` (prompt assembly and measured sizes).
