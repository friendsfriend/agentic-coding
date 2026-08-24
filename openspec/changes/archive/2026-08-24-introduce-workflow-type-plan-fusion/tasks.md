## 1. Contracts and step definitions

- [x] 1.1 Add `core.plan-draft@1` output contract (approach, files with repository-relative paths, risks, questions; bounds and path-escape checks) in `agentic-coding/src/workflow/definitions.ts` mirroring the `triage` contract style, and verify unit tests reject missing sections, absolute/escaping paths, and oversized payloads
- [x] 1.2 Register `fusion.plan` ("Fusion planning", agent, outcomes complete/blocked/failed, output `core.plan-draft@1`, retryLimit 3, allowed effects incl. `openspec.validate`) and `fusion.consolidate` ("Plan fusion", agent, same outcome set, passthrough output) step definitions with instruction assets wired into `INSTRUCTION_BY_STEP`, and verify registration passes registry validation

## 2. Fan-out and consolidation semantics

- [x] 2.1 Implement fan-out activation for `fusion.plan`: create N active runs (2 ≤ N ≤ 5, roles `planner-1..N`) from start parameters recorded in the snapshot; verify reducer rejects out-of-range counts, unknown profiles, and duplicate profiles before any launch
- [x] 2.2 Implement per-role routing resolution mapping position i → role `planner-i` → profile via existing `role_routes`/preset resolution in `profiles.ts`, and verify each run's rendered assignment is byte-identical except the role field
- [x] 2.3 Implement completion counting in the `fusion.plan` reducer: record each validated draft (path + digest, ordered by role), transition to `fusion.consolidate` only when all N handoffs arrived, preserve surviving drafts when one role retries after blocked/failed; verify with a multi-run state test covering interleaved handoffs
- [x] 2.4 Render `fusion.consolidate` assignment Inputs listing every validated draft artifact in stable order, and verify no draft is omitted for N = 2 and N = 5

## 3. Instruction assets

- [x] 3.1 Write `agent-definitions/instructions/planning-fusion.md` defining the shared prompt-engineered draft output style (approach summary, file-level plan, risks, open questions) matching `core.plan-draft@1`, and verify digest pinning succeeds via assignment rendering
- [x] 3.2 Write `agent-definitions/instructions/fusion-consolidation.md` directing reconciliation of conflicting approaches, documentation of rejected alternatives, and creation of normal openspec change artifacts, and verify rendering includes it after the protocol asset
- [x] 3.3 Regenerate embedded assets (`bun run build` producing `embedded.generated.ts`) and confirm digests match on-disk files

## 4. Workflow definition and CLI surface

- [x] 4.1 Compose the `plan-fusion` manifest (`fusion.plan → fusion.consolidate → core.plan-approval → standard tail`; plan-approval comments/reject loop back to `fusion.consolidate` max 3) and register it alongside built-ins through `registerBuiltins`; verify registry validation accepts it and existing three definitions keep identifiers/versions/graphs
- [x] 4.2 Extend workflow start command surface to accept an ordered 2–5 profile list for plan-fusion following existing flag conventions, and verify invalid lists fail before state mutation
- [x] 4.3 Add dashboard/TUI label entries for "Fusion planning" and "Plan fusion" steps and verify phase status renders them for an active plan-fusion fixture

## 5. Integration verification

- [x] 5.1 End-to-end state test: start plan-fusion with 3 profiles → interleave 3 planner handoffs (one retry) → consolidation completes → plan approval approve → tail reaches closed; verify every transition against pinned definition
- [x] 5.2 Run `bun run lint`, `bun run type-check`, and full workflow test suite; verify zero diagnostics and no changes to persisted-state schema or existing definition pins
