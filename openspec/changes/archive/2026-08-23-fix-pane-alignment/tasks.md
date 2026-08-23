## 1. Layout fix

- [x] 1.1 In `agentic-coding/src/tui/dash/App.tsx`, change the top-row left column box from `{ width: "50%", height: "100%", flexShrink: 0 }` to `{ flexGrow: 1, flexBasis: 0, minWidth: 0, height: "100%" }`; verify with `rg -n 'width: "50%"' agentic-coding/src/tui/dash/App.tsx` that no fixed-percentage columns remain in the detail view rows
- [x] 1.2 Change the `Agents` panel style from `{ width: "50%", height: "100%", flexShrink: 0 }` to `{ flexGrow: 1, flexBasis: 0, minWidth: 0, height: "100%" }` so it matches the bottom-row panels; verify the three rows now use identical sizing props via grep

## 2. Verification

- [x] 2.1 Run `cd agentic-coding && bun run lint && bun run type-check` and confirm zero diagnostics
- [x] 2.2 Launch the dash (`agentic-coding` TUI) at a normal terminal size, open a workflow detail view, and visually confirm the `Agents` gutter lines up with the `Current task`/`Verification` and `Git status`/`Traces` gutters; repeat at a narrow width (e.g. 80 cols) to confirm no clipping or overflow
