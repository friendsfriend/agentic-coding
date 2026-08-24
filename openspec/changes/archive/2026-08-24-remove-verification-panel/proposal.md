## Why

The agent dash overview still carries a dedicated "Verification" panel (bottom row, panel 3) whose only purpose is to funnel into the verification timeline modal and then into per-role verifier results. Verifier results are already reachable directly from the Agents panel with `v`, so the overview panel is redundant surface area and an extra Tab stop.

## What Changes

- Remove the "Verification" summary panel from the dash overview grid (previously panel 3, bottom-left row next to "Current task").
- Remove the Enter-on-verification-panel flow that opened the `VerificationTimelineModal` (`verification-detail` modal layer, its keymap layer, signals, and the findings → timeline return path).
- Keep the direct result flow: pressing `v` while the Agents panel is focused shows the selected verifier's findings/report immediately in the findings/verdict modal.
- Restrict the `v` binding to verification agents only: non-verifier agents no longer show the "Select a verifier agent…" message; `v` simply does nothing for them.
- Renumber the remaining panels (OpenSpec, Current task, Git status, Traces) so panel cycling stays contiguous after the removal.
- Update help text so `v` is described as available only on verification agents.

## Capabilities

### New Capabilities
- `dashboard-verifier-verdict-popup`: Direct verifier-result popup on the dash Agents panel — `v` on a verification agent opens its findings/report modal immediately, without an intermediate verification overview; non-verification agents have no such binding.

### Modified Capabilities
- `dashboard-pane-grid`: The overview grid loses the `Verification` panel; bottom-row layout and gutter-alignment requirements now describe the remaining panels.

## Impact

- `agentic-coding/src/tui/dash/App.tsx` — panel layout JSX, panel order/cycling array, Enter handler for old panel 3, `v` key handler, `verification-detail` keymap layer, `findingsReturnToVerification` signal and restore paths, help sections.
- `agentic-coding/src/tui/dash/ui/VerificationTimelineModal.tsx` — becomes unused; delete it.
- `agentic-coding/src/tui/dash/data.ts` — `verifierTimeline` remains as the data source for per-agent status lines in the Agents panel; only the standalone summary memo goes away if unused elsewhere.
- Tests covering the dashboard layout and verifier flows under `agentic-coding/test/`.
