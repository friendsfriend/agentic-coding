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

## Environment management

Environment management is native-task-owned, not workflow-owned. **POSIX shell and explicitly configured local Docker/Podman container targets** are implemented. Container behavior has executable-fixture coverage, not live-engine integration verification. Compose, Kubernetes, infrastructure dependencies, endpoint discovery and database/telemetry tools are **not migrated yet**. The [environment parity ledger](docs/environment-parity.md) tracks remaining capabilities without claiming full parity. Definitions, leases, containers and processes from the previous host are never automatically imported or adopted.

Create `CONFIG_DIR/environments.json` (restart to discover definition changes):

```json
{
  "version": 1,
  "projects": [
    {
      "id": "web",
      "kind": "app",
      "repository": "/absolute/path/to/repository",
      "targets": [
        {
          "id": "serve",
          "action": "run",
          "runtime": "shell",
          "command": "bun run dev",
          "readyText": "Listening on",
          "timeoutMs": 30000,
          "environment": { "NODE_ENV": "development" },
          "secretRefs": { "DATABASE_URL": "WEB_DATABASE_URL" }
        },
        {
          "id": "build",
          "action": "build",
          "runtime": "shell",
          "command": "bun run build",
          "timeoutMs": 600000
        },
        {
          "id": "test",
          "action": "test",
          "runtime": "shell",
          "command": "bun test",
          "timeoutMs": 600000
        }
      ]
    }
  ]
}
```

Repositories must already be explicitly authorized in `config.json`. IDs are lowercase kebab-case and unique within their scope. A library uses `"kind": "library"` and cannot have run targets. Only the documented fields are accepted; unsupported runtimes and unknown fields fail visibly instead of being silently ignored.

Optional target `profile` defaults to `default`; `label` is a human-readable explicit selection alias. A project's `defaults` can name target IDs for `run`, `build` and `test`, including a non-default profile. Tools accept `target`, `profile` and `runtime`; explicit profile/provider choices can override a default. One resolver supplies tool selection and dashboard default reasons. Without a declaration, default-profile run selection prefers Docker, then Podman, then the Compose adapter, then shell; multiple same-runtime candidates and ambiguous build/test choices require an explicit selection. Kubernetes will require explicit opt-in rather than becoming an implicit fallback.

Catalogs expose conservative `availability` metadata: POSIX support, executable access and configured Unix-socket file/access checks. They do **not** invoke clients, connect to daemons, resolve secret references or establish startup health. Known-unavailable targets are excluded from implicit fallback; a missing declared default fails instead of silently choosing a replacement. Relative PATHs and secret-backed PATHs remain unverified until approved execution. Tools and dashboard defaults use the same eligibility results.

`cwd` defaults to `.` and must resolve inside the owning task's worktree, including a containment recheck immediately before spawn. All selected apps must belong to that task's repository. Dependencies and uncommitted source-checkout files are not copied into worktrees: configure an appropriate, separately approved install/build target if needed.

Literal `environment` values are public configuration and appear in catalog/review snapshots. **Do not put credentials there.** `secretRefs` maps child environment names to variables in `CONFIG_DIR/.env` (a dotenv data file, not executable shell); an explicitly referenced host environment variable is the fallback. Protect that file with user-only permissions. Missing references fail before acquiring or starting any app. Values are resolved after approval and are never placed in execution receipts or review snapshots. Only `PATH`, `HOME`, `LANG`, `TMPDIR`, `TERM`, the configured literals/references, and `WORKSPACE`/`CONFIG_DIR` are passed—not the host's whole environment. This is not a filesystem or credential sandbox: approved programs still run with the host user's OS authority.

Available tools:

- `env_list`, `env_status`, `env_logs`: inspect definitions, owners, queues, readiness, exit receipts and logs. A skill reads only its own logs; the home orchestrator and authenticated operator can inspect all host runs.
- `env_start`: human approval for the exact command/cwd/variable-reference plan, then atomic reservation of the entire requested app batch. If a target is ambiguous, select its ID explicitly. Conflicting batches retain FIFO priority while unrelated apps can proceed; explicitly shared container names and published ports also count as conflicts. It waits inside the tool without model polling. `timeoutSec` defaults to 30 (maximum 7200); timeout/cancellation removes the queue entry and does not start anything. Acquire all required apps together; stop an existing batch before acquiring more, avoiding hold-and-wait deadlocks.
- `env_build`, `env_test`: separately approved commands in the task's worktree, with actual exit codes and redacted output. They require no app slot, but concurrent build/test actions in the same workspace are refused. Container builds conservatively serialize all image writers on the same local API socket, across workspaces and client families: Docker-compatible endpoints and Podman short-name policy make client-side tag identity unsafe to guess. An interrupted writer keeps that daemon's image-write resource quarantined. Nonzero exit codes remain failures reported as data, not invented successful verification.
- `env_stop`: live process-group or ownership-fenced container cleanup for this task's own selected apps and pending acquisitions. It cannot stop another owner. Durable stop receipts bind retries to the original selection, not newly started apps.

### Structured local container targets

A Docker or Podman target uses `container`, not a shell `command` or `readyText`:

```json
{
  "id": "container",
  "action": "run",
  "runtime": "docker",
  "timeoutMs": 30000,
  "container": {
    "socket": "/var/run/docker.sock",
    "image": "example/web:local",
    "name": "acv2-web",
    "command": ["serve"],
    "ports": [{ "host": 8080, "container": 8080 }],
    "mounts": [{ "source": ".", "target": "/workspace", "readOnly": true }],
    "readiness": "running"
  },
  "environment": { "NODE_ENV": "development" },
  "secretRefs": { "SERVICE_TOKEN": "WEB_SERVICE_TOKEN" }
}
```

The executable is `docker` or `podman` on the approved process PATH. **An absolute local Unix API socket is mandatory.** No default Docker context, implicit Podman connection or remote daemon is selected. Configure the actual socket for your installation; the example is not auto-discovery. This adapter currently requires POSIX. The client still has the host user's OS authority and may use their client configuration/credential helpers; it is not a daemon-permission or credential sandbox.

`name` is optional (a deterministic app/host-specific name is generated otherwise). Any existing container with that name refuses startup, including apparently matching ownership labels: there is no adoption. Created resources carry host/run labels. Every subsequent lifecycle operation checks both labels **and the exact ID returned by this live creation**, never a saved name/PID or matching labels alone as authority. An invalid/lost creation receipt quarantines the effect rather than adopting an inspected resource. Foreign/replaced resources are not removed. Daemon/observation failures are **unknown**, never absence. Interrupted/failed mutating client calls quarantine the native resource even if later cleanup appears successful, because loss of a client is not proof of remote cancellation.

Ports default to TCP on `127.0.0.1`; an explicit IP `address` and `udp` protocol are supported. Mount `source` is workspace-relative and containment is rechecked before execution; mounts are read-only unless explicitly opted out. All explicitly declared literal/reference variable names are forwarded with `--env NAME`; secret values are not command-line arguments. `entrypoint` can override the image entrypoint. `readiness: "running"` requires observed running state; `"healthy"` requires an actual engine health status of healthy, not a guessed successful probe. The host monitors exit/observation failure and reports current health separately from startup readiness. Runtime status is a last observation, not a continuous availability guarantee.

For `action: "build"`, `container.image` is the local tag, `dockerfile` defaults to `Dockerfile` and `context` defaults to `.` (both workspace-relative). Optional `buildArgs` names declared variables passed by name rather than interpolated into argv. Builds never push. Image layers/cache and successful image tags persist as build artifacts, not running-app leases. Do not treat Docker build arguments as confidential image storage: a Dockerfile can embed or print values. For `action: "test"`, a labelled disposable container is started, its actual engine wait exit code is returned, and removal must be confirmed before its workspace action lock is released. Live log clients are cleaned up independently of daemon availability. Machine-readable inspection stdout is private and bounded to 1 MiB; inspection stderr is private too. Neither is included in model logs, even for a foreign container whose environment contains otherwise unknown credentials. Public failures use bounded, generic diagnostics rather than echoing private parser/API error content.

### Compose file adapter (limited subset)

A run target can select `"runtime": "compose"` and `"compose": { "file": "deploy/compose.yaml", "provider": "docker", "socket": "/var/run/docker.sock" }` (or an explicit `podman` provider). It must not also declare `container`, `command` or `readyText`. Files come from the task checkout, not the source checkout or host Compose configuration. The approved plan pins the file content digest and compiled services; a changed file refuses execution before invoking an engine.

**This is not full Compose compatibility.** It compiles services to the receipt-fenced adapter rather than calling `compose up/down`. Docker-provider targets default to `"network": "shared"`: an exclusive host/app-specific bridge network is created with its own immutable-ID receipt, and each service joins that exact network ID with its service-name alias. Separate stacks do not share DNS. Existing networks are never adopted, even with matching labels. Network inspection stdout/stderr are private and bounded.

An explicit `"network": "isolated"` skips shared networking and service-name DNS; this difference appears in the approval plan. The Podman **client** provider currently requires this isolated opt-in: shared targets are metadata-ineligible, because the supported Podman network-create CLI contract does not supply the immutable creation receipt this adapter requires. It does not silently substitute a Docker client or invent ownership from a name/labels. This restriction is about the selected client contract, not a claim that every Docker-compatible backend is Docker.

The file must contain only `services` (1–16). Each service supports `image`, argv-array `command`, string `entrypoint`, public string-literal `environment`, long-form `ports` (`target`, integer `published`, optional `host_ip`/`protocol`) and long-form bind `volumes` (`type: bind`, `source`, `target`, optional `read_only`, default true). Bind sources resolve relative to the Compose file, remain inside the task workspace and are rechecked before creation. Every service also receives the target environment and secret references; literals cannot override secret references. `depends_on` supports the short array syntax (`service_started`) or explicit `service_started`/`service_healthy` conditions. Prerequisites start first; healthy dependencies require actual engine image-health observations, not synthesized readiness. Cycles, missing services, completion/restart dependency conditions and healthcheck overrides are refused. Interpolation, user-defined/external networks, named/external volumes, privileges, builds, includes/extends and unknown fields are rejected, not silently ignored. Images must already be available on the configured engine.

Startup uses one bounded deadline for the stack. Service names are host/app-specific; every creation has its own live immutable-ID receipt and ownership labels. Partial startup rolls back only live-created services in reverse order, never foreign services. The shared network is removed last, by its live ID only after identity/labels are verified and no attachments remain. Foreign attachments are never force-disconnected; copied-label replacement, a lost creation receipt, daemon loss or uncertain cleanup quarantines the entire stack and its published-port reservations. Status/dashboard expose service observations and diagnostic IDs separately; saved IDs cannot grant restart adoption or cleanup authority.

### Lifecycle, recovery and logs

Run `timeoutMs` is a startup/readiness deadline (default 30 seconds), not a service lifetime. `readyText`, when supplied, must appear in the raw decoded stream before startup completes; markers may cross chunks or omit a newline. This uses a bounded private tail, separate from redacted, line-buffered presentation: a redaction placeholder cannot invent readiness, and partial log lines are still withheld. Without it, readiness is explicitly **not checked**; it is not an HTTP health check. Build/test `timeoutMs` bounds execution (default ten minutes). Both accept 100–3,600,000 ms. Startup failure stops the rest of that batch without taking over another task's resources.

Task completion, cancellation and graceful host shutdown stop owned live process groups or ownership-checked container resources before releasing their slots. TERM escalates to KILL; unconfirmed cleanup is quarantined rather than reported as stopped. Skill results/cancellation reasons include an operator-inspection warning when resources remain quarantined. Programs that detach into other sessions or gain privileges can escape ordinary process-group cleanup: this is **not an OS sandbox**. Cancellation does not roll back filesystem, network or external effects.

After an unclean host interruption, reserved/running/stopping receipts become **interrupted** and continue to hold their app/workspace resource. Nothing is re-executed, adopted or killed using a saved PID, container ID or ownership label. Inspect and stop leftovers yourself, then use **Release after inspection** in the authenticated dashboard. This confirmation is revision-fenced, executes no command, and leaves unknown exit status unknown. Cancelling an ended/interrupted task does not silently clear its quarantine. Retrying work requires a fresh approved invocation.

Logs retain at most 64,000 characters per execution; complete known secret values (including values split across stream chunks) are redacted before storage/display. Unterminated lines are withheld while running; oversize lines are omitted. This is best-effort literal redaction, not protection against a malicious command deliberately encoding or exfiltrating a secret. In-progress logs are live memory; startup and exit snapshots are durable, so a crash can lose later log lines. Tool responses are capped at 40,000 characters. Active/quarantined runs remain visible regardless of history limits. The environment dashboard exposes target IDs, owners, queue state, startup readiness, real exit status and redacted logs.

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

The small test suite uses temporary repositories/storage and a fake model provider, including persisted restart, human approval, cancellation, scheduler accounting and authenticated image delivery. Environment scenarios launch only isolated fixture processes: they verify atomic app contention/handoff, owner fencing, cleanup, build/test exit codes, secret redaction, readiness timeout, and real crash/quarantine recovery without saved-PID takeover. Container scenarios substitute isolated executable Docker/Podman clients and an in-test Unix-socket engine (no actual daemon or credentials): they verify native approval/provider/profile selection, real argv/process I/O, private metadata handling, build/test receipts, foreign-stop refusal, changed-ownership/copied-label replacement refusal, missing/unhealthy readiness, daemon-loss quarantine and cleanup. Fixture success does not establish compatibility with a live Docker or Podman installation. It makes no live model or credential calls. Tests focus on behavior and failure boundaries rather than helper coverage or implementation structure. Isolated real-browser smoke checks also verified image decoding/delivery, environment log redaction and retention across polling, and that review draft text and keyboard focus survive an unrelated chat update and polling refresh.

Desloppify is installed locally in `.desloppify/venv`; its state and generated analysis are ignored. Its subjective dimensions are not yet independently assessed. No high quality score or production-readiness claim follows from a successful build or the current tests.
