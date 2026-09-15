## 1. Baseline and route model
- [ ] 1.1 Inventory current shell/environment/observability destinations, keyboard and mouse entrypoints, feature restrictions and route-local state; record replacement routes and parity evidence.
- [ ] 1.2 Replace per-feature/single-origin assumptions in the pure route reducer with typed identities, structural parents, chronological Back and keyed view state; test multi-domain hops, repeated visits and deleted resources.

## 2. Pages and chrome
- [ ] 2.1 Add Home and category pages, one bounded breadcrumb row and a shared location picker using existing list/modal primitives.
- [ ] 2.2 Migrate Environments categories and application/library resource views; retain all operational capabilities without inner navigation tabs.
- [ ] 2.3 Migrate observability list/detail/span and Wiki navigation to the same route authority; preserve existing availability restrictions and wiki review drafts.
- [ ] 2.4 Make default/home/manager full-app entry open Home; keep explicit supported entry modes and the temporary workflow entry until its dependent changes land.

## 3. Input and lifecycle
- [ ] 3.1 Remove old shell/inner-tab cycling and numeric dispatch; resolve picker/Parent binding collisions and register page-local focus, Back and modal precedence once.
- [ ] 3.2 Preserve selected IDs, filter/sort/search, scroll, focus and drafts across navigation; add unavailable-resource fallback without silent draft loss.
- [ ] 3.3 Verify page visibility never changes backend/coordinator/telemetry ownership and foreground utility waiting remains asynchronous.

## 4. Validation
- [ ] 4.1 Add rendered navigation checks for Home → Applications → resource, Home → Observability → trace → span, cross-domain Back versus Parent, modal/text input isolation and inactive handlers.
- [ ] 4.2 Open the TUI at narrow and wide sizes; check keyboard/mouse breadcrumbs, picker, every migrated destination, footer special keys and complete `?` help; record evidence.
- [ ] 4.3 Run relevant tests, `bun run type-check`, `bun run lint` with zero diagnostics, and strict OpenSpec validation; document the temporary workflow bridge and removal dependency.
