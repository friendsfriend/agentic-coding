## Why

Current workflows require OpenSpec artifacts (proposal, design, tasks, spec scenarios) even for trivial fixes. The `direct-apply` workflow skips planning but still expects pre-authored OpenSpec artifacts. Small fixes — a typo, a CSS tweak, a config value — don't need specification overhead.

The archive module bundles three concerns: spec sync, git commit/push, and final cleanup. Git operations can't run independently after developer review. Splitting archive lets each run at the right time.

## What Changes

### 1. No-openspec workflow type

New workflow type for fixes that skip OpenSpec entirely:

- **Modules**: `apply-verify → developer-approval → git-operations → archive`
- No `proposal.md`, `design.md`, `tasks.md`, or spec scenarios required
- Worker receives the user's request description directly (no OpenSpec artifacts to read)
- No plan quality gate exists (no plan module)
- No task completion check guards verification
- Verification is user-triggered (`herdr-workflow verify`) — same as today, but without reading `tasks.md`
- After developer approval, runs git operations then archive

### 2. Archive module split (all workflow types)

Current single `archive` module does validation/spec-sync + git operations + cleanup. It becomes two modules:

| Module | Entry | Exit | Roles | Gate | Phases |
|---|---|---|---|---|---|
| git-operations | committing | archive | git | — | committing |
| archive (simplified) | archive | completed | archive | — | archive |

`git-operations` stages implementation changes (plus OpenSpec spec sync for standard/direct-apply), commits, and pushes. `archive` closes panes, finalizes the OTel trace, and closes the Herdr workspace.

Updated `WORKFLOW_TYPES`:
- **standard**: `plan → plan-approval → apply-verify → developer-approval → git-operations → archive`
- **direct-apply**: `apply-verify → developer-approval → git-operations → archive`
- **no-openspec**: `apply-verify → developer-approval → git-operations → archive`

### 3. New `git` role agent

Handles commit and push. Mirrors the current archive agent's git steps but skips OpenSpec spec sync. For standard/direct-apply, the git agent additionally does spec sync before staging.

### 4. Worker prompt variant

No-openspec worker gets a prompt based on `request.md` instead of OpenSpec task tracking. The `role_prompt` function dispatches on workflow type.

### 5. Dashboard shows workflow type

`workflowType` field stored explicitly in state. Dashboard infers display string from it instead of guessing from module list shape.

## What stays

- The apply-verify internal loop (apply → verify → fix → paused → verify) is unchanged
- Dashboard approval gates at developer-approval module are unchanged
- Override-phase, recovery, close commands are unchanged
- Standard and direct-apply workflows produce identical behavior (archive split is internal)

## Impact

- `pi/bin/herdr-workflow`: WORKFLOW_MODULES adds `git-operations`, WORKFLOW_TYPES adds `no-openspec`, new `cmd_git_operations`, worker prompt branching, `state` gains `workflowType`
- `agent-definitions/skills/herdr-openspec-git/SKILL.md`: new skill for commit/push
- `agent-definitions/skills/herdr-openspec-archive/SKILL.md`: simplified (remove git steps)
- `agent-dash/src/`: `NewWorkflowModal` adds no-openspec type; `App.tsx`/`Home.tsx` display type explicitly
- Backward compatible: existing workflows keep original module list in state
