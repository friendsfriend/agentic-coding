## Context

The dash overview (`agentic-coding/src/tui/dash/App.tsx`) currently has 7 focusable panels cycled via Tab in the order `[0, 6, 1, 2, 3, 4, 5]` (Change, OpenSpec, Agents, Current task, Verification, Git status, Traces). The bottom-left "Verification" panel (panel 3) renders a one-line summary memo and its Enter handler opens the `VerificationTimelineModal` via the `verification-detail` keymap layer; selecting an entry there calls `openVerifierResult(role, true)`, and the findings modal can return to that timeline (`findingsReturnToVerification`). A parallel direct path already exists: `v` on the Agents panel calls `openVerifierResult(agent.role)` when `agent.role.endsWith("verifier")`, otherwise it shows the message "Select a verifier agent to view its verdict."

See proposal.md — Why for motivation and specs/ for the target behavior.

## Goals / Non-Goals

**Goals:**
- Delete the Verification overview panel and every UI path that leads through it (Enter handler, `verification-detail` keymap layer, timeline modal component, findings→timeline restore).
- Keep verifier results one keystroke away: `v` on a verification agent opens results directly.
- Make `v` a silent no-op for non-verification agents.
- Keep the remaining grid aligned per `dashboard-pane-grid`.

**Non-Goals:**
- Changing `data.ts` verification data plumbing (`verifierTimeline`, `loadVerifierFindings`, `loadVerifierReport`) beyond what removal requires — the Agents panel status lines still consume `verifierTimeline`.
- Touching workflow-engine internals or the verification workflow itself.
- Redesigning other panels or the developer-review flows that reuse the verdict/findings modals.

## Decisions

- **Remove rather than hide.** The panel is dead weight once results are direct; hiding behind a flag keeps untested code paths. Delete the JSX block, `verificationSummary` memo, `verificationDetail`/`selectedVerification` signals, `selectedVerification`, the `verification-detail` keymap layer and its dispose call, the Enter branch for old panel 3, the `findingsReturnToVerification` signal plus its set/restore sites, and `<VerificationTimelineModal>` usage with its import.
- **Delete `VerificationTimelineModal.tsx`.** Its only consumer was App.tsx; keeping an orphaned component would fail lint hygiene. Alternative considered (keep for future use) rejected: YAGNI, git history preserves it.
- **Panel renumbering by deletion, not remapping.** Removing panel 3 from the cycle order yields `[0, 6, 1, 2, 4, 5]`; keep existing numeric identities of remaining panels so only the order array, the removed panel's branches, and any `activePanel() === 3` checks change. This minimizes churn versus renumbering 4/5 down.
- **Grid after removal:** let the `Current task` row span the full width as a single panel, keeping the `Git status`/`Traces` pair below it. This preserves the two-column gutter alignment story (top row + Git/Traces row) with the least layout code. Alternative (pair Current task with Traces) rejected: it leaves Git status full-width-looking but alone and changes more rows.
- **Verifier detection stays `role.endsWith("verifier")`** for now — same predicate the Agents list rendering uses today ("Awaiting verification run"). Introducing a richer notion of "verification agent" is out of scope; if roles ever diverge, that's a follow-up.
- **Silent no-op instead of hint message** for non-verifier agents, matching the requirement that non-verification agents give no feedback. The help entry changes to "View selected verification agent's result" so discoverability lives in `?` rather than error text.

## Risks / Trade-offs

- [Stale panel index references] → Grep for `activePanel() === 3` and the order array after edits; type-check plus existing dashboard tests cover the cycle behavior.
- [Findings modal Esc previously returned to the timeline] → After removal, Esc always closes to the dashboard; verify no code path still reads `findingsReturnToVerification`.
- [Users lost at-a-glance run/pass/fail counts] → Per-agent status badges (PASS/FAIL + duration) remain on each verifier row in the Agents panel, which is the surviving summary surface.
- [Demo/test profile parity] → `testDashboard` data still supplies `verifierTimeline`; confirm test-profile dashboards render without the removed panel.

## Migration Plan

Single-repo TUI change, no data migration. Ship as one commit; rollback is reverting the commit. Update dashboard tests alongside the removal and run `bun run lint` + `bun run type-check`.
