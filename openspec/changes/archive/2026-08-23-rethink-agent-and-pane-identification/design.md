## Context

The engine identifies managed agents in three places that must agree: `runName` builds the Herdr agent name (`effect-runner.ts`), `paneForRun` allocates panes/tabs (`cli.ts`), and the reuse `observe` path resolves an existing agent before launching (`agent.launch` handler). Today the name is `<changeId-head>-<role>` (persistent roles) or `<changeId-head>-<role>-<runId8>` (triage/verification), squeezed under Herdr's 32-char `^[a-z][a-z0-9_-]*$` cap by slicing the change ID head. The Pi telemetry bridge (`agent-definitions/bridges/pi-telemetry.ts`, embedded via build) additionally assumes every name ends in an 8-hex run-id suffix — an assumption persistent-role names never satisfied, so its run-env backstop silently no-ops there. Pane reuse works only while the name lookup succeeds; any miss (truncation collision, herdr restart, stale handle) falls through to `tab create`, producing the duplicate panes users see.

Herdr lookup facts that constrain the design: `herdr agent get X` accepts either an agent name or a pane id; `pane_id` is the only channel for prompts; agent status `unknown` means the tracked process is gone or unconfirmed.

## Goals / Non-Goals

**Goals:**
- One injective, deterministic mapping (workflow change, step, role, round) → agent name within Herdr's constraints.
- Reuse-before-spawn as the single authority for pane selection on every launch path.
- Clean separation between agent identity (name), transport identity (live pane id), and persisted handle.
- Telemetry bridge run-env recovery that works for all name shapes.

**Non-Goals:**
- Changing the assignment/handoff protocol, capability tokens, or lifecycle authority rules (covered by `workflow-agent-assignment`, `workflow-engine-runtime`).
- Changing verification layout geometry beyond what identity resolution requires.
- Renaming or restructuring Herdr CLI surface.

## Decisions

### D1: Hash-suffixed canonical names instead of truncated change IDs
Canonical persistent-role name: `<role>-<hash8>` where `hash8` = first 8 hex chars of SHA-256 over `"<changeId>\n<workflowDefinitionId>"`. Round-scoped names: `<shortrole>-<hash8>-<runId8>` (kept under 32 chars; `verification` collapses to `verif`). Role names are unique per step in this registry, so role + change hash is injective across concurrent workflows.

Why not keep readable prefixes: readability is exactly what forced lossy truncation, and truncation collisions are the reported failure mode. The dashboard and tab labels already display change ID and role, so human-facing readability is preserved there, not in the agent name.

Alternative considered: variable-width truncation with collision detection against `herdr agent list`. Rejected: racy (two workflows can start concurrently), stateful, and still degrades to collisions near the cap.

### D2: Single live-agent resolver used by both reuse and allocation
New shared resolution step (in `effect-runner.ts`, consumed by the `agent.launch` handler and passed to `paneForRun`): given (handle, canonicalName) →
1. If handle exists, confirm `herdr agent get <handle.paneId>` returns a live agent whose `pane_id` matches; on mismatch/death, discard the pane id but keep the identity.
2. Confirm `herdr agent get <canonicalName>`; if alive, adopt its current `pane_id` and persist the refreshed handle.
3. Otherwise return "no live agent".

`execute` launches new only on outcome 3; `paneForRun` receives the resolved pane for persistent roles instead of unconditionally running `tab create`. This makes reuse-before-spawn one code path rather than an emergent property of two independent ones.

### D3: Handles record identity plus transport, refreshed on adoption
`AgentHandle` keeps `name` + `paneId` (+ optional tab/session). The contract changes semantically: `name` is authoritative identity; `prompt`/`observe` always go through a pane id obtained from step 1–2 above, never a long-trusted stored one. A stale pane id downgrades to a re-resolution, never directly to a new spawn. Legacy handles persisted without a `name` field are migrated on read by deriving the legacy name (`runName`'s old algorithm) once, then re-keyed to the canonical scheme on next adoption.

### D4: Bridge recovers run env from a per-agent-name pointer file
At each launch and each reused-prompt delivery, the engine writes `.herdr-workflow/runtime-bin/by-agent/<canonicalName` → relative path of the current run's `run.env` (atomic rename). The bridge reads that pointer using its own `--name` argv value, then sources the pointed run.env. This works for every name shape because it keys off identity, not suffix shape.

Alternatives: embedding the run id in every name (breaks persistent reuse — the whole point is the name stays constant across runs); picking the newest `runtime-bin/*/run.env` by mtime (races with parallel verifier launches).

### D5: Sibling anchoring in verification layout goes through the same resolver
`paneForRun`'s split logic anchors on siblings confirmed live via their canonical names through the D2 resolver, replacing direct `agent get <storedPaneId>` calls. Geometry heuristics stay, but identity inputs become uniform.

## Risks / Trade-offs

- [Hashed names are opaque in `herdr agent list`] → Dashboard/tab labels remain human-readable; hash is only 8 chars, leaving room for a short readable role prefix.
- [Pointer file can point at an expired run after repair] → Bridge recovery is a best-effort backstop layered under normal env injection; a stale pointer degrades to today's behavior, not worse. Engine overwrites the pointer before every prompt.
- [Legacy-name fallback window] → Workflows mid-flight during upgrade resolve once via the legacy derivation; after first adoption they are on the canonical scheme. Fallback is read-only and removable later.
- [Two resolution probes per launch add latency] → Both are local Herdr RPCs; negligible versus shell-readiness polling that dominates launch time.

## Migration Plan

1. Ship naming + resolver + pointer file together; bridge regenerated via `bun run build`.
2. In-flight workflows: reuse path tries canonical name, then legacy name; handles migrate lazily.
3. Rollback: revert commit; agents under canonical names are orphaned and simply relaunch fresh under legacy names — no state corruption since handles are advisory.

## Open Questions

None.
