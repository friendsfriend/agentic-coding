## 1. Research routing policy

- [x] 1.1 Update `agentic-coding/src/workflow/profiles.ts` so research normalization preserves every configured tool name and supported extension, removes only the `shell` and `edit` capabilities, retains the read-only marker, and recomputes the pinned profile digest; verify with a focused profile test that an arbitrary tool and extension survive normalization while unsafe capabilities are still removed.
- [x] 1.2 Update the duplicate research startup guard in `agentic-coding/src/workflow/runtime.ts` to stop applying the hard-coded tool/extension rejection while continuing to require a read-only route without `shell` or `edit`; verify with focused runtime tests that arbitrary configured tools/extensions are accepted and invalid capability combinations remain rejected.

## 2. Runtime-specific launch configuration

- [x] 2.1 Update `agentic-coding/src/workflow/adapters.ts` so a `core.research` Pi launch passes the retained profile tool list and configured extensions without `--no-extensions`, while unrelated read-only launches preserve extension suppression; verify with focused adapter tests for arbitrary tool names, extension arguments, and the non-research read-only case.
- [x] 2.2 Update the isolated OpenCode/OpenCode V2 research configuration in `agentic-coding/src/workflow/adapters.ts` to include configured profile tool names in the runtime's permission configuration without changing non-research defaults; verify by inspecting the generated per-run configuration in focused adapter tests for both OpenCode adapters.

## 3. Research boundary and embedded assets

- [x] 3.1 Clarify `agent-definitions/instructions/research.md` that configured tools/extensions are user-trusted integrations, repository-context research remains subject to source-isolation validation, and external side effects are not sandboxed; verify the source instruction contains both the user-trust warning and the existing read-only repository boundary.
- [x] 3.2 Regenerate `agentic-coding/src/workflow/embedded.generated.ts` using the existing build generator rather than hand-editing the generated file; verify the generated research asset contains the updated instruction and `bun run type-check` succeeds from `agentic-coding/`.

## 4. Source-isolation regression coverage

- [x] 4.1 Add or extend a focused workflow runtime test proving that a configured research integration may be launched with the broadened policy but a mutation to the supplied repository still fails source-isolation validation and is not accepted as a valid research result; verify with the targeted runtime test file only.

## 5. Change validation

- [x] 5.1 Run the focused changed-behavior tests for profiles, adapters, runtime startup/source isolation, and research effects (`bun test test/workflow-adapters.test.ts test/workflow-runtime.test.ts test/workflow-effects.test.ts` from `agentic-coding/`) and record that all pass.
- [x] 5.2 Run `bun run build` from `agentic-coding/` after implementation and verify the generated embedded asset and compiled executable complete successfully; do not substitute the repository-wide test suite for the focused checks above.
