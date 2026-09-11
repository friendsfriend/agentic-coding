## 1. Prerequisites and component contracts

- [ ] 1.1 Confirm import-devenv-into-agentic-coding is implemented and its parity baseline is available.
- [ ] 1.2 Inventory all callers of duplicated primitive families, noting retained variants and their renderer contracts.
- [ ] 1.3 Establish canonical shared exports and temporary prop adapters without feature/backend imports into shared UI.

## 2. Theme and preferences

- [ ] 2.1 Consolidate 33 built-in assets and registry; test one store identity across imported/current consumers.
- [ ] 2.2 Replace hardcoded palette consumers with semantic tokens and compatible aliases; test custom/incomplete themes.
- [ ] 2.3 Consolidate renderer palette capture; test success, invalid response, timeout and headless fallback.
- [ ] 2.4 Implement canonical preference import/precedence and atomic saves preserving unknown keys; test write failures.
- [ ] 2.5 Consolidate custom-theme loading and picker; test reserved names, collisions and live cross-family updates.

## 3. Small primitives

- [ ] 3.1 Migrate Highlight and Badge variants with animation cleanup tests; delete superseded color/animation ownership.
- [ ] 3.2 Migrate SearchHeader, FilterStatusBar and HelpText callers; preserve live-search and compact/standard labels.
- [ ] 3.3 Migrate scrolling/list/MatchedText primitives; test narrow wrapping, virtual selection and scrollbar width.
- [ ] 3.4 Consolidate selection-copy registry and clipboard notifications; test one copy action per selection event.
- [ ] 3.5 Consolidate notification rendering and panel frame; retain existing workflow grid navigation behavior.

## 4. Modal and viewer families

- [ ] 4.1 Extract common modal frame with composed progress/summary content and existing-host adapters.
- [ ] 4.2 Migrate confirmation/error dialogs and pickers with focus/backdrop/Enter/Escape renderer tests.
- [ ] 4.3 Migrate markdown/log viewers with content-width and selection parity checks.
- [ ] 4.4 Migrate diff viewers while retaining provider positions and workflow review/comment anchors.
- [ ] 4.5 Migrate workflow creation/configuration/questions/review modal framing without changing payloads or draft semantics.
- [ ] 4.6 Delete duplicate implementations after each family's last caller moves, including obsolete dash/devenv-ui forks.

## 5. Acceptance

- [ ] 5.1 Run representative renderer tests for every migrated family at narrow/wide and short/tall dimensions.
- [ ] 5.2 Open TUI and check theme updates, nested dialogs, focus, selection and every changed footer/? help entry.
- [ ] 5.3 Run combined verification with zero Biome diagnostics and update component parity inventory.
