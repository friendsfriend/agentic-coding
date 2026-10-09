# Proposal

## Why

Browser screenshots, videos and repro scripts (change 8) must outlive the agent
turn that produced them and be reviewable by the developer later. There is no
place for binary, captioned, per-workflow artifacts today; workflow artifacts
are markdown/OpenSpec files only.

## What Changes

- An **evidence store** per evidence owner (workflow, or debug request within a
  workflow): files under `<workflow run dir>/evidence/[<requestId>/]` plus a
  `manifest.json` of entries `{id, kind, file, caption, createdAt, step, role,
  app?, url?, poster?}` with kinds `screenshot | video | trace | script |
  log | other`.
- Server API to attach (copy/move a file produced by the server, never a path
  outside allowed roots) and list evidence; size caps per file (video 100 MB,
  other 20 MB) and per workflow (1 GB, oldest non-pinned first is refused, not
  evicted).
- An agent tool `evidence_attach({path, kind, caption})` for files agents create
  themselves inside their worktree/scratch (e.g. a curl dump), and
  `evidence_list`.
- An `evidence` observation kind for the dashboard.
- Evidence is deleted with the workflow (`workspace.cleanup`).

## Capabilities

### New Capabilities

- `workflow-evidence-store`: storage layout, manifest, caps, attach/list API,
  agent tools, observation.

## Impact

- New `src/server/evidence/` (store, routes), `src/server/operations/observations.ts`
  (`evidence` kind), `src/contracts/environment.ts` (observation schema),
  `src/agent-host/environment-tools.ts` (two tools) or a sibling extension.
- No dependency on the environment changes; can be built in parallel with them.
