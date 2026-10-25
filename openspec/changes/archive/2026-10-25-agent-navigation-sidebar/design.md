# Design

## Context

See proposal.md for motivation and specs/agent-navigation-sidebar/spec.md for the behavior contract. The unified shell already loads and refreshes workflow overviews for the workspace sidebar through `loadOverviews`; each overview's workflow state includes run identity, role, status, runtime, optional model and optional durable host/conversation handles. The `WorkflowOverview.agents` convenience array is not sufficient for direct session navigation because it omits run identity and handles. Workflow dashboards already open a specific durable session from its run and host identity, while the shell owns page routing, panel focus, and the active keybind catalog.

## Goals / Non-Goals

**Goals:**
- Derive an agent list from the workflow observation already held by the shell, without introducing a competing poller or a backend API.
- Preserve distinct, explicit ownership for the workspace sidebar, page body, and agent sidebar, including keyboard and pointer interactions.
- Carry exact workflow and run identity through shell navigation into the existing workflow agent-session behavior.
- Keep the panel useful in compact, expanded, and narrow layouts and truthful about optional metadata and unavailable session handles.

**Non-Goals:**
- Listing standalone Orchestrator, embedded OpenCode, or embedded Pi sessions as workflow agents.
- Changing agent runtimes, workflow persistence, lifecycle, or session command semantics beyond the explicitly approved connection-state safety contract and bounded transcript hot-path hardening below.
- Adding elapsed-time or usage metrics that the authoritative overview does not provide.
- Replacing the workspace sidebar or changing its user-configured side, filters, or persistence.

## Decisions

1. **Use the workflow observation as the only source.** Derive rows from each returned workflow's `state.runs`, keyed by its store `target`, workflow id, and run id. Choose the latest run per role, matching the dashboard's existing latest-per-role projection, and exclude the existing `git` and `dashboard` utility roles. Active means latest-run status `pending` or `working`; All includes the latest run for each role even when terminal. This bounds the list to current workflow agent identities rather than duplicating prior attempts. The returned observation already spans repository-backed and repository-independent workflow targets. Alternative: query one `WorkflowView` per listed workflow or introduce a new endpoint. Rejected because the current observation contains the needed run and optional session fields and an extra request fan-out would duplicate existing polling.

2. **Keep agent projection pure and selection keyed by identity.** Add a renderer-free model for latest-run projection, Active/All filtering, deterministic ordering, status/display fields, panel widths, and selection reconciliation. Use `target + workflowId + runId` as the stable row key; keep a preferred selection while filtering hides it, restore it when visible, and choose a bounded visible fallback only when the source removes it. Sort independently of mutable status/activity so a live refresh does not move a selected row. Reuse the dashboard's latest-per-role rule; do not derive run selection from a display index.

3. **Reuse existing gateway refresh and terminal primitives.** The shell already refreshes `loadOverviews` on its bounded interval and keeps last-good rows on read errors. Derive agent rows from that same observation and expose read state separately as loading, fresh, or stale/disconnected. Build the panel from the shared `Panel`, `SelectableList`/`Selectable`, theme tokens, clipping, and tap semantics. Keep agent-specific projection and layout separate from `sidebar-model.ts`; only extract a generic primitive if an existing behavior is truly identical, rather than refactoring the workspace sidebar as part of this feature.

4. **Use an independent rightmost panel with responsive widths.** Mount the agent panel at the shell's right edge on the same dashboard-enabled pages where workflow overviews are available. With a left workspace sidebar, layout is workspace/content/agent; with a right workspace sidebar, layout is content/workspace/agent, preserving both panels as distinct targets. Give the agent panel its own expanding/permanent presentation state (expanding by default) and compact/expanded widths following the workspace panel's rendering conventions. At narrow widths, reduce or collapse panel widths before allowing the page body to overlap or become unusable; this fit constraint takes precedence over a requested permanent expanded width.

5. **Carry a one-shot exact-run navigation request.** Selecting/activating a row navigates through `workflowRoute(target, workflowId)` while carrying the selected run id as a workflow-page parameter or equivalent explicit request. Once the dashboard has loaded that workflow, resolve the exact run and use its recorded session handle to open the existing durable session view. A missing or stale handle must leave the dashboard focused on the matching run and must never fall through to another role's session. Consume the request once so closing a session does not reopen it on a later render or live refresh. Do not synthesize session ids or fall back to repository path when the workflow target is available.

6. **Make panel focus a shell-owned keymap state.** Extend shell panel ownership so the agent panel parks page/workflow input layers while focused and publishes its own catalog to the shared footer/help projection. Ctrl+A toggles between the agent panel and the prior shell-owned panel (content by default), and the pre-existing workspace focus/cycle behavior remains intact. Route Ctrl+A only when the shell owns navigation input; open modal and page-local text-input ownership must win. Register the key in the owning catalogs with a compact footer label, and mark ordinary row navigation standard so it appears in help without crowding the footer.

7. **Render only supported activity facts.** Expanded rows prioritize role, workflow identity, status, runtime/model when present, and current workflow step/activity where available. The current run overview lacks an agent-start timestamp, so do not call workflow age "agent elapsed" or derive an elapsed metric. Compact rows retain a status and selected marker. Missing host metadata remains an exact workflow-row navigation case rather than an excuse to open a different or guessed session.

8. **Make session connection state truthful and controls safe.** Approved follow-up `approve-bounded-session-connection-contract` extends the original session-behavior non-goal only at the watch boundary. Before any frame, show an initial connecting state with controls paused, not a stale-transcript claim. A failed initial watch returns to the exact run row and requires explicit reopening. After a received frame, a drop retains the last-known transcript and draft, visibly marks that transcript stale/reconnecting, cancels old projection work, clears live/pending/working/compaction/rate indicators, and pauses submit, configure, abort and compact. Only a fresh authenticated frame restores connected state and controls, without discarding the draft. Existing run/generation fencing and per-connection host validation remain intact; this does not change command semantics or lifecycle.

9. **Bound reused session hot paths.** Approved follow-up `approve-bounded-session-hot-path-hardening` permits presentation-only performance fixes, not a transcript or protocol rewrite. Compute compaction labels only for entries entering the projection and share nearest-token gap searches, preserving measured labels. The immutable watch client structurally shares unchanged entries and timing maps; cache metadata summaries and lazy labels by those source identities, recomputing when sources change rather than on every live-only frame. Use weak keys so superseded sources can be collected. Bound the per-view markdown LRU to the transcript projection's block limit, releasing old source text and parsed parts while keeping settled-part reuse for active streaming messages. Initial/replaced sources may require history reads to recover exact measurements; unchanged live frames must not repeat them.

## Risks / Trade-offs

- [Optional or stale host handles] A row may outlive the process it names. Pass through only the recorded handle, retain the existing bounded unavailable-session behavior, and keep the exact run selected in the workflow dashboard rather than substituting another session.
- [Two panels reduce content width] Simultaneously permanent panels can crowd narrow terminals. Apply responsive width reduction/collapse and verify the combined layout at wide and narrow renderer sizes.
- [Ctrl+A is also an editing shortcut] Intercepting it while a prompt or modal owns input would break normal selection/editing. Guard the global binding by modal and page-local input ownership, and test both shell and input cases.
- [Role retries can reorder rows] Select the current latest run per role, use stable identity keys and deterministic order, and cover refresh, filter, replacement, and removal behavior in pure-model tests.

## Migration Plan

The panel, focus/layout/catalogs, and exact-run routing do not change authoritative workflow persistence or lifecycle. Exact historical requests remain visible in a transient run-specific row even when a newer attempt occupies the latest-role list. Dashboard observations build run-ID and pending-role indexes once; a dashboard-scoped worker batches read-only store/path verification before any host connection or control.

Approved bounded host ownership hardening additionally changes the agent host's private durable association storage. The approved `approve-guarded-host-store-upgrade` decision replaces the original source-revert-only rollback contract for this host store: take a complete, private pre-upgrade SQLite snapshot (including WAL contents and conversations), atomically install keyed associations and a version-2 `agentic.runs` gate, and explicitly reject older readers/writers. Backups must never be overwritten; backup failures stop the upgrade before the gate or migrated state is committed. Normal ensure/recovery reads and writes remain bounded to requested keys.

Rollback of the host executable requires stopping clients/hosts and restoring the complete pre-upgrade database before starting an older binary; live old/new format compatibility is not promised. Preserve the upgraded database and its sidecars separately, never combine its WAL with the restored snapshot, and retain private backup copies. Post-upgrade conversation changes are not merged on rollback. Authoritative workflow state is not restored by a host-store rollback, so subsequently recorded session handles may be unavailable and must fail closed. See `agentic-coding/docs/agent-host-storage-upgrade.md` for the full upgrade, interrupted-upgrade, restore-before-rollback, and later re-upgrade procedures. A source revert alone is sufficient only for presentation changes, not for the upgraded host store.

## Open Questions

None. The source scope, latest-per-role rule, Active status set, and missing-handle navigation behavior are defined in the spec for plan review.
