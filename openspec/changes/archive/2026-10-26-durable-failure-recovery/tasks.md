## 1. Durable host failure reporting

- [x] 1.1 Verify the exact pinned pi-durable 1.4.0 public `onReport`, task-state, `retryTask`, and `pi.live.compactionFailure` contracts; implement typed allow-listed failure normalization for task, host, session, and extension reports.
- [x] 1.2 Wire `Harness.onReport` into bounded, redacted host diagnostics and the existing runtime-event path; make logger/event callback failure best-effort and non-recursive, with focused tests proving payload omission and host survival.

## 2. Parked runtime state and explicit recovery

- [x] 2.1 Extend host status/watch and the private protocol to expose durable parked-task identity and `restart_limit` distinctly from ordinary question-blocked, queued, working, and terminal states; test late status reads and normal state compatibility.
- [x] 2.2 Add an explicit task-id retry request using `Harness.retryTask(id)` with serialized current-state revalidation, run/conversation ownership checks, active workflow/review checks, and structured stale/duplicate/refused outcomes; test successful continuation and invalid, stale, duplicate, and cross-run refusal.

## 3. Agent view projection and action

- [x] 3.1 Project retained `pi.live.compactionFailure` into session metadata/transcript and the Agents view, render bounded error detail, and verify it clears when upstream reports a successful compaction.
- [x] 3.2 Add an explicit, user-triggered retry action for the displayed parked task id, showing the upstream reason and a warning about possible repeated external effects; test success, refusal, and unavailable/stale outcomes without adding automatic retry behavior.

## 4. Isolated regression and verification

- [x] 4.1 Add deterministic host, protocol, projection, and view tests for structured reports, repeated crash/reopen parking, retry continuation/refusals, compaction failure display/clearing, and ordinary queued/working/question-blocked/terminal status, using temporary storage and isolated `HOME`, `AGENTIC_CODING_CONFIG_DIR`, `PI_CODING_AGENT_DIR`, and `HERDR_WIKI_DIR`.
- [x] 4.2 Run focused durable-host, client/protocol, and dashboard agent-session regression tests, then `bun run type-check`, `bun run lint`, and `bun run build`; run the compiled durable-host smoke check if its existing test harness is available, without starting or rebuilding developer apps/services.
