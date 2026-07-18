# Design: add-current-working-dir-to-project-options

## Scope

Add current‑working‑directory option to the two project selectors that exist today. The `cmd_projects` CLI output is left alone — it is a generic discovery feed and the CWD is a UI concern, not a project discovery concern.

## Dashboard modal (`agent-dash/src/ui/NewWorkflowModal.tsx`)

**Choices array (`choices()` at step 0):**
Insert one element after the mapped projects and before `'Custom path…'`:

```
`Current Directory (${process.cwd().split('/').pop()})`
```

**Selection handler (`handler` at step 0, `return`/`enter` branch):**
The current conditional is:

```
if (step() === 0 && selected() === projects().length) { setShowCustomRepo(true); return true; }
```

Change to check for the new CWD index (`projects().length`):

```
if (step() === 0 && selected() === projects().length) {
  next(process.cwd());
  return true;
}
```

And shift the existing `Custom path…` index check to `projects().length + 1`.

The `choices()` length and all selection indices shift by one. Every reference to `projects().length` in the step‑0 handler must be reviewed.

## Pi extension (`pi/extensions/herdr-workflow.ts`)

**Labels array:**
Append one entry after the mapped projects:

```
const cwdLabel = `○ Current Directory (${path.basename(process.cwd())})`;
const labels = [...projects.map(...), cwdLabel];
```

Use `○` prefix (unchecked) since there is no meaningful openspec status for the ephemeral CWD entry.

**Selection handler:**
After `const project = projects[labels.indexOf(selected)];`, if CWD was chosen (`labels.indexOf(selected) === projects.length`), set project to a synthetic object:

```
const project = selected === cwdLabel
  ? { name: process.cwd(), path: process.cwd(), openspec: false }
  : projects[labels.indexOf(selected)];
```

The openspec check after selection will correctly warn or proceed based on whether the CWD has an `openspec/config.yaml`.

## Invariants

- `cmd_projects` in `pi/bin/herdr-workflow` is untouched.
- Existing `Custom path…` behaviour in the dashboard is preserved, just shifted by one index.
- Empty discovered‑project list still shows the CWD option followed by Custom path.
- CWD entry is never filtered or sorted — it always sits immediately after the dynamic project list.

## Validation

Run `agent-dash` with `bun run dev`, open the new‑workflow modal, verify the CWD entry is visible between projects and Custom path, select it, and confirm the repo field is pre‑filled with `process.cwd()`. Run `cd /tmp && bun run dev` to confirm the basename changes accordingly.
