# Tasks

## 1. Reproduce

- [x] 1.1 A fixture that mirrors the live configuration: `apps/build/<app>-build.Dockerfile`
      as a symlink into a stand-in for `~/devenv-config`, the promoted
      `apps/build/<app>-build.sh`, a compose run target, a stub `docker` that
      records its argv and the promoted script appending to the same record.
- [x] 1.2 Assert the agent tool resolver, the Environments UI/TUI build action
      and the smoke check resolve the **same** target id, and that it is the one
      the gate validated — and that with no declaration none of them guesses.
- [x] 1.3 A fixture that mirrors the already-promoted backend layout and shows
      the shell target as the UI default after the promotion.

## 2. One resolver

- [x] 2.1 `src/server/actions/default-target.ts`: declaration reading, family
      grouping, preference order, ambiguity reporting, live resolution and the
      gate/live parity comparison.
- [x] 2.2 The agent build/test resolver (`agentTarget`) resolves through it.
- [x] 2.3 `env_list` marks `default`/`defaultTargetId`/`defaultReason`, or
      `defaultAmbiguous` with the candidates.
- [x] 2.4 `GET /api/apps/{ident}/actions` marks the authoritative default on the
      definitions it returns, and the UI's build/test/run action runs it, refuses
      an unavailable default, and never preselects a picker entry.

## 3. Declaration, diff and rollback

- [x] 3.1 `apps/defaults/` is a draftable configuration path, validated by the
      gate (it must name an existing target) and promoted/backed up/rolled back
      like any definition file.
- [x] 3.2 The approval diff prints `# default build for <app> = "<target>"
      (was ambiguous: docker, shell)`, and the approval summary names how each
      default was decided.
- [x] 3.3 Tests: the notice, an unusable declaration failing the gate, a
      promotion publishing the declaration (linked Dockerfile untouched), a
      rollback removing exactly what it added, and an existing declaration being
      backed up and restored.

## 4. The gate and the smoke check close the loop

- [x] 4.1 The gate resolves the staged defaults (declaration first, superseding
      draft reported) and runs the build, start and test it resolved.
- [x] 4.2 The gate's resolved defaults are recorded in the run's snapshot and
      travel in the env-setup subject.
- [x] 4.3 The smoke check resolves the live defaults through the same rule,
      fails on drift with the rollback offer, starts and rebuilds the resolved
      ids, and names the target it did not rebuild.
- [x] 4.4 Test: a live default that is not the validated one fails the smoke
      check without starting anything and keeps the staged state.

## 5. Author instruction and docs

- [x] 5.1 `agent-definitions/instructions/env-setup.md`: declare the default
      whenever a drafted target coexists with a live target of another family,
      with the accepted forms and what happens without one.
- [x] 5.2 Docs: `docs/agent-environments.md` (the gate, the approval diff and the
      smoke check) and `docs/config-inventory.md` (`apps/defaults/<app>.json`).
- [x] 5.3 Specs: this change's deltas for `bun-environment-action-engine`,
      `agent-environment-tools` and `environment-setup-workflow`.

## 6. Build context preparation

- [x] 6.1 The preparation step exists only when the configuration has a
      `templates/` directory, fails loudly instead of `2>/dev/null; true`, and
      removes exactly what it copied.
- [x] 6.2 Tests: no step without templates; a copy that uses them, cleans them
      up, and does not report success when the copy fails.
