## 1. Inventory and navigation
- [ ] 1.1 Confirm hierarchical navigation is implemented; inventory all supported UI/file/schema settings, their section, owner, scope, storage, secrecy and restart behavior.
- [ ] 1.2 Add Settings landing/section routes and project-scoped links using shared page and command primitives.

## 2. Editor migration
- [ ] 2.1 Move profile/preset configuration ownership out of dashboard home; preserve harness model discovery, reference validation, built-in defaults, fusion and registered role assignments.
- [ ] 2.2 Integrate appearance, providers/credentials, projects/environments and backend/telemetry editors; add bounded editors for supported file-only settings and explanatory views for read-only overrides.
- [ ] 2.3 Expose effective source and scope, safe override reset, explicit save/cancel, write-conflict handling and restart requirements; preserve unrelated fields and drafts.
- [ ] 2.4 Route remote configuration writes only through authenticated server adapters; preserve protected secret handling and remove superseded persistent configuration registrations.

## 3. Validation
- [ ] 3.1 Test profile/preset round trips, unknown-role preservation, invalid models/references, default fallback and subsequent-start versus pinned-running-workflow behavior.
- [ ] 3.2 Test local appearance versus attached-server config ownership, unavailable server, authorization failure, stale write, failed persistence and credential redaction.
- [ ] 3.3 Verify every inventory entry is reachable, scoped and documented; open TUI and check section/project links, narrow layouts, footer and complete `?` help.
- [ ] 3.4 Run relevant tests, `bun run type-check`, zero-diagnostic `bun run lint` and strict OpenSpec validation; document source and restart policies.
