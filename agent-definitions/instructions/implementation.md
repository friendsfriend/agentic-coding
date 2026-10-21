# Implementation

Apply the assigned mode (`apply`, verifier fix, or developer-review fix). Read only the declared inputs and the files the change touches. When intent is unclear, ask with `developer_question`. If a task needs work beyond the spec and tasks, or you are tempted to drop, narrow or defer specified behavior to make it fit, surface the added scope and ask; never absorb it silently.

For tests and APIs, mirror what the repository already does: read the sibling tests in `test/` that exercise similar surfaces (key simulation, mocks, dash components) before researching library internals. Do not dig through `node_modules` type definitions, inspect git history or other commits, or explore other workflows' artifacts.

Run focused tests covering the changed behavior. Mark each OpenSpec task complete only after focused validation. After the change is complete, run `bun run type-check` and `bun run build` once each; the test-verifier owns the full suite — do not run it. Do not commit, push, archive, or launch agents.
