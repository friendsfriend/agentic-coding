# OpenCode OpenSpec workflow

OpenCode agent, skill and server-plugin definitions for the OpenSpec workflow
adapted from `agentic-coding-v2`.

## Install

The canonical files live here and are symlinked into the OpenCode config:

```sh
CONFIG=~/.config/opencode
REPO=$PWD/opencode
mkdir -p "$CONFIG/agent" "$CONFIG/command" "$CONFIG/skills" "$CONFIG/plugin"
for f in "$REPO"/agent/*.md; do ln -sfn "$f" "$CONFIG/agent/$(basename "$f")"; done
for d in "$REPO"/skills/*; do ln -sfn "$d" "$CONFIG/skills/$(basename "$d")"; done
ln -sfn "$REPO/command/openspec.md" "$CONFIG/command/openspec.md"
ln -sfn "$REPO/plugin/openspec-worktree" "$CONFIG/plugin/openspec-worktree"
```

Add the nested-verification limit to `~/.config/opencode/opencode.json`:

```json
{
  "experimental": {
    "subagent_depth": 2
  }
}
```

## Entry points

- Select the **openspec** primary agent in the agent picker.
- Or run `/openspec <idea>`.
- The orchestrator loads `openspec-workflow`, explores and proposes in the
  conversation, then spawns child agents for apply, verification and archive.

Existing `/opsx-*` commands and older agent definitions are left untouched;
`/openspec` is the new entry point.

## Agents

| Agent | Mode | Model | Role |
| --- | --- | --- | --- |
| `openspec` | primary | `opencode-go/deepseek-v4.1-flash` | Orchestrator; explore/propose, worktree, delegate |
| `openspec-apply` | subagent | `opencode-go/deepseek-v4.1-flash` | Implement the change tasks |
| `verify-workflow` | subagent | `opencode-go/deepseek-v4.1-flash` | Independent review/fix/re-review coordinator |
| `openspec-verifier` | subagent | `opencode-go/deepseek-v4.1-flash` | Spec and task conformance |
| `code-quality-verifier` | subagent | `opencode-go/deepseek-v4.1-flash` | Correctness, failure paths, test quality |
| `security-verifier` | subagent | `opencode-go/deepseek-v4.1-flash` | Security and trust boundaries |
| `performance-verifier` | subagent | `opencode-go/deepseek-v4.1-flash` | Performance and resource regressions |
| `migration-verifier` | subagent | `opencode-go/deepseek-v4.1-flash` | Migration and compatibility |
| `concurrency-verifier` | subagent | `opencode-go/deepseek-v4.1-flash` | Concurrency and ordering |
| `openspec-fixer` | subagent | `opencode-go/deepseek-v4.1-flash` | Fix accepted findings only |
| `openspec-archive` | subagent | `opencode-go/deepseek-v4.1-flash` | Sync specs and archive |

Models are hardcoded in the agent frontmatter. The initial default is the
working `opencode-go/deepseek-v4.1-flash` model. The eon Claude models are
available but their current key has exhausted its budget; switch the `model:`
line when that budget is restored. There are no custom permission blocks; the
agents inherit OpenCode's default permissions.

## Worktree and session bridge

OpenCode's built-in `subagent` tool creates child sessions, but children inherit
the parent's directory. The server plugin in `plugin/openspec-worktree/` exposes
the native worktree/session APIs as tools:

- `create_worktree({ name?, branch?, from?, directory? })` → `{ directory }`
- `list_worktrees()` → saved worktrees for the current project
- `remove_worktree({ directory, force? })`
- `move_session({ sessionID?, directory })` → move the orchestrator into a worktree
- `start_agent({ agent, description, prompt, directory? | worktree? })`

`start_agent` creates a child session, moves it to the requested directory, and
prompts it. The child remains a child of the caller, so its completion is
delivered to the orchestrator. It returns immediately; do not poll.

Use **one worktree per OpenSpec change**. After exploration and before writing
proposal artifacts, call `create_worktree` and then `move_session` so the
proposal, design, tasks and spec deltas live in that worktree. Pass the same
`directory` to apply, verify, fix and archive. Create a new worktree only for an
independent workstream.

## Skills

`skills/` contains the OpenSpec workflow and verifier skills. The workflow,
verification, apply and archive skills were adapted from
`agentic-coding-v2/skills` to remove v2-only `catalog`, `start_task`,
`feature_worktree`, `request_review`, `schedule_skill`, `topicId`, `requestId`,
`profile` and `workspace` concepts. The verifier skills are copied unchanged.

## Verified

- `create_worktree`, `list_worktrees` and `remove_worktree` were exercised live
  against the native OpenCode worktree API.
- `start_agent` created a child session with `explore`, inherited the parent
  model, completed, and returned the expected answer.
- A child started with an existing worktree directory read a unique marker file
  placed only in that worktree, proving the session move.
- A nested probe spawned `explore` from a subagent at depth 2, confirming
  `experimental.subagent_depth: 2`.
- The `openspec` primary agent appeared in the agent picker and replied with the
  working `opencode-go/deepseek-v4.1-flash` model.
- `/openspec` appears in slash completion.
- `openspec-verifier` ran as a child with the working model.

A full disposable pilot also completed end-to-end:

- the orchestrator created the worktree and moved itself into it before writing
  proposal artifacts;
- it wrote `proposal.md`, `design.md`, `specs/pilot-marker/spec.md` and
  `tasks.md`, and strict validation passed;
- `openspec-apply` created `PILOT.md` with the exact expected bytes and ticked
  all five tasks;
- `verify-workflow` spawned an independent `openspec-verifier`, which returned
  CLEAN with strict validation, byte-content, task-truth and diff evidence;
- `openspec-archive` synced the delta spec and archived the change; `openspec
  validate --all --strict` passed.

The pilot worktree and temporary repository were removed afterward. Nothing was
committed or pushed.

## Limits

- The eon Claude presets exhausted their current key budget; the initial
  hardcoded default is the working `opencode-go/deepseek-v4.1-flash`. Change the
  `model:` line when the eon budget is restored.
- No custom `research` agent.
- No `catalog`, `request_review`, schedules, topic IDs, request IDs, profiles or
  workspace selector.
- No permission blocks were added. OpenCode defaults still ask for
  external-directory access and `.env` reads; changing that is a separate
  permission edit.
- The orchestrator does not push or deploy unless the developer explicitly asks.
