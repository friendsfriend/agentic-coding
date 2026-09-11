## 1. Prerequisites and route fixtures

- [ ] 1.1 Confirm port-project-catalog-and-state-to-bun is implemented; map integration routes and action callers.
- [ ] 1.2 Capture provider-specific success/error/pagination/diff-position fixtures and mutation reconciliation expectations.
- [ ] 1.3 Define private operation adapter for Go action calls with exact run/step/command/output/cancellation identity.

## 2. Git and provider foundation

- [ ] 2.1 Port provider configuration/credentials and repository/branch search with secure validation/redaction.
- [ ] 2.2 Port Git repository/status/branch/worktree reads with canonical-checkout fixtures.
- [ ] 2.3 Port Git fetch/pull/push/checkout/branch operations with safe argv and isolated repository tests.
- [ ] 2.4 Port worktree create/switch/remove and ownership protections; verify workflow pins do not retarget.
- [ ] 2.5 Connect Go action callers through private adapter with exactly-once command accounting and no route recursion.

## 3. GitHub and GitLab

- [ ] 3.1 Port GitHub issue reads/search/filter/paging and linked-reference queries.
- [ ] 3.2 Port GitHub issue mutations and label/assignee/comment operations with no blind POST replay.
- [ ] 3.3 Port GitHub change-request/diff/discussion/approval operations preserving position/version identity.
- [ ] 3.4 Port GitHub CI job/test/log queries and supported controls/streams.
- [ ] 3.5 Port GitLab issue reads/search/filter/paging and linked-reference queries.
- [ ] 3.6 Port GitLab issue mutations and label/assignee/comment operations.
- [ ] 3.7 Port GitLab MR versions/diffs/discussions/replies/resolution/approval/rebase behavior.
- [ ] 3.8 Port GitLab CI job/test/log queries and retry/cancel controls/streams.

## 4. AI and session services

- [ ] 4.1 Port bounded Pi session discovery/JSONL parsing with malformed/oversized fixture tests.
- [ ] 4.2 Port streamed log analysis and process cancellation/error handling.
- [ ] 4.3 Port CR review checkout ownership and Pi RPC stream lifecycle.
- [ ] 4.4 Port scoped callback authorization and provider comment submission; test wrong target/expired token/disconnect.
- [ ] 4.5 Test cleanup preserves pre-existing worktrees and never persists secrets.

## 5. Cutover and acceptance

- [ ] 5.1 Switch complete route families to Bun only after fixture parity; settle old requests before changing mutation owner.
- [ ] 5.2 Exercise provider/issue/CR/CI/agent UI journeys through unchanged clients and record remaining Go owners.
- [ ] 5.3 Run combined verification and isolated integration smoke tests; document unavailable live-provider coverage and rollback boundaries.
