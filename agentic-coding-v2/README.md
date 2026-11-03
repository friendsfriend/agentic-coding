# agentic-coding-v2

Independent Bun application built on `@earendil-works/pi-durable` 1.4.0. No imports from the previous application, workflow engine, presets, or classification stages. This is a new implementation, not a live-state migration.

## Run

```sh
bun install
bun src/cli.ts --config-dir /absolute/path/to/v2-config --state-dir /absolute/path/to/v2-state
# Or:
bun run build
bun dist/agentic-coding-v2.js --config-dir /absolute/path/to/v2-config --state-dir /absolute/path/to/v2-state
```

The host prints its loopback URL and does not open or focus a browser. The URL fragment is a local operator credential: do not share it. The browser exchanges it for an HttpOnly, SameSite session cookie. Bindings other than loopback are not supported.

Create `config.json` in the application configuration directory, separate from runtime state. The default is `~/.config/agentic-coding-v2` (respecting `XDG_CONFIG_HOME`). Override it with `--config-dir` or `AGENTIC_CODING_V2_CONFIG_DIR`:

```json
{
  "profiles": {
    "researcher": { "model": "anthropic/claude-sonnet-4-5", "thinking": "medium" },
    "coder": { "model": "anthropic/claude-sonnet-4-5", "thinking": "high" }
  },
  "orchestratorProfile": "coder",
  "repositories": ["/absolute/path/to/repository"]
}
```

Model IDs must exist in the installed pi model catalog and have configured credentials. Credentials and custom providers come from pi's agent directory (`PI_CODING_AGENT_DIR`, otherwise `~/.pi/agent`); they do not belong in this file. Profiles select model/thinking, not permissions. Restart applies the current orchestrator profile; already-admitted skill tasks retain their captured profile and inputs. Removing a repository/profile blocks new admissions, not existing work: cancel existing tasks explicitly.

When `profiles` is omitted, only `agents.profiles` and `agents.default_profile` are read from the previous app's config. Set `profileSource` to an explicit file, or use `HERDR_WORKFLOW_CONFIG`, `AGENTIC_CODING_CONFIG_DIR`, or the default `~/.config/agentic-coding/config.json`. No schedules, workflows, presets, or other live state are imported. Explicit `profiles` avoids this source entirely. Use absolute repository paths.

## System and user skills

**System skills** (`code` and `research`) are embedded as text in the application bundle. The built application does not read them from an adjacent source directory and users cannot replace them by editing a configuration file.

**User skills** live exclusively in the application configuration directory:

```text
~/.config/agentic-coding-v2/
  config.json
  skills/
    project-notes/
      SKILL.md
```

For example, `skills/project-notes/SKILL.md`:

```markdown
---
name: project-notes
description: Explain the project's notes and conventions.
---
Read the repository's notes and report the relevant conventions with file references.
```

Restart the host to discover changed user skills. Both kinds appear in the catalog and in separate sidebar lists. Duplicate names fail visibly, including user/system collisions; there is no silent override. The old arbitrary `skillDirectories` setting is rejected. Skill instructions and their content digest are captured at task admission, so later edits do not change an admitted task. Neither kind grants permissions, and scripts/resources are not copied or executed automatically.

## Interaction model

- Chat belongs to one native orchestrator conversation. The topic sidebar groups task provenance; it is not a workflow graph.
- The orchestrator selects a versioned skill, profile, repository, task text and execution policy. The native harness owns execution, recovery and cancellation. The orchestrator chooses subsequent tasks from actual results. Admission request IDs are content-bound and idempotent even when JSON field order changes or the current profile/repository configuration changes after admission.
- Each task starts in its own Git worktree at the commit captured during admission. Optional `baseRef` explicitly selects a local branch, tag or commit SHA; otherwise it uses HEAD. The resolved commit is exposed on the task/dashboard, so later ref movement does not change admitted work. Uncommitted checkout changes are not copied. To continue a prior task, choose its committed result as `baseRef`. Related task IDs are provenance only: they do not transfer a prior task's worktree or uncommitted changes. Worktrees are retained for operator inspection, not automatically deleted or merged.
- The dashboard shows task activity and Git state. It inspects native descendants: retry backoff is sleeping/idle, queued work is not marked running, and blocked native task IDs/reasons are visible instead of a misleading running indicator. Task completions enter orchestrator chat once, with the original task ID and terminal outcome; `completed` means the agent finished, not that its claims were independently verified.
- Human reviews have dedicated controls and immutable captured content. Decisions are revision-fenced and sent through the authenticated operator route. Model tools cannot approve reviews.
- `attach_image` copies PNG/JPEG content into local immutable attachments; Markdown image references are rendered as actual authenticated images. Remote tracking images and active HTML are not rendered.
- Scheduling invokes exactly one skill through the same admission path. Creating a schedule requires human approval of its exact parameters. Replaying a successful creation returns its persisted state before checking today's profiles or future timing, without resuming paused schedules or rearming expired ones. Reusing the ID for different work is rejected; JSON property order is irrelevant. Once/interval/timezone-calendar timing, overlap skipping and explicit late behavior are supported. ISO weekdays are 1–7. Calendar DST gaps advance, and folds use the earlier occurrence. Missed repeated slots are coalesced, not replayed as a burst. Invalid scheduled admissions pause that schedule with a visible error instead of starving others. The server must be running; there is no OS wake or startup service.

## Authority and safety limits

Research tasks are read-only. File tools validate workspace containment and reject escaped symlinks and Git internals. Workspace-write tasks may edit their own workspace. Automatic Git operations disable hooks, fsmonitor programs, recursive submodule updates, auto-maintenance and configured clean/smudge/process filters. This prevents a read-only inspection or automatic checkout from silently executing repository-configured programs. Filtered content (including Git LFS pointers) stays unhydrated; running a filter or fetching content requires a separately approved shell command. These defenses are not an OS sandbox against concurrent hostile host/filesystem mutation. Arbitrary shell commands are **not sandboxed**: each requires operator approval of the exact command, working directory and timeout. A persisted start marker prevents automatic command re-execution after an ambiguous interruption; the operator must inspect effects before retrying. Approval is not a guarantee of harmlessness, and path validation is not OS-level isolation against concurrent filesystem mutation.

State has one exclusive host lock. A stale lock is not automatically stolen: inspect the recorded owner before removing it. Do not share the state directory with another host, manually edit native storage, or reuse legacy storage. Shutdown closes native resources and releases this host's lock; cancellation is not a rollback of filesystem or external effects.

## Verification

```sh
bun run lint
bun run type-check
bun test
bun run build
```

The small test suite uses temporary repositories/storage and a fake model provider, including persisted restart, human approval, cancellation, scheduler accounting and authenticated image delivery. It makes no live model or credential calls. Tests focus on behavior and failure boundaries rather than helper coverage or implementation structure. An isolated real-browser smoke check also verified image decoding/delivery and that review draft text and keyboard focus survive an unrelated chat update and polling refresh.

Desloppify is installed locally in `.desloppify/venv`; its state and generated analysis are ignored. Its subjective dimensions are not yet independently assessed. No high quality score or production-readiness claim follows from a successful build or the current tests.
