# Tasks

## 1. Server

- [ ] 1.1 Add `GET /api/v1/workflow/steps` and `POST /api/v1/workflow/blueprint/validate` to the route manifest, client and app. Verify transport tests: catalog shape, a valid and an invalid blueprint, no store written by validate.
- [ ] 1.2 Extend the start request with a `blueprint` alternative (union with `workflowType`); compile, store with origin, pin `metadata.blueprint`, and start through the existing path. Verify an end-to-end start, a both/neither 400, and a review-skipping blueprint refused before any write.
- [ ] 1.3 Allow the new routes for the orchestrator principal; keep the human-gate pin and launch limits on blueprint starts. Verify policy and transport tests.

## 2. Orchestrator

- [ ] 2.1 Add `list_steps`, `validate_blueprint` and the `blueprint` parameter of `start_workflow`; update the orchestrator prompt. Verify a faux-model host test that validates then starts a blueprint against a stub server.
- [ ] 2.2 Update `docs/orchestrator.md` and `docs/unified-backend-api.md`; run `bun run lint`, `bun run type-check` and the focused suites.
