# Tasks

## 1. Server removal

- [x] 1.1 Delete `src/server/integrations/cr-review.ts` (checkout, RPC event
  mapping, callback registry, token, comment submission, review target) and
  drop `gitLabReviewTarget` from `gitlab-routes.ts`, which existed only for the
  callback.
- [x] 1.2 Remove the review stream and comment callback from the AI dispatcher
  (`ai-routes.ts`) and the route manifest (`routes.ts`), including the
  `crReviewSessions` singleton and the now-unused `sseError` helper.
- [x] 1.3 Remove `isSessionAuthorizedRoute` from `auth.ts` and its branch in
  `app.ts`, so every route requires the instance bearer token.
- [x] 1.4 Verify `bun run type-check` passes and no server module references the
  removed feature.

## 2. Devenv and UI removal

- [x] 2.1 Delete `packages/ui/src/views/CrAiReviewOverlay.tsx` and its barrel
  export.
- [x] 2.2 Delete `packages/devenv/cli/src/tui/actions/cr-ai-utils.ts`
  (`buildCrReviewPrompt`) and the `runCrAiReview`/`postCrAiComments` actions
  with their returned API entries.
- [x] 2.3 Remove the overlay state from `cr-store.ts`, the overlay key handling
  and the `Shift+A` binding from `cr-detail-keys.ts`, the overlay from
  `modal-overlays.tsx`, and the registry entry plus its short label from
  `keyboard/registry.ts`.
- [x] 2.4 Remove `analyzeCRWithAIStream` from `packages/devenv/core` (client and
  barrel) and the AI-review mention from the Git integrations guide.
- [x] 2.5 Verify the CR detail keyboard behaviour that is not the review
  (panel navigation, `o`/`C`/`T`/`D`, `a`, `r`) is untouched, and that
  `bun run test:devenv` passes.

## 3. Tests, docs and specification

- [x] 3.1 Remove the change-request review and callback suites from
  `test/integration-ai.test.ts`, keep session discovery and log analysis, and
  simplify the fake Pi to what those routes use.
- [x] 3.2 Remove the removed-route ownership assertion from
  `test/integration-private-api.test.ts`.
- [x] 3.3 Update `docs/integration-port.md` (route table, module table, the
  deliberate-differences list) and the CR AI review rows in
  `docs/devenv-merge-parity.md`.
- [x] 3.4 Add the modified `bun-development-integrations` requirement and verify
  `openspec validate remove-change-request-ai-review --strict`.
- [x] 3.5 Verify `bun run lint`, `bun run type-check`, `bun test
  test/integration-ai.test.ts` and `bun run test:devenv` pass.
