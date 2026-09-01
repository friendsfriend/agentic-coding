## Context

See `proposal.md` for motivation and `specs/research-workflow/spec.md` for the updated behavior contract. Today `PiAdapter.launch` (`agentic-coding/src/workflow/adapters.ts`) computes a `--tools` argument for `core.research` by filtering the profile's `tools` array to drop `bash`/`edit`/`write` (`RESEARCH_MUTATING_PI_TOOLS`), then passes the remainder as `--tools`, falling back to the hard-coded `--tools read` when the filtered list is empty. Pi's own `--tools` flag ("Comma-separated allowlist of tool names to enable — Applies to built-in, extension, and custom tools", per `pi --help`) makes this an allowlist over *every* tool source, so a configured extension's tool is unusable unless its exact name also appears in the profile's `tools` list. `isolatedOpenCode` has the parallel issue: for `core.research` it writes an opencode permission file that only `allow`s tool names present in `profile.tools`, plus hard-coded `edit: deny`/`bash: deny`/`read: allow`.

The developer resolved the fix direction directly: remove tool-name gating for research entirely so a researcher session gets the same tool surface as any other agent launch on that runtime/profile ("Remove tools flag fully. Should have all tools available. Just like the user spawning a random new agent."). The existing `validateResearchRepositoryProfile` (`profiles.ts`) and the `core.research` startup guard in `runtime.ts` mark the resolved profile read-only and strip the `shell`/`edit` capabilities; those capability fields are pinned-route metadata used elsewhere (extension-suppression decisions, digesting) and are out of scope for this change — this design only changes how `PiAdapter`/`isolatedOpenCode` build their launch arguments/config from a profile, not what capabilities a resolved research profile carries.

## Goals / Non-Goals

**Goals:**
- For `core.research` Pi launches, stop passing `--tools` (and remove the `RESEARCH_MUTATING_PI_TOOLS` filter), so pi's default tool set - every built-in, extension, and custom tool - is available, matching a normal (non-`--tools`-restricted) agent launch.
- For `core.research` OpenCode/OpenCode V2 launches, use the same unrestricted permission block (`{ edit: "allow", bash: "allow", read: "allow" }`) already used for non-read-only launches, instead of the tool-name-limited, `edit`/`bash`-denied block.
- Leave non-research launches (`--tools` allowlist/`read` fallback for Pi; deny-by-default permissions for OpenCode) unchanged.
- Update the research instructions and the `research-workflow` spec to describe the new "no application-level tool gating" contract, and keep the repository read-only boundary and source-isolation validation as the documented safety mechanism.

**Non-Goals:**
- Changing the `shell`/`edit` capability stripping or the `core.research` startup guard in `runtime.ts` - those remain as pinned-route metadata.
- Adding a browser, search provider, MCP server, dependency, or new tool-discovery mechanism.
- Changing the research lifecycle, follow-up behavior, wiki handoff, repository-context startup validation, or user configuration schema (profiles still declare `tools`/`extensions`; those fields simply stop gating research launches).
- Making OpenCode support Pi-style extensions.

## Decisions

1. **Skip `--tools` entirely for Pi research launches instead of building any allowlist or denylist.**
   `PiAdapter.launch` will special-case `ctx.assignment.stepId === "core.research"` to omit the `--tools` argument construction (and the `RESEARCH_MUTATING_PI_TOOLS` filter/constant) altogether, leaving pi's own default tool enablement in effect. Non-research steps keep the existing `ctx.profile.tools`-driven `--tools`/`read`-fallback logic untouched. An `--exclude-tools bash,edit,write` denylist was considered (keeps a targeted mutation guard while still surfacing unnamed extension tools) but was rejected because the developer explicitly directed removing tool gating altogether so research matches a normal agent launch one-to-one, and because the read-only repository boundary plus source-isolation validation already have to carry the actual safety guarantee for any user-trusted integration regardless of which built-in tools are nominally present.

2. **Use the same unrestricted OpenCode permission block for research as any other non-read-only launch.**
   `isolatedOpenCode` currently branches on `ctx.profile.readOnly || ctx.profile.capabilities.includes("read-only")` to build a restrictive permission object, with an inner special case adding `ctx.profile.tools` as extra `allow` entries only for `core.research`. This will change to check `ctx.assignment.stepId === "core.research"` first and, when true, always use `{ edit: "allow", bash: "allow", read: "allow" }` (the same object already used for the non-read-only branch), regardless of `profile.readOnly`/capabilities. Non-research routes keep the existing read-only/non-read-only branching unchanged. This mirrors decision 1: no per-tool-name allow list, and no permission denial that a normal agent launch wouldn't have.

3. **Keep capability metadata (`readOnly`, stripped `shell`/`edit` capabilities) and the `runtime.ts` startup guard as-is.**
   These are unrelated to the launch-argument bug: they gate route validation (e.g. rejecting a resolved research profile that still carries `shell`/`edit` capabilities) and other decisions (e.g. `--no-extensions` suppression for non-research read-only routes), not the tool list itself. Changing them is unnecessary to fix the reported gap and would widen this change's blast radius beyond the two adapters.

4. **Update the research instruction text and spec wording, regenerate the embedded asset.**
   `agent-definitions/instructions/research.md` will state plainly that the researcher's runtime exposes the same tool surface as any other agent launch (including mutating built-ins), so the repository read-only rules and user-trusted-integration warning - not tool-name absence - are what keep repository-context research safe. `agentic-coding/src/workflow/embedded.generated.ts` will be regenerated via `bun run build`, never hand-edited.

## Risks / Trade-offs

- [Risk] Removing tool-name gating means a research session can invoke built-in `bash`/`edit`/`write` tools against a supplied repository, relying entirely on instructions plus after-the-fact source-isolation validation rather than a pre-launch tool restriction. → This is the developer-directed trade-off ("just like a normal agent"); mitigate by keeping the existing source-isolation fingerprint check authoritative and by adding/checking a focused test that a mutation via a now-available tool still fails source-isolation validation and is not accepted as a research result.
- [Risk] Dropping the `RESEARCH_MUTATING_PI_TOOLS` constant and the OpenCode allow-list branch could silently regress unrelated (non-research) routes if the `core.research` step-id check is copied incorrectly. → Gate both changes strictly on `ctx.assignment.stepId === "core.research"`, and keep/extend adapter tests covering both the research and non-research branches for each runtime.
- [Risk] Spec wording drift between the updated requirement and the still-accurate capability-level scenarios (e.g. "Configured research extensions are retained", the mutation/source-isolation scenario) if only some scenarios are edited. → Replace the full requirement block (all scenarios) in the delta spec per MODIFIED-requirement conventions rather than patching one scenario in isolation.

## Migration Plan

No data migration. Existing pinned workflow definitions/routing are unaffected - this only changes how the Pi/OpenCode adapters translate an already-resolved profile into launch arguments/config at research-run start. Users who previously had to enumerate extension tool names in a profile's `tools` list for research no longer need to; that field remains meaningful for non-research routes. Rollback is the normal binary/configuration rollback; no persisted state format changes are introduced.
