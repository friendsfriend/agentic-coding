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
