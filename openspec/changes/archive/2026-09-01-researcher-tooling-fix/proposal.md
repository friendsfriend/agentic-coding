## Why

The researcher role's Pi launch passes `--tools <allowlist>` (or falls back to the hard-coded `--tools read`), and pi's own `--tools` flag is a global allowlist that gates built-in, extension, and custom tools alike (confirmed via `pi --help`). Because of this, a configured research extension (e.g. a web-access extension) loads but its tool is silently unusable unless its exact tool name is also enumerated in the profile's `tools` list — a name the operator often does not know ahead of time. A live session reproduced this: `pi-web-access` appeared in `[Extensions]` but the agent had no tool to invoke it, because the launch used `--tools read`. The OpenCode/OpenCode V2 adapters have the analogous restriction: research permissions only `allow` tool names explicitly present in `profile.tools`, with `edit`/`bash` denied. The developer has directed that the fix removes this tool-name gating entirely for research: a researcher session should have every tool available exactly as an ordinary agent launch would, relying on the existing read-only repository-boundary instructions and source-isolation validation as the actual safety boundary rather than a tool-name allow/deny list.

## What Changes

- Pi adapter (`PiAdapter.launch`): stop building a `--tools` allowlist (and the `RESEARCH_MUTATING_PI_TOOLS` filter) for `core.research` launches. Do not pass `--tools` at all for research, so every built-in, extension, and custom tool the runtime would normally expose to any agent is available. Non-research launches keep their existing `--tools`/read-only-fallback behavior unchanged.
- OpenCode/OpenCode V2 adapters (`isolatedOpenCode`): stop writing the restrictive `{ ...allow-listed research tools, edit: deny, bash: deny, read: allow }` permission block for `core.research`. Use the same unrestricted `{ edit: allow, bash: allow, read: allow }` permission configuration already used for non-read-only launches. Non-research read-only launches keep their existing deny-by-default behavior unchanged.
- Keep the existing capability-level bookkeeping (`validateResearchRepositoryProfile` marking the route read-only and stripping `shell`/`edit` capabilities, and the `core.research` startup guard in `runtime.ts` requiring those capabilities be absent) unchanged; this is pinned-route metadata rather than the tool gate, so it survives independent of the launch-argument fix.
- Clarify `agent-definitions/instructions/research.md` (and the regenerated embedded asset) that the researcher's runtime now exposes the same tool surface as any other agent launch, so the read-only repository-boundary rules and the "user-trusted integration" warning are the operative safety boundary, not a missing/present tool name.
- Update the `research-workflow` spec's tool-availability requirement so it describes "no application-level tool gating for research" rather than "every explicitly configured tool name remains available," and update the affected scenario(s) and adapter tests (`test/workflow-adapters.test.ts`) to assert the new argument-free/unrestricted launch shape instead of an allowlist.

## Capabilities

### New Capabilities

None.

### Modified Capabilities

- `research-workflow`: research launches SHALL expose the full tool surface of the selected runtime/profile (no `--tools`/permission-based tool-name gating), instead of requiring every usable tool name to appear in an explicit allowlist.

## Impact

- `agentic-coding/src/workflow/adapters.ts`: `PiAdapter.launch` tool-argument construction and the `isolatedOpenCode` permission block used by `OpenCodeAdapter`/`OpenCodeV2Adapter`.
- `agent-definitions/instructions/research.md` and the generated `agentic-coding/src/workflow/embedded.generated.ts` (regenerated via `bun run build`, never hand-edited).
- `openspec/specs/research-workflow/spec.md`: the "Researcher follows evidence-oriented web research behavior" requirement and its scenarios.
- `agentic-coding/test/workflow-adapters.test.ts`: focused Pi/OpenCode research-launch assertions.
