## Context

`src/tui/dash/Home.tsx` owns model-config modal registration, while `ModelConfigModal.tsx` supplies the profile/preset editor. The authenticated server exposes `/api/v1/config/agents`. Theme preferences already have a canonical client-local source; environment/provider and workflow configuration have separate authorities. Moving their presentation must not redirect writes to the attaching client's checkout.

## Goals / Non-Goals

Goals: all supported application settings reachable in one place, explicit global/project scope, safe writes, removal of configuration dependency on workflow lists. Non-goals: invent new knobs, expose internal runtime state as settings, merge storage formats, rotate credentials automatically or reconfigure running workflows silently.

## Decisions

1. Depend on hierarchical navigation and add Settings as a Home destination. Child pages are Appearance, Agent models/presets, Providers/credentials, Projects/environments and Backend/telemetry. Inventory current UI controls, documented config fields and public config schemas. Map each supported setting to a section, owner, source, validation and application/restart policy. Read-only environment/CLI overrides must remain visible with explanations, not masquerade as writable controls.
2. Reuse the existing profile/preset editor and domain-specific provider/project editors. Move ownership and keymap registration out of `dash/Home.tsx`; do not duplicate forms. For supported file-only settings, add the smallest domain editor using the existing parser/writer. Do not generate an editor for every internal field or add a schema-to-form framework.
3. Scope is explicit before load/save. Appearance writes client-local `$DEVENV_CONFIG_DIR/tui.json` (default `~/.config/devenv/tui.json`). Backend/providers/project configuration targets the connected server via authenticated typed APIs. Agent settings use their resolved user/project source. Project shortcuts open the same page with a stable configured application/library ID. Never infer an arbitrary repository from cwd.
4. Display effective values and their source/override status; allow editing or resetting supported overrides at their actual owning scope. Do not imply every setting supports every scope. Preserve original formats, unrelated keys, unknown preset role tables and source precedence. Validate before mutation; failures preserve last valid state and unsaved input. Use existing concurrency protection, or detect stale reads before write rather than overwrite another client's changes.
5. Credentials use existing protected storage/authentication flows. Display status and masked identifiers, not saved secrets. Do not place secret values in route payloads, histories, telemetry, logs or ordinary UI preference JSON. Newly entered secrets stay confined to the credential flow and are cleared after completion/cancellation.
6. Model enumeration stays harness-specific; preserve pi/opencode/opencode-v2, model-agnostic defaults, custom profiles, reference checks, role-catalog assignments and fusion routing. Saving affects subsequent workflow starts. Existing explicit revision-bound running-workflow preset adoption is an operational action, not a persistent Settings editor, and remains governed by current engine rules.
7. Backend/telemetry fields with restart requirements report that explicitly. No implicit restart, termination of an attached server, or silent live application of unsafe changes. A failed/unavailable server yields a retryable section error, not a write to local fallback config.

## Risks / Trade-offs

Settings inventory can reveal gaps in old UIs; completeness means exposing supported settings, not extending backend semantics. Attach mode has two legitimate config owners; visible scope and authenticated adapters prevent accidental local writes. Preserve drafts across section navigation and require explicit save/cancel for destructive edits.

## Migration Plan

Complete the settings ownership inventory and editor parity tests, add Settings routes, migrate each editor, then remove old persistent config entrances. Project links follow when resource pages are available. Retain operational commands such as provider login/status and revision-bound workflow actions where needed, backed by the same services. No config migration is required.

## Open Questions

None blocking. Actual supported fields and restart policies must be recorded from source before implementation; the inventory is an acceptance artifact, not a license to omit existing settings.
