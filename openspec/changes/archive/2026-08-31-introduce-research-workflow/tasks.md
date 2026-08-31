## 1. Research definition and trusted instructions

- [x] 1.1 Register `core.research` in `agentic-coding/src/workflow/definitions.ts` with a dedicated `research.md` instruction asset, researcher role routing requirements, persistent interactive capabilities, bounded blocked/failed handling, and explicit developer wiki-request/close transition contracts; add the versioned `research` manifest containing research, wiki drafting, wiki approval, and closed steps.
- [x] 1.2 Add `agent-definitions/instructions/research.md` describing runtime-neutral web research, source URLs/citation and uncertainty handling, optional read-only repository context, follow-up behavior, no implicit handoff/closure, and explicit user-request/confirmation requirements for wiki drafting.
- [x] 1.3 Update `agentic-coding/src/workflow/cli.ts` role derivation and `agentic-coding/src/workflow/runtime.ts` role lookup so `core.research` consistently maps to exactly one `researcher` run; regenerate `agentic-coding/src/workflow/embedded.generated.ts` through `bun run build` and verify the pinned instruction digest.

## 2. Start and persistence semantics

- [x] 2.1 Extend the start CLI and validation in `agentic-coding/src/workflow/cli.ts` for the `research` definition: require a non-empty task, allow `--repo` to be omitted or supplied, do not require `--mode`, OpenSpec, clean-tree, branch, or worktree checks, and retain optional repository context as read-only evidence.
- [x] 2.2 Extend `agentic-coding/src/workflow/runtime.ts` and related workflow contracts/target resolution so standalone research uses the canonical repository-independent store/data root while repository-context research records the supplied repository without creating or mutating a checkout; preserve task/context in researcher assignments.
- [x] 2.3 Add focused start tests covering standalone research, optional valid repository context, invalid repository rejection, no branch/worktree creation, empty repository metadata for standalone runs, and source-repository immutability.

## 3. Persistent interaction, wiki handoff, and explicit close

- [x] 3.1 Implement the active `core.research` prompt/session behavior across `agentic-coding/src/workflow/runtime.ts`, `agentic-coding/src/workflow/effect-runner.ts`, and assignment construction so researcher answers, runtime settlement, and missing handoff leave the workflow active and follow-ups reuse the current researcher session with complete context; the developer-only `request-research-wiki` action enters `core.wiki`.
- [x] 3.2 Add the revision-bound developer-only `close-research` action to command validation, available-action views, dashboard/action presentation, and the reducer; atomically transition from any active research/wiki/approval step to `core.closed`, expire active runs, and enqueue idempotent stop effects without requiring a final handoff.
- [x] 3.3 Add focused runtime/e2e tests for follow-up delivery, active state after answer/settlement, close while the researcher is working, close when its runtime is unavailable, stale/unauthorized close attempts, and repeated-close/duplicate-stop protection.

## 4. Researcher assignment and permissions

- [x] 4.1 Update `agentic-coding/src/workflow/assignment.ts` and `agentic-coding/src/workflow/effect-runner.ts` so researcher assignments expose the task, optional repository boundary, persistent-session expectation, runtime-neutral tool policy, explicit-close rule, and read-only source permissions while retaining the generic run-bound handoff protocol.
- [x] 4.2 Update profile preflight/routing and dashboard prompt affordances in `agentic-coding/src/workflow/profiles.ts` and `agentic-coding/src/tui/dash/` so the researcher route requires and displays persistent interactive capabilities without hard-coding a browser, MCP server, or web provider.
- [x] 4.3 Add focused assignment/routing tests proving Pi/OpenCode/OpenCode V2 receive equivalent research semantics, repository-context permissions are read-only, ordinary researcher responses do not hand off complete, and runtime/tool selection remains operator-configurable.

## 5. Wiki drafting and approval

- [x] 5.1 Extend authenticated wiki authorization in `agentic-coding/src/workflow/cli.ts` and `agentic-coding/src/workflow/wiki.ts` for the `wiki` role on an active research `core.wiki` run, reusing centralized-root pinning, update-first concept behavior, OKF draft rendering, provenance, and source-safety checks while preserving existing wiki-role/archive/human-verification restrictions.
- [x] 5.2 Implement the explicit user-request gate from research to wiki drafting through the developer-only `request-research-wiki` action, followed by the existing developer `core.wiki-approval` gate; ensure unrequested research answers do not enter wiki, drafts remain unverified, and the source repository is never modified.
- [x] 5.3 Add focused wiki and approval tests for no implicit handoff, authenticated draft create/update, canonical existing-concept selection, draft-only metadata, root/capability rejection, approval verification, and agent inability to forge human trust.

## 6. Cross-surface verification

- [x] 6.1 Update workflow help, selectable workflow/start UI, workflow views, and action tests to expose `research`, wiki drafting/approval, and `close-research` while excluding implementation, archive, delivery, and pull-request actions.
- [x] 6.2 Extend registry and specification-aligned tests for explicit research graph membership, pinning, reachable-path exclusions, researcher role assignment, and invalid graph rejection; run the focused changed workflow test files, then `bun run type-check` and `bun run build`.
