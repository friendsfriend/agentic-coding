# Design

## Context

Dialogue tools call the workflow CLI with the run's environment
(`runWorkflowCli`). The durable host exposes `submit(runId, text, requestId,
whenBusy)` which queues input into a conversation as steer or follow-up.
Effects are durable outbox records; the effect runner starts agent runs.

## Goals / Non-Goals

**Goals:** async delegation without blocking the caller; durable,
non-duplicated delivery; developer visibility without approval.

**Non-Goals:** worktree forking or patch-only mode (developer chose shared
worktree), nested requests, cross-workflow requests.

## Decisions

- **Durable request record.** `debug_requests(id, workflow_id, caller_run_id,
  caller_role, goal, context, apps, status queued|running|done|failed|cancelled,
  debug_run_id, baseline_ref, report_path, created_at, finished_at,
  delivered_at)`. Status transitions under the workflow write transaction.
- **Run start.** `debug.request.run` effect starts a durable run with role
  `debug`, cwd = caller worktree, owner = `workflow:<id>`, evidence dir
  `req-<id>`, assignment = goal + context + shared-worktree rule. The workflow's
  current step is unchanged: requests run beside steps.
- **Baseline for touched files.** At start record `git stash create` (a commit
  of the current tracked state without touching the worktree; `HEAD` when
  clean) plus hashes of untracked files. At handoff, touched = files whose
  content differs from the baseline *and* that the caller did not change
  meanwhile is not knowable; report all files changed since baseline, labelled
  "changed during request (debug or caller)".
- **Delivery.** `debug.request.deliver` effect calls the host's submit with
  `requestId = debug:<id>` (idempotent per id) and `whenBusy: "followUp"`;
  message = report summary + path + evidence ids + touched files. Delivery
  failure because the caller run ended marks `delivered_at` null and keeps the
  artifact; it is not retried forever.
- **Wait/poll.** `debug_wait` polls the read-only store every 2 s up to its
  timeout; it does not hold a write lock.
- **Handoff guard.** `workflow handoff` refuses with a typed message listing
  open request ids; `debug_cancel` aborts the debug run (host `abort`) and marks
  `cancelled`.
- **Limits.** Checked in the CLI command under the write transaction; debug
  runs do not get the request tools.
- **TUI.** Observation `{kind: "debug-requests", repo, workflowId}`; list +
  report artifact view + evidence panel filtered by request; keybinds are
  navigation/open only.

## Risks / Trade-offs

- [Concurrent edits clobber] → accepted by the developer; mitigated by prompt
  rules and the touched-files report; revisit with forked worktrees if it
  causes problems.
- [Injected message during a long tool call] → follow-up mode queues it until
  the caller's turn ends.
