## 1. Remove the Verification overview panel

- [x] 1.1 In `agentic-coding/src/tui/dash/App.tsx`, delete the "Verification" Panel JSX (old panel 3) from the bottom-left row and let "Current task" span that row full-width; verify `bun run type-check` still passes
- [x] 1.2 Remove the `verificationSummary` memo and drop panel 3 from the Tab cycle order array (`[0, 6, 1, 2, 3, 4, 5]` → `[0, 6, 1, 2, 4, 5]`); verify Tab cycling never lands on a removed index
- [x] 1.3 Delete the Enter branch for old panel 3 (the one setting `verificationDetail`/`selectedVerification` and `modal.active = "verification-detail"`); verify Enter on every remaining focusable panel behaves as before

## 2. Remove the verification timeline modal plumbing

- [x] 2.1 Delete the `verification-detail` keymap layer registration and its dispose call in `App.tsx`; verify no `modal.active === "verification-detail"` references remain (`rg verification-detail agentic-coding/src`)
- [x] 2.2 Remove `verificationDetail`, `setSelectedVerification`/`selectedVerification`, and the `findingsReturnToVerification` signal plus all set/restore sites (findings Esc handler, `openVerifierResult` returnToVerification param); verify findings Esc now always returns to the dashboard
- [x] 2.3 Delete `agentic-coding/src/tui/dash/ui/VerificationTimelineModal.tsx` and its import in `App.tsx`; verify `rg VerificationTimelineModal agentic-coding/src` returns nothing

## 3. Restrict v to verification agents

- [x] 3.1 In the `v` handler for the Agents panel, make non-verifier roles a silent no-op: remove the `setMessage("Select a verifier agent to view its verdict.")` branch; verify pressing `v` on a non-verifier agent opens nothing and shows no message
- [x] 3.2 Update the help section entry for `v` to describe it as showing the selected verification agent's result; verify via `?` help overlay text

## 4. Tests and validation

- [x] 4.1 Update dashboard tests under `agentic-coding/test/` that assert on the Verification panel, timeline modal, or the verifier-selection message; add coverage that `v` on a verifier agent opens results directly and does nothing on a non-verifier agent; verify `bun test` passes
- [x] 4.2 Run `bun run lint` and `bun run type-check` in `agentic-coding/` with zero diagnostics; confirm the overview grid keeps gutter alignment per the dashboard-pane-grid spec
