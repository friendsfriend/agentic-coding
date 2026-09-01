## 1. Pi research launch

- [x] 1.1 In `agentic-coding/src/workflow/adapters.ts`, change `PiAdapter.launch` so that for `ctx.assignment.stepId === "core.research"` it never builds or pushes a `--tools` argument (leaving pi's default tool enablement in effect), while non-research steps keep the existing `ctx.profile.tools`-driven `--tools`/`read`-fallback logic unchanged; remove the now-unused `RESEARCH_MUTATING_PI_TOOLS` constant and its filter. Verify with a focused test in `agentic-coding/test/workflow-adapters.test.ts` asserting a research launch's `agent start` arguments contain no `--tools` flag even when the profile's `tools` array includes `bash`/`edit`/`write`/custom names, and that a configured extension path is still present in the arguments.
- [x] 1.2 Update or replace the existing "research launch retains configured Pi tools and extensions" test in `agentic-coding/test/workflow-adapters.test.ts` (previously asserting `--tools read,web_search`) to match the new argument-free launch shape, and confirm the pre-existing non-research Pi launch test (asserting `--tools bash,read`) still passes unmodified.

## 2. OpenCode research launch

- [x] 2.1 In `agentic-coding/src/workflow/adapters.ts`, change `isolatedOpenCode` so that when `ctx.assignment.stepId === "core.research"` the generated `opencode.json` always uses the unrestricted `{ edit: "allow", bash: "allow", read: "allow" }` permission block (the same object already used for non-read-only launches), regardless of `ctx.profile.readOnly`/capabilities, removing the per-tool-name `allow` mapping built from `ctx.profile.tools`; non-research routes keep their existing read-only/non-read-only branching unchanged. Verify with a focused test in `agentic-coding/test/workflow-adapters.test.ts` inspecting the generated `opencode.json` for both `OpenCodeAdapter` and `OpenCodeV2Adapter` on a `core.research` launch with a read-only profile, asserting `edit`/`bash`/`read` are all `"allow"` and no other tool-name keys are written.
- [x] 2.2 Confirm the existing non-research OpenCode/OpenCode V2 read-only permission test (if any) still asserts `edit: "deny"`, `bash: "deny"`, `read: "allow"` unchanged; add one if the current suite only covers the research case.

## 3. Research instructions and spec wording

- [x] 3.1 Update `agent-definitions/instructions/research.md` to state that the researcher's runtime exposes the same tool surface as any other agent launch (including built-in mutating tools), so the repository read-only boundary and user-trusted-integration warning - not tool-name availability - are what keep repository-context research safe; verify by reading the updated file for both the "same tool surface as any agent" statement and the retained read-only repository-boundary section.
- [x] 3.2 Regenerate `agentic-coding/src/workflow/embedded.generated.ts` via `bun run build` from `agentic-coding/` (never hand-edit the generated file); verify the generated research asset contains the updated instruction text and `bun run type-check` succeeds.

## 4. Source-isolation regression coverage

- [x] 4.1 Add or extend a focused workflow runtime/effects test proving that, with the widened research tool surface, a mutation to a supplied repository during a research run still fails source-isolation validation and is not accepted as a valid research result; verify with the targeted test file(s) only (e.g. `agentic-coding/test/workflow-runtime.test.ts` or `agentic-coding/test/workflow-effects.test.ts`).

## 5. Change validation

- [x] 5.1 Run the focused changed-behavior tests for adapters, runtime research startup, and research effects (for example `bun test test/workflow-adapters.test.ts test/workflow-runtime.test.ts test/workflow-effects.test.ts` from `agentic-coding/`) and record that all pass; do not substitute or require the full repository test suite.
- [x] 5.2 Run `bun run lint` and `bun run type-check` from `agentic-coding/` and confirm both report zero diagnostics/errors for the changed files.
