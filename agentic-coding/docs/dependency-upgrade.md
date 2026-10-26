# Dependency upgrade: OpenTUI 0.7 / Pi 1.4 / Effect 4

## Versions and compatibility

All direct dependencies across the root, UI and devenv CLI manifests were checked
against npm's latest dist-tag. OpenTUI core/keymap/solid are 0.7.0; Chord and all
Pi packages are 1.4.0. Effect was subsequently upgraded to 4.0.6 at the
developer's request; the workflow Effect guide documents the migrated APIs. Babel is now 8.0.8,
Biome 2.6.3, and Playwright core/test are aligned at 1.64.1.

Release notes reviewed:

- https://github.com/anomalyco/opentui/releases/tag/v0.7.0
- https://github.com/earendil-works/pi/blob/main/packages/durable/CHANGELOG.md

The Durable `Unreleased` section is **not** part of this upgrade.

Durable tool results now use `output`, not `content` (transcript messages still
use `content`). Document definitions explicitly keep delta history with
`checkpointWhen: () => false`. Output wrappers forward skipped-output metadata
or disable upstream skipping when they own their own transformed tail. The
codemode wrapper supplies its own `retainedOutput`, rather than reading the
outer call's output. Test environment fakes implement the new shell output
metadata and retained-output contract. Nonzero bash exits now return error
results with diagnostics rather than throwing upstream.

Babel's parser keeps the CallExpression dynamic-import representation consumed
by the existing boundary scanners. Obsolete syntax plugins were removed because
Babel 8 parses those standardized features without opt-in. Biome's newly enabled
Markdown formatter/linter are disabled to retain the previous scope and avoid
unrelated documentation rewrites. Newly recommended numeric min/max fixes were
applied; bigint timestamps and rendered DOM text retain their required semantics.

## Deployment cautions

- **Back up session databases before opening with Durable 1.4.** SQLite storage
  automatically migrates to schema v2; Durable <=1.3 cannot reopen it.
- Durable parks a task after five consecutive crash restarts without a new
  checkpoint. Inspect `blocked: restart_limit` and use `retryTask` to recover;
  this is preferable to silently disabling the guard with Infinity.
- Both existing vendor patches remain necessary: deferred unified-diff rebuilds
  in OpenTUI, and streaming `onOutput` in pi-codemode. They were ported to the new
  package layouts; neither fix is supplied by these published versions.
- OpenTUI's native input parser is experimental and remains off. Its shadow
  logging contains user input; do not enable it casually in production.

## Follow-up simplifications (not implemented here)

- `@earendil-works/pi-durable/codemode` and `api.executeTool()` provide durable
  nested calls, replay journals, structured output validation, progress and
  ownership. Evaluate replacing the manual nested-tool wrapper, output capture
  and call bookkeeping in `src/agent-host/codemode.ts`. Preserve the existing
  tool-selection policy, telemetry, UI details and script return-value contract.
- `HarnessOptions.telemetry` now exposes content-free task/admission spans,
  metrics and propagation. It may replace portions of custom task telemetry,
  but not automatically the workflow-specific envelopes and attribution.
- Per-model `settings.compaction.modelOverrides` can remove the need to use the
  smallest model window for every conversation's overflow policy. The custom
  cost-ceiling policy is still distinct from upstream overflow compaction.
- `sleepUntil`, host clock/timer injection and wake notifications support durable
  waits without holding an invocation. Consider these for agent-host task waits,
  not as a replacement for the workflow engine's separate durable outbox.
- Deferred tool loading and tool search can reduce the prompt declarations.
  The upgraded tool descriptions increased the initial faux-provider prompt
  enough to trigger the old compaction-test ceilings before the intended input;
  test ceilings now sit above that baseline.
- OpenTUI now handles incremental editor layout and idle ScrollBox culling
  internally. Retain application-level virtualization until profiling proves it
  redundant; native `frameWork` statistics offer a way to measure that.

## Validation

`bun run lint` (zero diagnostics), `bun run type-check`, `bun run build`, and
`bun run test:devenv` (188 tests) passed. Full tests after the initial migration:
309/312 jobs passed (421 files, 5008 executed tests). The three failing jobs are
render shards 2 and 4 and `agent-host-session-recovery.test.ts`; all also fail in
a clean worktree at the original commit with the original dependencies. The
baseline full run passed 307/311 jobs and additionally failed workflow-rebase.
The render failures include clipboard mocks, page/catalog fixtures, screenshot
reads and session-panel waits. Recovery reports socket ownership mismatches on
this macOS environment. These pre-existing failures were not masked or rewritten
as part of the upgrade.

After the Effect 4 migration, the full suite again passed 309/312 jobs with the
same three failures (5008 executed tests). Four additional v4 regression tests
then passed, covering nested unknown-field preservation, normalized values,
prototype safety, fresh defaults, exact optionality and value-free diagnostics.
Lint, type-check, build and all 188 devenv tests were rerun successfully.
`bun outdated` now reports no outdated dependencies.
