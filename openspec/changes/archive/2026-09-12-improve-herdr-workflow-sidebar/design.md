## Context

Agentic Coding owns workflow state; Herdr owns terminal workspaces, tabs, panes, and the native sidebar. Existing `syncAgentTabLabels` runs after drains through `workflow/operations.ts`. It does not publish sidebar metadata, and its after-drain timing is insufficient for a developer question that must be displayed while an agent command is still waiting.

Herdr 0.9.0 provides configurable Space/Agent rows, display-only workspace/pane tokens, and the socket-only `agent.view.set` projection. Its custom sorts accept pane metadata. The view is transient, server-scoped, and singular: setting it replaces another custom view. Native Spaces grouping is tied to Git worktree provenance, not arbitrary workflow metadata.

The current `WorkflowView` already exposes canonical repository, workflow ID, definition, registered current-step label, runs, pending developer questions, and available actions. Pending developer questions exclude peer-agent consultations. Action availability alone does not mean input is required: optional close/PR/research actions must not light the input marker.

## Goals / Non-Goals

**Goals:**

- Keep Herdr and render useful native workflow/agent cards.
- Place `◆` / `◇` immediately before each card's project name, preserving text position as attention changes.
- Show workflow identity/type/phase and agent lifecycle role without deriving them from terminal names.
- Order managed agents by required input with stable secondary ordering.
- Treat all publication as bounded, best-effort presentation, independent of workflow execution authority.

**Non-Goals:**

- Shared project headers, arbitrary grouping, moving workspaces, or converting checkout workflows to worktrees.
- A replacement OpenTUI sidebar, Herdr fork/plugin framework, tmux migration, or workmux adoption.
- New workflow naming UI, semantic state overrides, inferred completion, new durable effects, or database migrations.
- A new always-running daemon or a guarantee of continuous observation when no Agentic Coding application is running.

## Decisions

### 1. Native cards with a repeated project root

Target workflow card:

```text
◇ agentic-coding
├─ improve-authentication
│  openspec-full
└─ Implementation
```

Target agent card:

```text
◆ agentic-coding
├─ improve-authentication
│  worker
└─ ● working
```

These are per-card trees, not a shared project tree. The marker describes this workflow or this agent, not every workflow using the displayed project basename. Only the Agents view is reordered; existing Spaces order and worktree grouping remain unchanged.

Use plain text-presentation `◆` and `◇`, without emoji variation selectors, followed by one space. Both occupy the same terminal-cell slot in the supported terminal configuration. Keep marker, project text, indentation, and row count unchanged when only attention toggles. Color can reinforce meaning but must not be the sole distinction.

Render one complete display token per configured row. Herdr trims token values and inserts separators between multiple row tokens; composing `◆ project`, `├─ workflow`, `│  type/role`, and `└─ phase/status` before reporting avoids unwanted middle dots or lost leading-space indentation. Tree glyphs start each subordinate row so internal spaces survive normalization.

Alternative rejected: placing marker and project in separate native tokens, which permits Herdr's separator policy to change the agreed layout. Replacing the whole sidebar merely for true grouping is also excluded.

### 2. A small pure projection over existing facts

Use `view.repository` resolved by existing canonical-target logic for project identity, and its basename for display. Never use the linked worktree basename as the project name. Keep full repository/workflow/pane identities internally so identical basenames cannot merge cards. Repository-independent targets display `Research` or `Wiki` according to existing target classification, never a bogus project inferred from the central storage folder.

Use the existing user-supplied `workflowId` as workflow name; it is the current model's naming field. Do not derive a new title from task text or add persisted naming state. Show `definition.id` as workflow type (for example `openspec-full`) and `currentStep.label` as phase, falling back to the step ID only if necessary. Show exact registered run role as lifecycle name (`worker`, `quality-verifier`, etc.), not hashed Herdr agent name or runtime executable.

Project typed workflow facts and separately supplied live Herdr observations into strings and attention values using deterministic TypeScript. No TUI imports, clock reads, network calls, or phase/role lookup tables belong in this projection. Pass time explicitly for expiry/freshness checks. Collapse historical runs sharing one persistent pane to its current associated run; expire/clear the previous association rather than issuing competing updates for the same pane.

### 3. Required input is distinct from activity and action availability

For a managed agent, confirmed input is owed when either:

- The validated pending-question view includes a non-expired developer question for its exact current run; or
- Its current live Herdr observation reports `blocked`, meaning Herdr recognized a runtime input/approval prompt.

A peer consultation, answered/cancelled/expired question, stale run generation, `idle`, or unseen `done` alone does not require developer input. Questions from historical runs must not mark a successor occupying the same pane.

For a workflow, confirmed input is owed when any associated agent needs input, a registered blocking human gate awaits a decision, or committed paused/attention-required state requires operator intervention. A workflow-wide gate affects its Space card only; it does not mark every agent as requesting input.

Add an optional presentation-only `requiresInput` hint to `WorkflowActionView`, supplied by the registered action owner for genuinely blocking choices. Mark plan/developer/wiki approval actions in their owning step behavior. Keep optional completed-workflow close/PR actions and research follow-ups unmarked. The read projection consumes this hint plus existing health/status/question facts; it must not copy the dashboard's legacy phase switches or treat a nonempty `availableActions` list as a gate. This hint does not alter reducer authorization, action availability, graph transitions, durable pins, or execution policy.

Unknown observations must not manufacture a negative fact. Keep known unresolved obligations filled. Otherwise use the hollow marker to mean no *known* obligation and show `unknown`/`stale` in the status or phase line when observation is incomplete; do not present it as verified idle. Retain a last-known filled runtime marker until a successful fresh observation clears it. This preserves the agreed two-marker design without adding a third glyph.

### 4. Display tokens and machine sort keys are separate

Own a short namespace under source `agentic-coding`:

- Workspace rows: `ac_project_line`, `ac_workflow_line`, `ac_type_line`, `ac_phase_line`.
- Pane rows: `ac_project_line`, `ac_workflow_line`, `ac_role_line`, `ac_status_line`.
- Managed pane sort key: `ac_input_rank`, with string values `2` for confirmed/retained input required, `1` for unknown without a known requirement, and `0` for fresh no-input state.

The two target layouts map to four one-token rows each. The precomposed runtime status line includes a stable activity glyph and live semantic status; it does not relabel committed run status as runtime activity. Use existing status formatting where applicable rather than introducing another runtime detector.

The opt-in row configuration is server-wide in effect. To avoid blank/unidentifiable unmanaged entries, the same presentation adapter supplies minimal fallback display tokens for observed unmanaged spaces/panes using their existing Herdr workspace and agent names/status. These are ordinary labels, not invented workflow identities: omit absent workflow/type fields and leave `ac_input_rank` absent. Do not change detection, native names, ownership, or underlying resources. On managed-to-unmanaged transitions clear obsolete workflow and sort tokens explicitly. Only the `ac_` fields owned by this feature may be patched or cleared.

Sort view:

```json
{
  "id": "agentic-coding-sidebar",
  "method": "agent.view.set",
  "params": {
    "source": "agentic-coding",
    "label": "input first",
    "sort": [
      { "field": { "token": "ac_input_rank" }, "order": "desc" },
      { "field": "workspace_order", "order": "asc" },
      { "field": "tab_order", "order": "asc" },
      { "field": "pane_order", "order": "asc" }
    ]
  }
}
```

No filter: unmanaged entries remain visible after managed entries because Herdr places missing sort values last. Use native view ordering so mouse targets, indexed focus, and next/previous navigation agree. Do not sort by glyph or by state-change recency, and do not write Herdr semantic status to force ordering.

### 5. Explicit, scoped presentation synchronization

Reuse the existing application boundary that owns both workflow views and Herdr transport. Extend the tab-sync integration or place the cohesive sidebar projection/publication beside it; do not add a generic UI provider abstraction.

- A successful mutation requests presentation reconciliation after commit, outside the writer transaction. Flush bounded publication before entering a long question/consult wait; do not wait for an entire drain to finish.
- After setup, launch/adoption, handoff, question/answer/expiry, approval, repair, close, and drain completion, reconcile the affected workflow. Workspaces without agent tabs must still receive phase/gate metadata.
- The existing long-lived home/dash application owns a cancellable presentation observer, separate from execution coordinators and pure `status`/`list` functions. Reconcile on start/reconnect and relevant workflow/Herdr events; use a two-second bounded fallback refresh while this observer is alive to cover runtime-only changes and missed events, including when the UI is unfocused.
- Coalesce triggers and serialize publication within each owner; read current views before publishing. Skip unchanged writes and ignore self-generated metadata events to prevent refresh loops. Do not use workflow revision as a sequence for runtime-only changes at the same revision. Concurrent applications must converge by rereading current facts, rather than persisting a second presentation authority.
- Include current identity checks before writing and reject late results after owner disposal or workflow/pane reassignment. Closing or reusing a pane clears obsolete managed tokens.
- On application shutdown cancel timers/socket work and finish only bounded in-flight work. Last published cards may remain; startup reconciliation repairs them. Document that no background publisher exists after all Agentic Coding applications exit.

Keep I/O in shared Herdr/boundary adapters and compose operations according to the workflow Effect guide. The socket request path needs bounded response framing, schema validation, timeout/abort cleanup, and a bounded diagnostic; reuse the shared `.result` parsing boundary rather than implementing envelope parsing in TUI components. Sidebar failures never fail an already-committed command, claim durable effects, consume run tokens, or spawn/retry agents. No secrets, task bodies, question text, or answers enter sidebar metadata.

### 6. Explicit opt-in and reversible ownership

Use one user-owned UI option, `ui.herdr_sidebar = true`, defaulting to false. Read this server-wide preference from trusted user configuration; project configuration must not turn it on or off for other workspaces. Ship a documented four-row Herdr configuration recipe rather than rewriting the user's Herdr config from installer code.

Opt-in acknowledges that the custom view replaces another active view. Install it once per connection/startup, not on every metadata refresh. Reapply after reconnect/server restart while enabled. Do not continually fight a view selected by the user or another tool later in the same connection. On explicit disable, clear the view only with `source: agentic-coding` and remove only owned metadata; restore previous row settings from the user's saved configuration as documented. Ordinary UI disposal must not clear a server-wide view another live Agentic Coding application still uses.

Herdr 0.9.0 is the initial supported capability baseline. Unsupported API/version or missing socket produces one bounded, nonfatal diagnostic, not a fallback semantic-state hack. Do not install dependencies or modify user config merely to probe compatibility.

## Risks / Trade-offs

- Native row configuration is global and metadata-only rows can hide missing values → publish minimal native-name fallbacks for unmanaged entries and verify them in a real Herdr session before shipping the recipe.
- Filled/empty diamonds or tree characters can have font-dependent widths → test both markers with the target terminal/font and native sidebar resizing; use text glyphs without emoji selectors.
- Herdr truncates metadata values to 80 characters → normalize bounded display text without changing canonical identity; test long names, Unicode, control characters, and narrow sidebars.
- Phase-driven gate inference would duplicate role knowledge → registered action owners supply the required-input hint; add a test with an unfamiliar step ID.
- Runtime detection is imperfect and publisher can be absent → show uncertainty, retain known positive obligations on observation failure, and document observer lifetime.
- Multiple application instances or pane reuse can race → coalesce reads/writes, revalidate current identity, clear stale tokens, and test eventual convergence without adding durable projection state.
- Singular transient custom view can conflict with other tools → explicit opt-in, no continuous override, source-guarded clearing, and documented restart behavior.
- Two-second fallback adds observation cost → batch live reads, bound/cancel work, and suppress unchanged publications; do not invoke one full workflow CLI per pane.

## Migration Plan

1. Implement and test the pure projection and registered read-only input hints without changing persisted workflow state.
2. Add bounded metadata/socket adapters and application-owned synchronization behind the disabled-by-default option.
3. Validate native row rendering, agent ordering, unmanaged fallbacks, reconnect, and question timing using disposable Herdr workspaces; do not run destructive tests against active workflows.
4. Publish the opt-in recipe and backup/restore instructions. Merge the recipe into the user's Herdr config only during a separately authorized setup step, then reload Herdr configuration.
5. Enable the user preference and reconcile existing workflows; no workflow repair, repin, migration, or agent restart is required.
6. Roll back by disabling the option, source-guarding view removal, clearing owned metadata, and restoring saved row configuration. Workflow state and agent processes remain untouched.

## Open Questions

No product-scope decisions remain. Native separator behavior, unmanaged fallback rendering, and font widths are explicit implementation validation tasks. True shared project grouping remains deferred rather than an implicit follow-up in this change.

## References

- [Herdr 0.9.0 configuration](https://github.com/herdrdev/herdr/blob/main/docs/versions/0.9.0/website/src/content/docs/configuration.mdx)
- [Herdr agent view queries](https://herdr.dev/docs/socket-api/#agent-view-queries)
- [Herdr metadata commands](https://herdr.dev/docs/cli-reference/#panes)
- `agentic-coding/docs/workflow-architecture.md`
- `agentic-coding/docs/workflow-effect.md`
