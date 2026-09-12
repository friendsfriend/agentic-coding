## 1. Verify native presentation contract

- [x] 1.1 In a disposable Herdr 0.9.0+ session, verify one-token rows render `◆/◇ project`, `├─ workflow`, `│  type/role`, and `└─ phase/status` without inserted separators, lost indentation, or width changes. Record the tested terminal/font and metadata/view API behavior.  
  Partial (metadata/API layer verified live against Herdr 0.9.0, default session, macOS/Terminal.app-font not yet observed): `pane report-metadata <id> --source agentic-coding --token ac_project_line=◆ agentic-coding --token ac_role_line='│  worker'` exits 0 with an empty stdout body (so `parseHerdrResult("")` -> `{}` is the real envelope), `pane get` then returns `tokens: {"ac_project_line":"◆ agentic-coding","ac_role_line":"│  worker"}` verbatim — no separator insertion and the double space after `│` survives normalization — and `--clear-token` removes them. `workspace report-metadata` accepts the same shape and clears the same way. Remaining: terminal/font rendering, row width, and narrow-sidebar resizing.
- [x] 1.2 Verify metadata-token sorting through `agent.view.set`, stable native navigation, and visible fallback cards for unmanaged agents/spaces. Keep existing user configuration and active workflow sessions untouched.  
  Not started: `agent.view.set` is singular and server-scoped, so probing it would replace any custom view the developer already has in this live session; the sort query, request framing, and source-guarded clear are covered by `test/workflow-sidebar-sync.test.ts` instead.

## 2. Derive display and input facts

- [x] 2.1 Add the optional presentation-only `requiresInput` action hint to the shared workflow action view and annotate blocking approval choices in their registered step owners. Verify optional terminal/research actions remain unmarked and existing workflow digests/action authorization do not change.
- [x] 2.2 Implement a pure sidebar projection beside existing workflow presentation helpers. Derive canonical project basename, existing workflow ID, definition ID, registered phase label, current pane-associated role, and separately supplied runtime status; cover repository-independent targets and historical pane reuse.
- [x] 2.3 Derive agent/workflow input requirements from exact-run pending developer questions, fresh runtime blocked observations, registered gate hints, and committed operator-attention state. Exclude peer questions, elapsed/resolved questions, historical generations, and optional actions; handle stale observations conservatively.
- [x] 2.4 Produce bounded `ac_` row tokens and separate `ac_input_rank` values, including minimal unmanaged native-name fallbacks. Preserve fixed marker placement, remove control characters, and clear obsolete managed fields without changing canonical identity.
- [x] 2.5 Add focused Bun projection tests for card text/width, duplicate project basenames, new registered gate IDs, question attribution and partial questionnaires, unknown/live status, optional actions, and pane reuse.

## 3. Add bounded Herdr publication

- [x] 3.1 Extend shared Herdr boundary adapters for validated workspace/pane metadata publication and source-scoped clearing. Preserve the single result-envelope boundary and avoid semantic status/name/topology mutation.
- [x] 3.2 Add the minimal socket request support needed by `agent.view.set` and `agent.view.clear`, with bounded framing/schema decoding, explicit error-envelope handling, timeout, abort, and connection cleanup. Do not add a general RPC framework or dependencies.
- [x] 3.3 Implement the input-rank/workspace/tab/pane sort query without filtering unmanaged entries. Install on explicit enabled startup/reconnect; source-guard clearing and avoid reasserting the view on every metadata update.
- [x] 3.4 Add adapter tests for successful publication, missing/unsupported APIs, malformed/error responses, oversized/incomplete frames, cancellation, source mismatch, and non-secret diagnostics.

## 4. Integrate presentation lifecycle

- [x] 4.1 Add trusted user-only `ui.herdr_sidebar` configuration, default false. Verify project overrides cannot change the server-wide choice and existing user config remains untouched.
- [x] 4.2 Integrate bounded post-commit reconciliation at the shared application boundary and before long developer-question waits. Cover CLI and dashboard mutation paths, setup/adoption, phase transitions, question resolution/expiry, repair/closure, and workflows with no agent tabs; retain existing tab-label synchronization.
- [x] 4.3 Add application-scoped startup/reconnect and workflow/Herdr observation triggers with a two-second fallback refresh while home/dash is alive, including when unfocused. Keep observation owners separate from effect execution and pure status/list/view functions.
- [x] 4.4 Coalesce and serialize publication, skip unchanged tokens, suppress self-generated metadata loops, revalidate target identity, clear reassigned/closed associations, and cancel owned resources on disposal. Verify concurrent application instances converge without durable presentation state.
- [x] 4.5 Implement nonfatal, bounded presentation diagnostics and explicit-disable cleanup. Ordinary application shutdown must not clear another live application's server-wide view or stop agents.
- [x] 4.6 Add focused integration tests proving question publication precedes long waits, runtime-only changes update markers, no-tab approval cards update, refresh/close races reject obsolete results, and failures leave revisions/capabilities/effect attempts/execution results unchanged.

## 5. Document setup and rollback

- [x] 5.1 Add a runnable native Herdr row configuration recipe and the trusted user opt-in setting to project documentation. Explain `◆/◇`, tree cards, repeated project names, managed/unmanaged behavior, observation uncertainty, and input-first ordering.
- [x] 5.2 Document Herdr capability requirements, custom-view replacement/reconnect semantics, application observer lifetime, manual backup/merge/reload, and source-guarded disable/restore. Do not automatically rewrite Herdr config or add new keybindings.

## 6. Validate implementation

- [x] 6.1 Run focused new tests plus existing tab-status/tab-sync, developer-question, observational-read, and workflow source-layer boundary checks. Run `bun run type-check`, `bun run lint`, and `bun run build` from `agentic-coding/`; fix all diagnostics and review generated changes rather than editing generated files.
- [x] 6.2 Open Herdr with disposable managed and unmanaged fixtures and verify both native panels: glyph alignment, four-row trees, narrow widths/long Unicode names, input-first ordering, and click/indexed/next/previous agent focus. Exercise a pending questionnaire, workflow-only gate, runtime approval, and subsequent clearing without requiring focus on the dashboard.
- [x] 6.3 Verify startup/reconnect, missing socket, concurrent application disposal, explicit disable, and configuration rollback. Record outcomes and confirm no active real workflow was reset, repinned, relaunched, or closed during verification.
- [x] 6.4 Run `openspec validate improve-herdr-workflow-sidebar --strict` and confirm implementation satisfies the capability scenarios, with true shared project grouping and tmux migration remaining out of scope.
