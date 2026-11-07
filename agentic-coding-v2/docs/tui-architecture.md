# Native TUI architecture

## Agreed scope

Implement directly in the v2 development session, without presets or a coding workflow. Build a fresh OpenTUI/Solid shell using the original OpenTUI keymap stack. Adapt only selected presentation primitives; never import the legacy application, workflow engine, classifiers or presets at runtime. Do not expand the web UI.

Left sidebar fixed order: OpenCode, Pi, Pi Durable, Orchestrator. The native child-session tree follows all fixed entries. Session management happens only through the orchestrator and transcript commands, not separate management forms.

Retain full transcript/tool presentation, prompt commands, usage/status feedback, sidebar conveniences, navigation/history, interaction primitives, environment resources/actions, provider integrations, observability, native task reviews/details and lifecycle UI. Schedule UI provides overview/deletion only; create/update belongs to the orchestrator. Wiki comments trigger native skill tasks. Settings preserve the presentation style but expose only writable v2 settings.

A new right sidebar stores viewpoints for any view. Capture resource identity, selection, filters, sort, expanded sections, scroll/focus and unsent drafts. Restoration changes client state only: never replay actions, restore approval authority or overwrite backend state. Handle missing resources explicitly. Persist no credentials; durable unsent-draft storage needs an explicit retention/security design.

## Structure and dependencies

- `src/protocol/`: transport-neutral client/server schemas, envelopes and feature contracts.
- `src/server/index.ts`: public server start/stop entrypoint.
- `src/server/host.ts`: listener, request host/origin fences and transport mounting.
- `src/server/auth.ts`: shared credential comparison.
- `src/server/http/`: preserved existing HTTP routes and web assets.
- `src/server/client/index.ts`: sole TUI gateway entrypoint, backed by native services through feature handlers.
- `src/tui/client/`: protocol connection and synchronized client data; no Runtime/storage imports.
- `src/tui/shell/`: composition, navigation and both sidebars/viewpoints.
- `src/tui/ui/`: genuinely shared presentation primitives, themes and keybind catalogs.
- `src/tui/features/`: sessions/transcript/tools, tasks, environments, providers, observability, schedules, wiki and writable settings.

Create files when needed rather than scaffolding empty modules. Backend business logic remains in the native modules; neither backend nor shared protocol depends on OpenTUI. Replace the minimal ANSI client once the new client is usable.

## Testing agreement

Few, simple functional tests at public boundaries. No renderer mounting, component-tree assertions, screenshot/layout snapshots, terminal-navigation simulation suites or per-key/presenter/helper coverage matrices. Extend existing backend scenarios where possible.

Representative new behaviors worth proving: authenticated gateway request/subscription; reconnect without duplicated mutations; viewpoint restore without action execution; wiki comment creates the intended native skill task; representative settings save/refusal. Do not write all these tests upfront or duplicate backend safety tests in the client.

Visual and terminal usability verification is manual, including resize, focus, mouse, streaming transcript, specialized cards and help/footer consistency. Biome, whole-project type-check including TSX, and build remain checkpoint gates. Fake-backed tests do not prove live model/runtime compatibility.

## Implementation status

First increment: server moved out of `src/server.ts` into host/auth/HTTP modules; callers use `src/server/index.ts`. Existing web asset bytes and HTTP routes retained. Native client gateway and proper OpenTUI shell are not implemented yet.

Verification: 19 existing functional tests pass across runtime, provider, Kubernetes-service and minimal-client scenarios; Biome, whole-project type-check, build and compiled help pass. Corrected existing type errors in the minimal client and Kubernetes fixture tests. Full suite deferred to a larger checkpoint.

### Subsequent native client/shell foundation

- Added the single authenticated `/api/client` gateway and transport-neutral versioned protocol. Bounded requests/results, published methods, connection-local subscription ordering, native delegation and explicit uncertain-command outcomes replace direct TUI Runtime access. The interface document records actual guarantees, including upstream submission-id limitations and non-atomic derived snapshots.
- The CLI starts the host before opening the TUI and passes the native credential in-process/header-only. Reconnect reads state/subscribes again and never replays a mutation. Gateway polling is lazy and non-overlapping; no headless-only client timer is introduced.
- Installed matching OpenTUI core/Solid/keymap 0.7.0 and Solid 1.9.17. Added TSX checking, the Solid build transform, renderer/keymap/client/signal lifecycle, a fresh two-sidebar shell, the selected original Catppuccin theme asset and initial native transcript/tool expansion. Removed the ANSI loop/model and their presentation-helper tests; there is no second terminal implementation.
- Fixed sidebar order is preserved, followed by expandable native children. Current native skill children and new completed skill transcripts are discoverable through retained task metadata; no legacy migration or arbitrary conversation adoption. Native profile changes, abort, compact, input, task cancellation, review decisions, schedule deletion, operator environment admission and logs are bound through the gateway.
- Added navigation/back/forward and memory-only viewpoints with resource identity, selected row, filter/sort, expanded sections, main scroll/focus and unsent draft. Restoration is strictly data-only; missing native resources remain unavailable and drafts stay unsent. No durable draft file or credential storage was added.
- Initial task/review, environment, provider, observability and schedule displays expose existing native records. They are not the finished selected specialized feature presentation. OpenCode/Pi connection modes, wiki/comment-skill bindings and writable settings are explicitly unavailable, not silently connected to legacy authority.

Checkpoint: 19 functional tests pass across native runtime, provider, Kubernetes-service and client/viewpoint scenarios. Three new behavioral scenarios cover gateway/authentication/native refusal, an in-flight mutation becoming uncertain followed by **same-client** reconnect without replay, and data-only viewpoint restoration. The existing native completion scenario also proves that a completed child transcript remains readable and not writable through the public gateway. The gateway scenario also observes a real subscription update and reopens persistent native storage to verify deleted schedule identities stay retired (no delete/recreate ABA). No renderer mounting, layout snapshots, navigation matrices or per-key tests were added.

Whole-project Biome/type-check (including TSX and the build script), build and compiled help are clean. Legacy `lint:boundaries` (71 passes) and full unfiltered type-check also pass; no legacy source or generated assets were changed. The build is a JS bundle requiring the installed OpenTUI runtime/native assets, not a portable standalone executable. No visual TTY verification or live model/provider/engine/cluster proof is claimed. The full native suite was not rerun at this checkpoint; this repository has no configured env-test target in the current host inventory.

### Subsequent retained native tool presentation

- Adapted the original file/shell/diff presentation ideas into native-only feature components. Read and write bytes use OpenTUI code presentation; edit cards show the retained native `details.patch`/`diff`, never an invented applied diff. Write arguments are labelled requested bytes, not a live file snapshot. Shell commands and output remain literal; a non-error result is labelled **Result recorded**, not inferred command success or exit zero.
- Native call IDs are opaque. Only a unique retained call/result pair with a matching tool name is combined. Missing/clipped or ambiguous identities remain explicitly unknown; orphan results stay visible. Native diagnostics are preserved. The read body removes only an exactly matching separately recorded native diagnostic footer, not file bytes that resemble harness markup. Complete retained output and native details remain independently inspectable. Unknown tools retain structured JSON/text fallback; inline images still have explicit placeholders.
- Added shared header-only folding and a focus-scoped layer in the original OpenTUI keymap stack: Ctrl+Up/Down selects retained thinking/tool cards, Ctrl+O toggles the selected card, and Ctrl+Alt+A/O/D folds arguments/output/details. Explicit keyboard navigation reveals the selected native header using rendered positions. These are client-state changes only; they cannot execute, apply, approve or retry tools. Ordinary prompt input is unchanged.
- Expansion keys use native conversation/entry/model/content identities. Selected-card identity lives in the existing data-only viewpoint detail field, alongside the existing expansion/scroll/focus/draft state. Restoring a missing card retains the identity and reports that it is outside the window; it does not auto-select another card or run navigation commands. Earlier prototype expansion keys are not migrated to this canonical identity scheme.
- Extended the existing real native-task fixture at the public client boundary: a terminal child now performs write/edit/read, and the authenticated transcript preserves tool names, call/result IDs and the actual native edit patch. No renderer mounting, UI snapshots, presenter tests or per-key suites were introduced.

Proof boundary: focused functionality gates and static/build checks do not verify native terminal geometry, key delivery, scroll behavior, syntax highlighting or visual usability. Manual TTY verification, live progress, richer tool tables/custom families and the broader acceptance scope remain pending. Existing HTTP/web bytes and backend authority paths are unchanged.

**Remaining agreed scope:** adapt the complete selected original transcript/specialized tool/shared primitives rather than treating the initial generic native presenter as parity; finish environment resources/diagnostics/action controls, provider operations, observability, native evidence/detail viewers, full descendant-tree conveniences, prompt/history/interaction polish, native OpenCode/Pi bindings, wiki/comment skills and writable settings. Durable viewpoint retention still needs its security/retention implementation. This increment does not fulfill the whole TUI acceptance scope.
