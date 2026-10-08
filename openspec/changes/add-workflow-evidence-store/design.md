# Design

## Context

Workflow state lives in `<repo>/.herdr-workflow/`; run directories already hold
per-run files (`runtime-bin/<runId>/run.env`) written via `secure-fs.ts`.
Observations are a closed union in `src/contracts/environment.ts` and
`src/server/operations/observations.ts`.

## Goals / Non-Goals

**Goals:** durable, bounded, captioned evidence; safe path handling.

**Non-Goals:** uploads to MR/Jira, rendering (change 10), video transcoding.

## Decisions

- **Layout.** `.herdr-workflow/evidence/<workflowId>/[req-<requestId>/]<id>.<ext>`
  with `manifest.json` written atomically (`writeAtomicPrivateFile`). Ids are
  ULIDs so lexical order is time order.
- **Attach is copy-in.** Server-produced files (browser) are moved in by the
  server; agent-attached files must resolve (realpath) inside the run's
  worktree or scratch dir, else refused. Symlinks outside are refused.
- **Kinds by content.** Extension and magic bytes must match kind (PNG/JPEG for
  screenshot, WebM/MP4 for video, ZIP for trace, text for script/log).
- **Caps refuse, never evict.** Evidence the agent chose to keep is never
  silently deleted; over cap → typed `evidence-quota` error.
- **Poster.** Video entries may name a `poster` screenshot entry (change 8 sets
  it to the final frame screenshot).
- **Observation.** `{kind: "evidence", repo, workflowId, requestId?}` returns
  the manifest; file bytes are served by `GET /api/v1/evidence/{workflowId}/{id}`
  for the TUI (local capability only).

## Risks / Trade-offs

- [Disk growth] → per-workflow cap and deletion with the workflow.
