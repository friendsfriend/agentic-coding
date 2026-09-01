## Context

See `proposal.md` for the motivation and `specs/research-workflow/spec.md` for the behavior contract. Research routing currently applies the same hard-coded tool-name check in profile normalization and workflow startup, marks the route read-only, and strips extensions. The Pi adapter also disables extensions whenever a profile is read-only. Research source isolation is separately enforced by a baseline fingerprint for repository-context runs.

## Goals / Non-Goals

**Goals:**

- Make the selected research profile's configured tool names available without a second application-level name allowlist.
- Preserve configured Pi extensions that provide user-defined research tools.
- Keep capability-level restrictions that prevent the research route from declaring shell or edit capabilities, and retain source-baseline validation for repository-context research.
- Make the trust boundary clear: configured tools and extensions are user-selected integrations, not a sandbox for arbitrary external side effects.

**Non-Goals:**

- Adding a browser, search provider, MCP server, dependency, or new tool-discovery mechanism.
- Changing the research lifecycle, follow-up behavior, wiki handoff, or user configuration schema.
- Making OpenCode support Pi-style extensions; each runtime continues to use its own configured tool-loading semantics.
- Replacing source-isolation validation with a claim that arbitrary integrations are intrinsically safe.

## Decisions

1. **Remove the research tool-name allowlist, but retain capability restrictions.**
   `validateResearchRepositoryProfile` will copy the resolved profile's tools unchanged, preserve its configured extensions, force the read-only marker, remove `shell` and `edit` capabilities, and retain the existing research requirements. The duplicate startup guard in the runtime will validate those capability properties but will no longer reject tool names or extensions. This honors explicit user configuration while preserving the engine's existing route-level policy checks. A narrower allowlist of known web tools was rejected because it would continue to break user-defined integrations; removing all route checks was rejected because capability validation and source isolation remain useful workflow safeguards.

2. **Use each adapter's native configuration path for the retained tools.**
   The Pi adapter will recognize the `core.research` assignment when deciding whether a read-only profile should receive `--no-extensions`. It will still pass the profile's configured extension paths and tool list, while non-research read-only routes retain their current extension suppression. The OpenCode and OpenCode V2 adapters will include configured profile tool names in the isolated permission configuration for research, while preserving their existing read-only defaults for other routes. This avoids inventing a cross-runtime tool API and matches the fact that Pi extensions are the only profile-level extension mechanism currently supported by the configuration schema.

3. **Keep repository isolation as a workflow boundary, not a tool sandbox.**
   Research instructions will tell the agent to treat supplied repository content as read-only and to treat configured integrations as user-trusted. The existing source baseline fingerprint check remains the authoritative acceptance guard for repository-context research, so a custom integration that changes the source repository causes research progress/result validation to fail or block. External side effects performed by a user-configured integration remain outside the engine's ability to sandbox.

4. **Regenerate embedded instructions from the source asset.**
   If the research instructions are clarified, update `agent-definitions/instructions/research.md` and regenerate `agentic-coding/src/workflow/embedded.generated.ts` through the existing build process rather than hand-editing the generated file. If no instruction text change is needed, the generated asset remains unchanged.

## Risks / Trade-offs

- [Risk] User-configured extensions or tools may mutate files or perform other side effects despite the read-only research prompt. → Keep the capability restriction and source-baseline guard, document that this is a trust-boundary change, and test that source mutation is not accepted as a valid research result.
- [Risk] Passing arbitrary tool names to a runtime that does not recognize them can cause launch or tool-use errors. → Do not invent runtime integrations; pass configuration through according to the selected runtime's semantics and retain runtime preflight/launch errors.
- [Risk] Changing the Pi adapter's read-only extension condition could accidentally enable extensions for unrelated routes. → Gate the exception on the `core.research` assignment and add adapter coverage for both research and non-research read-only launches.
- [Risk] The duplicated profile policy in CLI startup and engine startup can drift again. → Update both checks and add tests through the public profile and engine startup paths.

## Migration Plan

No data migration is required. Existing pinned workflows retain their serialized routing and behavior. New research starts use the revised profile normalization; users who want custom research integrations can add tool names and, for Pi, extension paths to their existing profile. Rollback is the normal binary/configuration rollback; no persisted state format changes are introduced.
