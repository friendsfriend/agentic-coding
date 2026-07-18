## 1. Dashboard modal CWD entry

- [ ] 1.1 Insert `Current Directory (<basename>)` after mapped projects in `choices()` when `step() === 0`.
- [ ] 1.2 Handle CWD selection in `handler()`: call `next(process.cwd())` when CWD row is chosen, shift `Custom path…` index by one.
- [ ] 1.3 Verify every `projects().length` reference in step‑0 handler accounts for the new index offset.

## 2. Pi extension CWD entry

- [ ] 2.1 Append CWD label with `○` prefix to the labels array.
- [ ] 2.2 In selection handler, detect CWD pick and synthesise a project object from `process.cwd()`.

## 3. Validation

- [ ] 3.1 Open new‑workflow modal in dashboard, confirm CWD entry appears between projects and Custom path.
- [ ] 3.2 Select CWD entry, verify repo is pre‑filled with `process.cwd()`.
- [ ] 3.3 Run `cd /tmp && bun run dev`, verify basename updates.
- [ ] 3.4 Run pi `implementation` command, verify CWD appears in project list.
