# Tasks

## 1. Compaction policy and configuration

- [x] 1.1 Add `src/workflow/compaction.ts`: the `CompactionConfig` shape (`enabled`, `reserveTokens`, `backgroundTokens`, `keepRecentTokens`), the documented defaults (`enabled: true`, reserve 32000, background 32000, keepRecent 20000), `parseCompactionConfig` (absolute integer or `"N%"` string per field, unknown keys ignored) and `resolveCompactionPolicy(config, referenceWindow?)` with the floors/clamps from design D2 (reserve and keepRecent ≥ 4096, background ≥ 0 disables, reserve ≤ window/2, keepRecent ≤ window − reserve − 1024) and the absolute-default fallback for a percentage with no window. Verify: absolute, percentage, fallback, floor, clamp and invalid-input cases in a focused test.
- [x] 1.2 Add the config validation used by the write path (`validateCompactionConfig`) returning per-field errors for a non-integer, a negative value, an out-of-range percentage and `background` below zero; verify each rejection names its field.
- [x] 1.3 Resolve `[agents.compaction]` in `host-main.ts` through the user-level layered configuration (honoring `HERDR_WORKFLOW_CONFIG`), keep `agentHost.compaction` as the precedence override, and expose the resolved section on a live accessor instead of a snapshot. Verify with a temp config dir: configured value wins over defaults, the override wins over `agents.compaction`, and a project overlay's `agents.compaction` is not read.
- [x] 1.4 Update `docs/config-inventory.md` with the `[agents.compaction]` section, its user scope, its precedence against `agentHost.compaction`, and the documented defaults.

## 2. Host: live policy and manual compaction

- [x] 2.1 Forward the compaction policy to `Harness.open` as a getter (design D4) and recompute it when the configuration file's mtime/size or the tracked-run model set changes; `retry`/`steeringMode`/`followUpMode` keep their current snapshot semantics. Verify: a config edit between two resolutions changes the resolved policy for an already-open conversation (faux provider + memory storage), and the forwarding of the other settings is unchanged.
- [x] 2.2 Track each conversation's model ref in `ensureRun`/`configureRun` (with the `pi.agent` document as fallback) and resolve the reference window as the smallest context window among the tracked runs (design D3). Verify: min over two models, window unknown, and a `/model` change shrinking the window.
- [x] 2.3 Add `DurableHost.compactRun(runId, instructions?)` with the outcome vocabulary from design D5: `already-compacting` when `pi.live.compactions` is non-empty (no second task admitted), `started` with the admitted task id, `nothing-to-compact` when the task is not listed after admission, and the existing `unknown-run` error for an untracked run; bound and trim the instructions. Verify all four outcomes against a faux provider.
- [x] 2.4 Add `CompactRunRequest`/`CompactRunResponse` to `protocol.ts`, the `compactRun` handler branch in `host.ts`, and `HostClient.compactRun`. Verify: the protocol test asserts framing and the structured outcomes, an unknown run maps to the `unknown-run` error code, and an over-long instruction is rejected as `invalid-request`.

## 3. Telemetry

- [x] 3.1 Map `compaction_start`/`compaction_end` in `src/agent-host/telemetry.ts` to `runtime.compaction_start` and `runtime.compaction` with reason, blocking flag, attempts, measured duration, tokens before/after (measured from `message_end` usage around the compaction) and outcome with a redacted bounded error class correlated from `task_failed` (design D7). Verify the envelope fields, the aborted and failed outcomes, and that no summary text reaches an envelope.
- [x] 3.2 Update `docs/agent-session-telemetry.md` with the two compaction envelopes and their fields.

## 4. Settings

- [x] 4.1 Add the `settings.compaction` page (`src/tui/shared/routes.ts`: `PageId`, `SETTINGS_SECTIONS`, label, description, `PAGES`) and the `agents.compaction` inventory entry in `src/tui/settings/catalog.ts` (owner `src/workflow/compaction.ts`, scope user, storage `[agents.compaction]`, effect immediate) with its `docs/settings-inventory.md` mirror row; verify `inventoryGaps()` is empty and every inventoried entry still reaches a rendered item.
- [x] 4.2 Render the section items in `src/tui/settings/items.ts` (`compaction.enabled`, and one row per token field showing the effective value, the reference window a percentage resolved against, the source, and the defaults) from a new `agents.compaction` status read; verify each row's value and detail for defaults, configured and overridden cases.
- [x] 4.3 Add the bounded numeric editor (design D8): a new `numeric-edit` settings action and one shared editor overlay accepting only a whole number within bounds plus the documented `%` form, with inline validation, Enter to save and Esc to cancel; verify accepted/rejected input, confirmation and cancellation.
- [x] 4.4 Add the `set-compaction` agents mutation to `src/server/config.ts` using `validateCompactionConfig`, written user-scoped through `saveAgentsSection` so a project overlay cannot capture it, with the existing revision check; verify a valid round-trip, an invalid value rejected naming its field, a stale revision refused, an unrelated `[agents]` key preserved, and the overlay case.
- [x] 4.5 Surface the effective compaction values in the agents status read (`loadAgentConfig`/`AgentConfigRead`) and in `SettingsContext.agents`; verify the section renders from the server response and that an unavailable server stays a retryable section error.

## 5. Session view and prompt command

- [x] 5.1 Add `COMPACT_COMMAND` to `AgentSessionView.tsx`, its entry in the command list, argument parsing for `/compact <instructions>` (bare `/model`-style commands keep exact-match behavior) and the `onCompact` prop; verify the command appears in the autocomplete and the instructions reach `onCompact`.
- [x] 5.2 Wire `onCompact` in the dashboard (`App.tsx`) and the orchestrator (`OrchestratorView.tsx`) to `HostClient.compactRun`, with a notice per outcome (`started`, `already-compacting` naming the reason, `nothing-to-compact`, `run finished` for an `unknown-run` error, and any other failure); verify each notice path with a stubbed client.
- [x] 5.3 Show compaction feedback in the session: reason-labelled running block from `pi.live.compactions` (manual/automatic, retrying/blocked status), finished compaction with measured tokens before/after from the conversation's own usage around the `pi.compaction` entry, the failure with a bounded error, and the aborted case after `/abort` (design D6); verify the projection and metadata for each case, including that tokens are omitted rather than invented.
- [x] 5.4 Show a reason-carrying compaction indicator in the Agents-panel activity and the session status; verify the label for a manual compaction and that the existing fallback behavior is unchanged.

## 6. Docs

- [x] 6.1 Document `/compact` and the compaction policy in `docs/orchestrator.md` (next to `/model` and `/thinking`), the session-view command, the outcome notices, and that `/abort` also aborts a manual compaction; add the Compaction Settings section to `docs/settings-inventory.md`.

## 7. Focused checks

- [x] 7.1 Run `bun run lint` and `bun run type-check` with zero diagnostics.
- [x] 7.2 Run the focused tests for this change (`test/agent-host-*.test.ts` for the host/protocol/telemetry paths, `test/settings-configuration.test.ts`, the settings page tests, `test/dash/agentSession*.test.ts` and the activity test) and confirm the changed behavior is covered.
- [x] 7.3 Confirm no test or run touched the real store or the real config directory: every test uses a temp directory/home, and no repository-wide test command was added to this change's required checks.
