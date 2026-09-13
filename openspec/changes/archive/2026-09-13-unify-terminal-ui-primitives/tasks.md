## 1. Prerequisites and component contracts

- [x] 1.1 Confirm import-devenv-into-agentic-coding is implemented and its parity baseline is available.
- [x] 1.2 Inventory all callers of duplicated primitive families, noting retained variants and their renderer contracts.
- [x] 1.3 Establish canonical shared exports and temporary prop adapters without feature/backend imports into shared UI.

## 2. Theme and preferences

- [x] 2.1 Consolidate 33 built-in assets and registry; test one store identity across imported/current consumers.
- [x] 2.2 Replace hardcoded palette consumers with semantic tokens and compatible aliases; test custom/incomplete themes.
- [x] 2.3 Consolidate renderer palette capture; test success, invalid response, timeout and headless fallback.
- [x] 2.4 Implement canonical preference import/precedence and atomic saves preserving unknown keys; test write failures.
- [x] 2.5 Consolidate custom-theme loading and picker; test reserved names, collisions and live cross-family updates.

## 3. Small primitives

- [x] 3.1 Migrate Highlight and Badge variants with animation cleanup tests; delete superseded color/animation ownership.
- [x] 3.2 Migrate SearchHeader, FilterStatusBar and HelpText callers; preserve live-search and compact/standard labels.
- [x] 3.3 Migrate scrolling/list/MatchedText primitives; test narrow wrapping, virtual selection and scrollbar width.
- [x] 3.4 Consolidate selection-copy registry and clipboard notifications; test one copy action per selection event.
- [x] 3.5 Consolidate notification rendering and panel frame; retain existing workflow grid navigation behavior.

## 4. Modal and viewer families

- [x] 4.1 Extract common modal frame with composed progress/summary content and existing-host adapters.
- [x] 4.2 Migrate confirmation/error dialogs and pickers with focus/backdrop/Enter/Escape renderer tests.
- [x] 4.3 Migrate markdown/log viewers with content-width and selection parity checks.
- [x] 4.4 Migrate diff viewers while retaining provider positions and workflow review/comment anchors.
- [x] 4.5 Migrate workflow creation/configuration/questions/review modal framing without changing payloads or draft semantics.
- [x] 4.6 Delete duplicate implementations after each family's last caller moves, including obsolete dash/devenv-ui forks.

## 5. Acceptance

- [x] 5.1 Run representative renderer tests for every migrated family at narrow/wide and short/tall dimensions.
- [x] 5.2 Open TUI and check theme updates, nested dialogs, focus, selection and every changed footer/? help entry.
- [x] 5.3 Run combined verification with zero Biome diagnostics and update component parity inventory.
