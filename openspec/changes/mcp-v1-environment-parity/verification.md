# Standalone foundation (tasks 0.1–0.4)

The user's revised architecture is implemented as a fresh `environment-mcp/`
package, not an adapter importing either coding application. Its own package/
lockfile, official MCP SDK, Zod, Bun build, TypeScript and Biome configuration
require no Pi, workflow, provider or OpenTUI dependencies. Source origins and
adaptations are recorded in the package's `PROVENANCE.md`.

Implemented: strict versioned environment-native selection/dependency manifest;
separate explicitly selected metadata-only v2 reader; bounded no-follow/changed-
file reads; explicit canonical repository authorization rechecked on reads;
bounded strict MCP catalog input/output; pure v1 shared/external/owned lifecycle
decision rules; a fresh stdio composition and self-contained built artifact.

Not implemented/advertised: runtime mutation descriptors and adapters, state/
scope/approval/issuance journal, HTTP shared authority/operator listener, actual
dependency readiness/network observation, diagnostics or build/start/stop tools.
The new manifest declares identities/selection/dependencies, not executable
authority. The v2 compatibility reader explicitly discards unvalidated execution
fields and does not import dependency bindings, credentials or native state.
This foundation is not the final runtime migration or behavioral parity claim.

## Verification

- Independent `bun install --frozen-lockfile`: passes without lock changes.
- New package build: 98 bundled modules, approximately 0.75 MB `dist/cli.js`.
- New package lint and whole-project type-check: pass with zero diagnostics/errors.
- New package unfiltered suite: **3 pass, 0 fail, 0.204s** (25 assertions), plus
  approximately 0.010s build in the final measured run. This is the first package
  baseline, not an asserted portable timing threshold. The earlier failed run
  exposed an incorrect SDK transport constructor argument; it was corrected,
  not hidden by changing timeouts or retries.
- One representative SDK stdio scenario copies only the bundle outside the
  checkout, exercises a 41-project/>64 KiB catalog, final-page selection,
  secret/command withholding, authority/size refusal and absence of execution.
  Native manifest/schema and lifecycle tables stay in direct production-rule
  tests without extra runtime/database/server fixtures.
- Manual read-only built-stdio check against the actual installed v2 file:
  **41 project IDs and 117 target IDs match exactly**. No real credentials,
  engines, databases, containers, clusters or configured commands invoked.
- Existing packages retain clean lint and whole-project type-check; original
  package's boundary gate: **71 pass, 0 fail, 7.15s**.
- Strict validation of the revised OpenSpec change passes.

The preceding startup-limit correction in the old controller was separately
verified with **289 pass, 0 fail, 16.17s** and both existing packages' gates. It
only aligned a missed 32-project execution-startup cap with shared native limits;
it is not evidence that the new package executes live apps. No runtime adapters
were changed by this foundation batch.

## Preserved live state

The existing global catalog and installer-space scoped OpenCode connections still
point at the old implementation. The temporary old shared controller holds two
unexecuted installer-space plans; neither has human approval. The existing
PostgreSQL remains untouched. No old implementation files were deleted, no
connection was switched, no native state was imported and no commit was made.
