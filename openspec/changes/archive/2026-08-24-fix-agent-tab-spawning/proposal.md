## Why

The agent/pane identity refactor (`canonicalAgentName` + reuse-before-spawn) made persistent roles (planner, worker, archive) stable across generations, but verifiers and triage agents are still spawned anew on every round: their canonical names embed the run id (`run.id.slice(0, 8)`), and every step re-entry (verification fix loop, plan-review loop, test-verifier follow-up) creates runs with fresh UUIDs. Each round therefore misses the reuse path, spawns a new tab + agent per verifier role, and leaves the previous round's panes orphaned — exactly the behavior the refactor was meant to eliminate.

## What Changes

- Make the canonical agent name for round-scoped steps (triage, verification) derived from change ID / definition ID / step ID / role only — dropping the run-id discriminator — so a verifier role keeps one stable identity across every round of its workflow.
- Extend reuse-before-spawn to apply uniformly: every launch path resolves by handle, then canonical name, then legacy name; a fresh tab is created only when no live agent resolves.
- Fix sibling resolution for grouped launches so siblings without persisted handles still resolve via their canonical names (today they are skipped when `handle` is absent, defeating name-based recovery after engine restart).
- Keep the 32-char Herdr name cap and injectivity guarantees: distinct workflows, steps, and roles never collide; the hash already encodes the discriminating identity.
- Keep the env-pointer mechanism unchanged; it is rewritten at every reused-prompt delivery so a reused verifier's telemetry recovers the current round's run env.

## Capabilities

### New Capabilities

(none)

### Modified Capabilities

- `agent-pane-identity`: the "Grouped roles get fresh identities per round" requirement is replaced — grouped triage/verification roles now keep one role-stable identity across rounds and reuse their existing pane, while remaining isolated from other roles and other workflows. The reuse-before-spawn requirement is extended to cover all launch paths including grouped-round geometry anchoring.

## Impact

- `agentic-coding/src/workflow/effect-runner.ts` — `canonicalAgentName`, `resolveLiveAgent`, doc comments.
- `agentic-coding/src/workflow/cli.ts` — `paneForRunFactory` round-scoped branch (sibling resolution without requiring handles).
- `agentic-coding/test/workflow-effects.test.ts` — round-isolation expectations flip to round-stability expectations; sibling-resolution test coverage.
- Telemetry bridge contract unchanged (pointer file keyed by agent name already supports reused agents).
