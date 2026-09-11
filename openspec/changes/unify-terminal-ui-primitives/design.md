## Context

Depends on `import-devenv-into-agentic-coding`. devenv has broad reusable UI coverage, but agentic-coding already strengthened semantic palette fallbacks and modal summaries/progress. All 33 built-in theme JSONs match; `dash/devenv-ui` is an existing fork. Consolidation must retain functionality instead of selecting one repository's whole component tree.

## Goals / Non-Goals

**Goals:** One implementation for equivalent primitives, one theme/preferences source, renderer parity for each component family.

**Non-Goals:** Global shell/keymap routing, redesigning workflow reviews, changing panel geometry or introducing a universal component options framework.

## Decisions

1. Canonical primitive owner is `agentic-coding/src/tui/shared/`; imported `@devenv/ui` temporarily re-exports primitives from there. Domain-specific environment views remain feature code and cannot become dependencies of shared primitives. Temporary family wrappers adapt prop names/defaults only; delete them when callers migrate.
2. Keep one theme registry and asset set. Combine devenv custom-theme loading/native `renderer.getPalette()` with agentic-coding's semantic token fallbacks. Old Catppuccin names become semantic aliases. Capture has a timeout and only registers `system` after successful valid capture; headless or failed capture falls back to default rather than claiming a captured palette. Do not add a second OSC input reader. Existing dark-mode resolution remains; new light-mode UX is out of scope.
3. Use `$DEVENV_CONFIG_DIR/tui.json` (default `~/.config/devenv/tui.json`) as the canonical local UI preferences file during migration. Existing valid selection wins; otherwise read legacy agentic-coding selection once, then default to catppuccin. Preserve unrelated keys; write atomically. Custom themes use the configured themes directory. Reserved `system` cannot be replaced by a custom file; conflicting imported names are reported without overwriting files. Workflow execution settings remain in their existing provenance-aware config.
4. Common modal frame owns header/content/footer sizing, not global stacking or feature actions. Compose progress, summaries and review content rather than widening GenericModal indefinitely. Until shell cutover, old hosts adapt to this same frame; later the shared modal host owns portal/backdrop/focus.
5. Prefer devenv list/search/filter/match/viewer primitives and agentic-coding behavior where richer. One panel frame and focus prop contract do not require one layout algorithm. Keep directional workflow grid behavior and feature-local selection models.
6. One Highlight mapping, public Badge API, notifications presentation and selection-copy registry. Required animated badge behavior is a supported variant, not another palette/state store. Domain-specific review callbacks and payload anchors stay outside shared markdown/diff rendering.

## Risks / Trade-offs

- Similar-looking modals have different input/stacking semantics → capture representative renderer tests before replacement and retain host adapters until shell migration.
- Color consolidation changes semantic emphasis → test all built-ins plus custom/system/malformed themes; no hardcoded success colors for neutral information.
- Wrapped content hides under scrollbar → test usable content width, narrow layouts and selection copying; do not add generic padding hacks.
- Global theme/selection duplication through workspace imports → assert module identity and one store instance across families.

## Migration Plan

Migrate in this order: theme/colors/preferences; Highlight/Badge; headers/footer text; scrolling/selection/lists; panel/modal frame; basic dialogs/pickers; markdown/diff/log viewers; workflow-specific modal callers. Each family has old/new behavior tests, caller migration and duplicate deletion in one reviewable unit. Run interactive footer/help inspection whenever bindings change. Rollback a family via its source commit; preference migration preserves source files and unknown keys, so old files remain recoverable.

## Open Questions

No blocking choices. New product branding/config-root renaming is deliberately deferred; current devenv UI path avoids another migration.
