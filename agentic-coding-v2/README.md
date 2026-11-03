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

Environment management is native-task-owned, not workflow-owned. **POSIX shell and explicitly configured local Docker/Podman container targets** are implemented. Container behavior has executable-fixture coverage, not live-engine integration verification. A strict Compose subset and explicitly approved local Kubernetes API identity inspection are also implemented. An initial Kubernetes bare-pod run adapter is implemented for explicitly selected existing local contexts/namespaces. Helm, infrastructure dependencies, endpoint discovery and database/telemetry tools are **not migrated yet**. The [environment parity ledger](docs/environment-parity.md) tracks remaining capabilities without claiming full parity. Definitions, leases, containers and processes from the previous host are never automatically imported or adopted.

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
          "secretRefs": { "DATABASE_URL": "WEB_DATABASE_URL" },
          "endpoints": { "web": "http://127.0.0.1:3000" }
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

Optional target `profile` defaults to `default`; `label` is a human-readable explicit selection alias. A project's `defaults` can name target IDs for `run`, `build` and `test`, including a non-default profile. Tools accept `target`, `profile` and `runtime`; explicit profile/provider choices can override a default. One resolver supplies tool selection and dashboard default reasons. Without a declaration, default-profile run selection prefers Docker, then Podman, then the Compose adapter, then shell; multiple same-runtime candidates and ambiguous build/test choices require an explicit selection. Kubernetes requires explicit `runtime: "kubernetes"` or a named Kubernetes target; it never becomes an implicit fallback.

Catalogs expose conservative `availability` metadata: POSIX support, executable access and configured Unix-socket file/access checks. They do **not** invoke clients, connect to daemons, resolve secret references or establish startup health. Known-unavailable targets are excluded from implicit fallback; a missing declared default fails instead of silently choosing a replacement. Relative PATHs and secret-backed PATHs remain unverified until approved execution. Tools and dashboard defaults use the same eligibility results.

`cwd` defaults to `.` and must resolve inside the owning task's worktree, including a containment recheck immediately before spawn. All selected apps must belong to that task's repository. Dependencies and uncommitted source-checkout files are not copied into worktrees: configure an appropriate, separately approved install/build target if needed.

Literal `environment` values are public configuration and appear in catalog/review snapshots. **Do not put credentials there.** `secretRefs` maps child environment names to variables in `CONFIG_DIR/.env` (a dotenv data file, not executable shell); an explicitly referenced host environment variable is the fallback. Protect that file with user-only permissions. Missing references fail before acquiring or starting any app. Values are resolved after approval and are never placed in execution receipts or review snapshots. Only `PATH`, `HOME`, `LANG`, `TMPDIR`, `TERM`, the configured literals/references, and `WORKSPACE`/`CONFIG_DIR` are passed—not the host's whole environment. This is not a filesystem or credential sandbox: approved programs still run with the host user's OS authority.

Available tools:

- `env_list`, `env_status`, `env_logs`: inspect definitions, owners, queues, readiness, exit receipts and logs. A skill reads only its own logs; the home orchestrator and authenticated operator can inspect all host runs.
- `env_logs({app?, infra?, grep?, tail?, service?})`: a compact run-framed log view, not full execution plans. It selects already-redacted retained lines using **literal** substring matching (not regex), then the newest matching lines per run (`tail` defaults to 200, range 1–1000; `grep` is at most 512 characters). At most 20 recent/live runs share a 12 KiB JSON-encoded output budget, newest/live runs first. Whole lines that cannot fit are omitted, never cut mid-line; per-run matched/selected/returned/omitted counts and tail/window flags distinguish budget loss from no matches. When a 64k-character retained buffer may start inside an old line, that first boundary line is conservatively withheld. Counts describe only the retained redacted window, never total historical logs. Selection makes no additional CLI/runtime or log-backend calls and has no execution effects. Runtime buffer order is not event-time ordering; Compose remains aggregate service buffers without a chronological merge, and Kubernetes exposes only client diagnostics, **not Pod logs**. Optional `service` selects an **exact declared Compose service**, before grep/tail, from a structured child buffer—not from parsing user-controlled `[service]` header text. Stack-network diagnostics are excluded; a selected child buffer can still contain that child's container-client diagnostics alongside retained application lines. Per-run `sourceAvailability` reports `available`, `not-declared`, `not-captured` (including older receipts without a snapshot), or `unsupported-runtime`; unavailable sources return no lines and never silently fall back to aggregate logs. New per-service snapshots share a separate 64k-character capture window per stack, divided equally among its declared services; clipped leading boundary lines are withheld and `sourceTruncated` reports capture-window loss, not historical completeness. Already-redacted snapshots survive normal owned cleanup; a host crash can still lose subsequent in-memory output. They are diagnostic data, never restart/adoption authority. A disposable Compose scenario verifies service isolation despite spoofed header lines, native-tool selection and retained output after cancellation cleanup; a shell scenario verifies unsupported filtering cannot expose aggregate output. Choose exactly one `app` or `infra` ID. `infra` selects only the immutable infrastructure kind captured in the execution plan, never ordinary app history relabelled by current configuration. The same task-owner scope and redaction apply. Timestamp filtering and Kubernetes Pod logs remain pending. A native functional scenario verifies literal filtering, matching-line tails, secret redaction, another task's logs staying hidden and complete-line omission of an over-budget Unicode line. The authenticated dashboard's existing raw bounded-buffer view is unchanged.
- `env_start`: human approval for the exact command/cwd/variable-reference plan, then atomic reservation of the entire requested app batch. If a target is ambiguous, select its ID explicitly. Conflicting batches retain FIFO priority while unrelated apps can proceed; explicitly shared container names and published ports also count as conflicts. It waits inside the tool without model polling. `timeoutSec` defaults to 30 (maximum 7200); timeout/cancellation removes the queue entry and does not start anything. Acquire all required apps together; stop an existing batch before acquiring more, avoiding hold-and-wait deadlocks.
- `env_build`, `env_test`: separately approved commands in the task's worktree, with actual exit codes and redacted output. They require no app slot, but concurrent build/test actions in the same workspace are refused. Container builds conservatively serialize all image writers on the same local API socket, across workspaces and client families: Docker-compatible endpoints and Podman short-name policy make client-side tag identity unsafe to guess. An interrupted writer keeps that daemon's image-write resource quarantined. Nonzero exit codes remain failures reported as data, not invented successful verification.
- `env_http_get`: separately approved GET to one named local endpoint of this task's live ready shell app. No other owner's app or saved receipt grants network authority. See the limited endpoint contract below.
- `env_stop`: live process-group or ownership-fenced container cleanup for this task's own selected apps and pending acquisitions. It cannot stop another owner. Durable stop receipts bind retries to the original selection, not newly started apps.

### Initial task-owned infrastructure

Projects may declare `"kind":"infrastructure"` in `environments.json`. These are **exclusive task-owned run resources**, using the same authorized repository/workspace, runtime selection, readiness observations, immutable approval, atomic batch reservation and live-receipt cleanup as apps. Infrastructure definitions are run-only: no implicit image build or database-query authority. Their identity is captured as `projectKind` in new execution plans; old receipts are not reclassified from today's catalog.

Explicitly acquire all needed resources together, for example `env_start({apps:["store","api"]})`, and read retained infrastructure output with `env_logs({infra:"store"})`. Capture/response bounds and unavailable-runtime behavior are unchanged. A native scenario verifies approval before reservation, one mixed app/infrastructure batch, redacted kind-scoped logs and cancellation cleanup. There is **no automatic dependency expansion, sharing, external-service adoption or reference counting yet**; do not treat these exclusive resources as shared services. Fixture verification is not a live infrastructure compatibility claim.

### Kubernetes crash/reopen verification

A disposable native-host SIGKILL/reopen scenario verifies that saved Pod UIDs remain diagnostic-only with unknown ownership/health. Reopen, refused saved-receipt stop, cancellation and inspected release issue no fixture-client commands; occupancy remains quarantined until authenticated revision-bound operator confirmation. The fixture operator removes only the owned synthetic UID and preserves an unrelated Pod. This tests the native no-adoption boundary, not live Kubernetes crash/recovery compatibility or actual cluster absence verification. No runtime behavior or cleanup authority was added by this verification increment.

### Initial local endpoint diagnostics

Shell **run** targets may declare up to 16 `endpoints` as name → HTTP/HTTPS numeric-loopback URL (`127.0.0.1` or `[::1]`, no DNS, credentials, configured query or fragment). IDs use the same lowercase kebab-case convention. Set the declared port to the actual application's listening port; this declaration is not discovery, allocation or proof that the process owns a socket. HTTP is unencrypted; an actual HTTPS GET verifies its peer certificate and numeric IP, but does not prove which process owns the socket. Declared TCP ports participate in native app-batch admission conflicts, including container-published ports and wildcard bindings. External processes are not adopted or reserved against.

Usable `endpoints` are exported in run results/status only while the live shell app is ready and held; configuration/review snapshots can still show the static declaration before startup. A missing `readyText` establishes only shell startup, not application health. On stop, owner cancellation, exit or host reopen, usable endpoints disappear and requests fail closed. Container/Compose/Kubernetes address binding, automatic ports and Kubernetes forwards are **not implemented**.

HTTPS uses TLS 1.2+ with normal certificate and IP-SAN verification. Without an override it uses the runtime's system trust. An optional **operator-configured** target map `"endpointCaRefs": { "secure": "certificates/local-root.pem" }` supplies a public CA for a declared HTTPS endpoint named `secure`, replacing system trust for that request only. The tool cannot select a CA or hostname override. The reference must stay inside `CONFIG_DIR` after canonical containment checks. Only one regular, at-most-64-KiB PEM public CA certificate is supported; private keys, client certificates and bundles are refused. Its exact source digest joins the immutable GET approval and is rechecked before sending; changing even whitespace requires fresh approval. Certificate bytes and keys are not returned to the model. There is no insecure-TLS option, client-key loading or authentication grant.

`env_http_get({app, endpoint, path?})` requires a workspace-write native task and exact separate human approval, including the current run ID and normalized URL. Paths append to the configured path prefix; the **origin**, not that prefix, is the scope boundary. The client never follows redirects and sends no cookies, credentials or custom headers; it connects directly without an ambient proxy. Only GET is supported, and **GET can still have server-side effects**. There is no generic write or authentication capability.

A request has a ten-second total deadline, a 16 KiB HTTP-header limit and a 64 KiB source-body cap. Only UTF-8-decoded text/JSON/XML is returned; other or encoded bodies are omitted without decompression. Returned headers are restricted to content type/length/location. Literal known app secrets are redacted using the app's original startup redactor, even if `.env` changes later; this is not protection against arbitrary secret transformations or encodings. At a source-body truncation, the incomplete final line is withheld so a secret split by the cap is not returned as a prefix. Redacted output is bounded again for model delivery. Reported `bytes` counts captured source bytes, not an invented total response size.

Ownership is checked before approval, immediately before sending, and before returning observations. A response is discarded if the run closes, becomes uncertain or is replaced. In-flight requests join the native run's cleanup barrier; cancellation interrupts the request. This is capability-bounded diagnostics, not an OS/socket-identity sandbox.

The HTTP functional test launches its own disposable app through the real native shell boundary: no request before approval or without a held app, a conflicting app's declared port never starts, frozen-secret redaction after dotenv rotation, a source cap bisecting a secret, no redirect follow, and cancelled in-flight request cleanup. A separate HTTPS scenario generates disposable test certificates with `openssl` (a test dependency), serves its own TLS app, rejects implicit trust of a self-signed peer and a trusted certificate for the wrong IP, succeeds with the configured matching CA, then changes the approved CA source and verifies no further GET reaches the server. These fixtures do not establish hosted/live-system parity. No existing app, credential, trust store or hosted service is used or modified.

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

## Explicit local Kubernetes status

`env_cluster_status({"cluster":"local"})` asks for human approval before querying the API identity of an explicitly configured local context. It reports `api-reachable` and the `kube-system` namespace UID, **not** workload health or permission to adopt/delete anything. `env_list` lists configured cluster IDs with `probe: "not-performed"`; listing does not invoke kubectl.

Optional `$CONFIG_DIR/clusters.json`:

```json
{
  "version": 1,
  "clusters": [{
    "id": "local",
    "repository": "/absolute/authorized/repository",
    "kubeconfig": "clusters/local.yaml",
    "context": "explicit-local-context"
  }]
}
```

The status operation is deliberately read-only. The kubeconfig must be config-contained and name the explicit context. Its selected server must use HTTPS on numeric loopback (`127.0.0.1` or `::1`). Only certificate/key or `tokenFile` references to files within the config directory are supported; inline credentials, exec/auth plugins, insecure TLS, proxies and remote/default contexts are not. Existing ordinary kind configs with inline credentials are therefore not supported yet. No real credentials or clusters were used to verify this increment.

The approved source digest is checked again before the CLI runs. Kubectl receives an isolated minimal client file containing only the selected connection and public credential **file references**, never copied credential values. Machine stdout/stderr stay private; only the validated API identity summary reaches the model. The client file is removed after confirmed local process cleanup. Conventional client environment variables are allowlisted; optional explicit `environment` mappings are shown in the approval, with kubeconfig/proxy overrides forbidden. The client is not an OS sandbox. This command never creates a cluster, installs an app, adopts resources or grants cleanup authority. Helm, port forwards and cluster creation/deletion remain pending. The separate bare-pod run adapter below has its own effect approval.

### Task-owned bare pods

A run target can now select Kubernetes explicitly:

```json
{
  "id": "pods",
  "action": "run",
  "runtime": "kubernetes",
  "timeoutMs": 30000,
  "kubernetes": {
    "cluster": "local",
    "namespace": "development",
    "image": "your-app:version",
    "command": ["/app/server"],
    "args": [],
    "replicas": 1,
    "readinessProbe": {
      "httpGet": { "path": "/ready", "port": 8080 },
      "periodSeconds": 2,
      "timeoutSeconds": 1,
      "failureThreshold": 3
    }
  }
}
```

The namespace must already exist and cannot be `default` or `kube-*`. No namespaces, clusters, Helm releases, controllers, mounts, services or port forwards are created. Call `env_start` with `runtime: "kubernetes"`; optionally override `replicas` (1–16) for a problem that actually needs multiple replicas. The app slot, atomic batch acquisition, exact native review, cancellation and restart quarantine rules are unchanged. The configured local connection and kubeconfig digest are part of the approval.

Only successful creation responses establish live pod UID receipts. Existing names are never adopted, even with matching labels. Cleanup verifies those UIDs and host/run labels, then sends Kubernetes DELETE requests with **UID and observed resource-version preconditions**, a five-second grace period and orphan propagation. Deletions are requested before waiting for absence so replica grace periods overlap. It never uses an unchecked name-based `kubectl delete` or deletes a namespace. Replacements, unconfirmed cleanup, interrupted writes and lost ownership retain the app reservation for authenticated inspection. Resource-version conflicts also fail closed rather than retrying an ambiguous mutation. Persisted pod IDs are diagnostics, not restart adoption authority.

Readiness requires observed `Running` phase and Kubernetes `Ready=True`. Optional `readinessProbe` supports exactly one `httpGet` (pod-relative `path`, numeric `port`, optional `HTTP`/`HTTPS` `scheme`) or `tcpSocket` (numeric `port`). Exec/gRPC probes, host overrides, custom headers, named ports and liveness/startup probes are refused. Timings are bounded: initial delay 0–300 seconds, period 1–60, timeout 1–30 (not exceeding the period), and success/failure thresholds 1–10. Defaults are the Kubernetes defaults (0/10/1/1/3 respectively). The target timeout must also allow for scheduling, image pulls and these checks.

Every replica is created before waiting for readiness, so peers can start even when readiness depends on each other. Probes execute in the kubelet, not the host. Kubernetes HTTP redirect semantics apply; HTTPS probes do **not** verify server certificates, and TCP probes establish only that the socket accepts a connection. Without a probe, Pod Ready is **not proof of application health**; even a passing configured probe does not establish end-to-end business correctness. Public per-pod `readiness` metadata distinguishes `http-probe`, `tcp-probe` and `pod-ready`. After initial readiness, observed readiness loss is `unhealthy` rather than `starting`; it does not automatically destroy the app. Termination and UID ownership are monitored. Exit codes are reported only when observed; confirmed cleanup does not invent an application success code. Pod logs are deliberately unavailable until a read boundary can avoid name-replacement races. Shell/container logs are unaffected.

Target `environment`/`secretRefs` become only explicitly declared Pod environment values, not the client host environment. **The API can persist these values and authorized cluster readers can read them. This is not Kubernetes Secret-object integration.** Locally they travel over private stdin, not argv or temporary manifest files; raw API output stays private. Requested containers drop capabilities and disable privilege escalation; automatic service-account token mounting is disabled. Cluster admission, configured images and commands remain trusted execution surfaces, not an OS sandbox.

The small native functional scenario uses a disposable kubectl substitute: approval-before-effects, two pods receiving the configured image/environment and HTTP/TCP probe contract, all replicas present while API readiness remains false, no successful start before readiness, observed health loss/recovery, UID-checked cleanup preserving unrelated and copied-label replacement pods, app-exit-before-readiness rollback, and private output. The fixture controls API readiness; it does not simulate a kubelet or execute real HTTP/TCP probes. No live Kubernetes installation, scheduler, image pull, application connectivity or Helm compatibility has been verified.

## Verification

```sh
bun run lint
bun run type-check
bun test
bun run build
```

The small test suite uses temporary repositories/storage and a fake model provider, including persisted restart, human approval, cancellation, scheduler accounting and authenticated image delivery. Environment scenarios launch only isolated fixture processes: they verify atomic app contention/handoff, owner fencing, cleanup, build/test exit codes, secret redaction, readiness timeout, and real crash/quarantine recovery without saved-PID takeover. Container scenarios substitute isolated executable Docker/Podman clients and an in-test Unix-socket engine (no actual daemon or credentials): they verify native approval/provider/profile selection, real argv/process I/O, private metadata handling, build/test receipts, foreign-stop refusal, changed-ownership/copied-label replacement refusal, missing/unhealthy readiness, daemon-loss quarantine and cleanup. Fixture success does not establish compatibility with a live Docker or Podman installation. It makes no live model or credential calls. Tests focus on behavior and failure boundaries rather than helper coverage or implementation structure. Isolated real-browser smoke checks also verified image decoding/delivery, environment log redaction and retention across polling, and that review draft text and keyboard focus survive an unrelated chat update and polling refresh.

Desloppify is installed locally in `.desloppify/venv`; its state and generated analysis are ignored. Its subjective dimensions are not yet independently assessed. No high quality score or production-readiness claim follows from a successful build or the current tests.
