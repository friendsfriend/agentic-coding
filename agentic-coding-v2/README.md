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

The host prints its loopback URL and does not open or focus a browser. The URL fragment is a local operator credential: do not share it. After authentication the browser retains it in origin-scoped `sessionStorage` (including the port), removes the fragment from history and sends explicit bearer headers. **No authentication cookie is issued or accepted:** cookies are host-scoped, not port-scoped, and could reach another loopback application. Storage is accessible to this trusted UI origin, not to another port. If storage is unavailable, the credential remains only in memory; reopening/reloading may require the private URL. Bindings other than loopback are not supported. This source change does not restart older hosts, migrate their sessions or revoke their old cookies.

Chat images use lazy, authenticated, no-cookie/no-redirect fetches of exact content-addressed attachment paths, then local blob URLs. An inert template prevents premature unauthenticated image requests. Display accepts PNG/JPEG/WebP/GIF up to **5 MiB per image** with a **15-second fetch deadline**, a visible failure/retry control, retained unchanged message nodes and object-URL/request cleanup when messages leave or the page receives `pagehide`. Direct attachment HTTP requests still require a bearer header; a digest is not authority. JavaScript is required for authenticated image display.

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

Environment management is native-task-owned, not workflow-owned. **POSIX shell and explicitly configured local Docker/Podman container targets** are implemented. Container behavior has executable-fixture coverage, not live-engine integration verification. A strict Compose subset and explicitly approved local Kubernetes API identity inspection are also implemented. An initial Kubernetes bare-pod run adapter is implemented for explicitly selected existing local contexts/namespaces. Exclusive task-owned infrastructure/dependencies and declared held-shell endpoints are implemented within the limits below. Helm, shared/external infrastructure leases, endpoint discovery and broader database/telemetry compatibility remain pending. Narrow held-shell PostgreSQL diagnostics and opt-in native-shell telemetry are documented below. The [environment parity ledger](docs/environment-parity.md) tracks remaining capabilities without claiming full parity. Definitions, leases, containers and processes from the previous host are never automatically imported or adopted.

The dashboard's **Discover environment definition hints** panel works for every configured repository, including repositories with no environment definitions yet. The orchestrator can use `env_discover({ repository: "/exact/configured/path" })`; authenticated clients can read `GET /api/environments/discovery?repository=...`. Home/UI reads use the developer checkout; native skill reads use only that task's captured workspace and cannot select another repository. Discovery does not renew app leases.

This is a bounded, root-only hint scan, not authoring or validation: only `package.json` contents (at most 64 KiB) are parsed; script bodies are withheld. Known lock/build/container filenames are metadata only, and symlinks are not followed. Unambiguous declared/lock-file package-manager evidence yields at most 24 untrusted script invocations with explicit omissions and a 12 KiB response bound. Conflicting or unknown manager evidence does not invent an npm/Bun default. Source digests are observations, not approval authority. No commands/CLI probes, `.env`/provider reads, definitions written/imported, catalog reloads, readiness claims or executable targets result. Invocations are **not** importable v2 target definitions. Nested/custom layouts, full definition editing, staged validation and conflict-safe approved promotion remain pending; this is not an OS filesystem sandbox.

### Private staged definition JSON (initial subset)

The dashboard's **Private staged environment JSON** editor and authenticated `GET/POST /api/environments/drafts` stage whole `environments.json` text in private native documents, not in the repository or live configuration. This developer-only API is deliberately **not** a model tool. It starts empty: no live definition content, `.env`, provider credentials or auxiliary files are copied. Do not paste credentials; use `secretRefs`. Storage is plaintext native state, not encryption; admission requires an existing private POSIX-mode state directory outside every authorized repository (not an OS/ACL sandbox).

Save with `{requestId, content}`; edit with `{requestId, id, revision, content}`. GET without `id` lists metadata; GET with `?id=...` explicitly loads content. Saves bind retries to exact input and fence concurrent/stale revisions. A replay returns the original save receipt, not a claim that its revision is still current. The UI preserves text on failure and requires explicit loading before resolving conflicts. Limits: 64 KiB per draft, 16 current drafts and 256 durable request receipts; automatic pruning/deletion is unsupported.

Invalid JSON/schema text can be saved for editing. Loading recomputes **schema-only** checks against exact current authorized repository paths and binds the report to content/repository digests. It never opens referenced project files, probes engines or executes targets. An original absent/regular-file base digest is captured without copying live content; changed/unavailable base observations are visible, never automatic rebase or promotion authority. Symlinked/nonregular/over-64-KiB live definition bases are refused for creation. No live writes, reloads, task admission, approval or promotion result. Full auxiliary-file staging, broader editing/symlinks, model-authorized draft writes, separately approved real-path validation, exact-content approval and conflict-safe durable promotion remain pending; the initial private Compose-text subset is described below.

### Historical default/path metadata preflight

After saving, **Observe saved draft defaults/paths (no execution)** creates a private immutable report bound to `{id, revision, digest}` via authenticated `POST /api/environments/drafts/preflight` with a stable `requestId`. Read a report using `GET /api/environments/drafts/preflight?id=...`; draft loads list report metadata, and the UI explicitly loads the latest historical report. Exact retries return the original observation even after source changes or later edits; they never rerun validation. A new request requires the current revision/digest and creates a fresh observation. Reports survive native reopen, remain private to the developer, and never enter model/environment snapshots. Limits: 64 reports, 32 projects, 128 targets and 64 PATH entries per target; no automatic pruning.

Preflight uses the real shared default/availability resolver, checks contained existing cwd directories and referenced Compose-file **metadata** (regular files up to 64 KiB), and withholds commands, literal environment values and filesystem/parser errors. Availability inspects local metadata only: no CLI launch or daemon connection. It does **not** read/compile source contents, validate container build contexts, expand dependencies, resolve credentials, contact clusters, execute anything or determine promotion eligibility. Reports explicitly retain `historical: true`, `sourceContentsChecked: false`, `runtimeChecked: false` and `dependenciesExpanded: false`; metadata digests are observations, not conflict fences. Missing, ambiguous or escaping paths/defaults are reported, while undeclared actions remain uncovered. Separately approved source/runtime validation and immutable exact-content promotion are still required.

### Explicit offline Compose source check

The developer can additionally select exact saved Compose app/target IDs, opt in to a source read, then choose **Check selected Compose source (no execution)**. The same authenticated preflight POST accepts `readComposeSource: true`, `app` and `target` along with the exact draft revision/digest and stable `requestId`. Without explicit opt-in, source-selection fields are refused and ordinary metadata preflight still reads no source contents. Old metadata request bindings/retry receipts are unchanged.

This POSIX-only initial subset reads **one** conventional `compose[.profile].yml/yaml` or `docker-compose[.profile].yml/yaml` file, at most 64 KiB, under the selected authorized repository. Hidden/known provider, credential and secret directory names, arbitrary filenames, symlink components, hard links and nonregular sources are refused. No-follow/nonblocking descriptor reads compare file/directory identity before and after capture; these observations are neither an OS sandbox nor a promotion fence, and naming conventions are not a secret classifier. The native strict Compose subset parser consumes those captured bytes without reopening the source. It inspects bind containment but does not validate mounted file contents, a full staged tree or build contexts. No `.env` loading, secret resolution, dependency execution/expansion, process/CLI, daemon or cluster call occurs.

Private immutable reports store only the selected binding, source/compiled digests, byte/service counts and data-free acceptance/refusal. Source text, service identifiers, commands, literal values, compiled plans and raw errors are withheld. Exact retries replay the original historical report even after source or draft changes; fresh observations require a new request and current revision. Reports share the 64-report capacity and explicit historical loader. UI consent is consumed on every attempt and never restored on load/reload. A single-source success deliberately leaves whole-definition `sourceContentsChecked: false`, `runtimeChecked: false` and `dependenciesExpanded: false`; it confers no execution, approval or promotion authority. Model-authorized drafts, broader auxiliary/symlink editing, complete source/runtime validation and exact-content reviewed promotion remain pending.

### Private staged Compose YAML

The developer can load a selected **private staged source / new blank buffer**, edit YAML, and save it separately using authenticated `POST /api/environments/drafts/source` with `{requestId, id, revision, app, target, content}`. This never imports repository source contents or writes repository/config files. Only exact conventional Compose targets in valid saved JSON are eligible; inputs remain editable even when their YAML is invalid. Sources are private native document data outside repositories, not files mounted into a runtime. Do not paste credentials: private state is plaintext, not encryption or an OS sandbox.

Each source save advances the **same draft revision**, leaving `digest` as the JSON-text digest. A source's own `digest` binds its exact UTF8 text. Exact save retries replay their original receipt; stale revisions, changed input under a reused request ID, unknown fields and unauthorized callers are refused. Existing JSON saves/receipts remain compatible and preserve staged sources. Storage is bounded to 4 distinct normalized repository/file bindings and 128 KiB total source text per draft, at most 64 KiB per source, sharing the existing 256 save receipts. Multiple targets naming the same file share its staged text. JSON retargeting retains old sources privately but does not apply them to a new path; deletion/removal and broader source trees remain unsupported.

**Check saved staged Compose YAML (no repository source read)** uses `POST /api/environments/drafts/preflight` with `useStagedSource: true`, exact current `{id, revision, digest}`, app/target and a new stable request ID. It cannot be combined with repository-read opt-in. The native parser consumes the matching saved source bytes and may inspect path/bind metadata; it never reads the live Compose file or mounted contents. Historical reports expose staged origin/digests/counts, withhold text/values/plans and retain the same no-execution/no-approval flags. The UI protects unsaved buffers, scopes them to the selected saved JSON/app/target, preserves focus during polls, and explicitly reloads saved source text after navigation.

Every source base starts **unobserved**. The developer may explicitly establish the **current** file/absence as a base using `POST /api/environments/drafts/source/base` with `{requestId, id, revision, app, target, sourceDigest, readBase: true, acceptCurrentBase: true}`. Both read consent and acknowledgement that this is **not the original staging-time state** are required. This advances the shared draft revision and captures only a versioned identity/content fingerprint, optional content digest and time—not live contents. Established bases cannot be overwritten; later staged edits preserve them. Exact historical retries return their original receipt without rereading the file. Source removal and rebasing remain unsupported.

A fresh `compareSourceBase: true` preflight with the exact current draft binding/app/target explicitly rereads the source and compares the live state with that established base, **not staged text with live contents**. This mode cannot combine with other source modes. Bounded POSIX checks cover repository/parent directory identities, missing parents, ordinary single-link files, stable descriptor/path metadata and at most 64 KiB of content. Replacing a file with identical bytes still conflicts; creating a previously missing parent also conflicts. Unsafe/unavailable observations yield no match, not success. Reports remain private, immutable and historical; no source text or filesystem errors are exposed. The UI consumes read/acceptance consent and does not restore it after reload.

These are conservative **point-in-time observations, not atomic publication fences**: directory namespace ABA races are not excluded by the path-based checks. Neither parsing nor a matching report permits promotion or establishes an original staging-time base. Complete isolated staging/validation, race-safe exact-content human-reviewed publication and original per-path base handling remain required. No model write tool, runtime task, review, live reload or promotion is added.

### Saved Compose-candidate manifests

**Check saved Compose candidate (offline; no publish)** uses authenticated `POST /api/environments/drafts/preflight` with `{requestId, id, revision, digest, validateStagedCandidate: true}`. This whole-candidate mode cannot combine with selected-source modes or app/target fields. It checks only the saved JSON and staged text, using the existing native Compose-subset parser. Live source bytes and bind contents are never imported/read; containment/bind metadata may be inspected. Save all editor buffers first. This operation consumes any pending UI source-read/base acceptance checkboxes without using them.

The versioned `candidateDigest` binds the exact saved JSON digest, authorized repository-list digest, and sorted unique repository/file bindings with each source-text digest and complete known base-observation descriptor digest (or an explicit unobserved base). Re-saving identical inputs preserves this digest even if the draft revision advances or internal source order changes; changing source text, JSON or an established base changes it. Reports still bind their original draft revision. Source text, service identifiers, commands, environment values and compiled plans are withheld; only hashes/counts and target-level coverage are reported.

Acceptance requires at least one declared target, every declared target to be a supported Compose target with matching saved source bytes successfully parsed, and no orphaned staged source bindings. Multiple targets may share one source. Missing/refused/unsupported targets and orphan bindings prevent acceptance; invalid JSON/source/base integrity produces a data-free refusal. Bounds are 32 projects / 128 targets and the existing 4 files / 128 KiB total (64 KiB each); the same private 64-report history/exact retry protocol applies. Retargeted/orphan sources are retained rather than silently discarded; remove an obsolete staged source explicitly, or delete the draft.

**Candidate acceptance is not isolated-tree or runtime validation.** Bases are bound but not freshly compared. Bind contents, auxiliary/provider/private inputs, complete staged trees, namespace-race-safe publication and independently reviewed exact-content promotion remain pending. Reports explicitly set isolated-tree, base-freshness, bind-content, runtime and publication flags false; no model tool, task, review, live catalog mutation or promotion capability is added.

### Ephemeral isolated staged trees

**Assemble isolated staged tree (verify then discard)** uses `{requestId, id, revision, digest, materializeStagedTree: true}`. It is mutually exclusive with candidate and selected-source modes, accepts no app/target fields, and requires an accepted saved candidate; an incomplete candidate produces a data-free `accepted: false` report and assembles nothing.

A complete candidate is written into a freshly created `CONFIG_DIR`-independent private staging directory (`STATE_DIR/native/staging/tree-*`, `0700`) that must be outside every authorized repository, using saved JSON and staged text only: `environments.json` plus each staged source at its conventional normalized path. Files are created `O_EXCL`, mode-pinned `0400` with `0500` directories, then every path is re-opened with no-follow, confirmed to be one regular single-link file of the expected size, and re-digested. Duplicate tree paths, absolute or escaping paths and non-private staging roots are refused. The tree is always removed afterwards; the staging root is left empty.

Only per-path digests, content digests, byte counts and the aggregate `treeDigest` are reported — never paths, source text, services, commands, values or filesystem errors. `isolatedTreeChecked` is true while `sourceContentsChecked`, `bindContentsChecked`, `baseFreshnessChecked`, `runtimeChecked`, `dependenciesExpanded`, `executionAllowed`, `publicationAllowed` and `treeRetained` stay false. No repository write, live source read, base refresh, runtime call, task/review admission, catalog reload or publication occurs. The tree is transient: it is not a retained staged tree, not materialized runtime input and not an approval gate or promotion capability.

### Removing private staged sources and drafts

**Remove staged source for selected target (private only)** uses `POST /api/environments/drafts/source/remove` with `{requestId, id, revision, app, target}`. It removes only the staged source bound to that exact target, advances the shared draft revision, keeps the JSON digest, and does not alter repository files, live configuration or historical reports. Removing a binding the draft does not currently declare under that exact app/target is refused, and a stale revision is refused. Re-staging the same target afterwards is an ordinary source edit; there is no restore-from-history capability.

**Delete private staged draft** uses `POST /api/environments/drafts/remove` with `{requestId, id, revision}`. It deletes only that private staged document, freeing its draft slot. Immutable preflight reports and exact-input receipts remain historical data: a saved report still loads by its `preflight-…` id, while the deleted draft itself, its list entry and any new preflight for it are refused. Deleting under a stale revision is refused; exact retries replay the recorded result. Neither action is pruning, garbage collection or history erasure, and neither is a promotion, approval or repository change.

The UI requires saved (not dirty) editor text and an explicit confirmation, clears the loaded source buffer on removal, resets to an empty draft after deletion, and reports the resulting revision. Both routes are authenticated, reject query parameters and unknown fields, and remain unavailable to model tools.

### Promoting the exact staged configuration

**Promote exact staged config to live environments.json** uses `POST /api/environments/drafts/promote` with `{requestId, id, revision, digest, approve}`. `approve` must equal the exact current staged content digest, and `revision`/`digest` must still match the stored draft; anything else is refused. Only the private staged document is promoted: staged Compose sources, repository files, running processes, containers, leases and staging trees are never touched, and a running instance may not reload the new configuration automatically.

Promotion preconditions: the draft content must still digest to its stored digest and pass the native v1 schema with at most 32 projects / 128 targets, every referenced repository must already be authorized and exist at its real path, the live destination must be absent or a regular file of at most 64 KiB (never a symlink or directory), and the destination must not sit inside an authorized repository. When the live destination already holds exactly the staged bytes the route reports `unchanged` and writes nothing.

The fence is the destination base recorded when the draft was created or last advanced: it is compared to the live destination (state `absent`, or `regular` plus content digest) immediately before the write and once more inside the fence check, and the promoted bytes are read back through the same no-follow path afterwards. This is a compare-and-swap, not an OS lock: a concurrent external writer inside the short window, or a second instance promoting to the same file, can still lose an update. If the read-back does not verify, the route errors and records nothing, so the fence then refuses further attempts until a new draft stages against the current state — it deliberately does not restore previous bytes, because restoring could clobber a concurrent writer.

Writes are atomic per file: an exclusive same-directory temp file (`.environments.json.<digest>.tmp`, mode `0600`) is written, fsynced and renamed over the destination, then the directory is fsynced best effort; the temp file is removed on every failure path. The resulting file mode is `0600`. Each promotion is stored as an immutable history record (`promotion-<id>`, at most 64, read with `GET /api/environments/drafts/promotion?id=`) that carries the outcome, previous and resulting destination digests, byte/project/target counts and explicit `sourceFilesWritten`, `repositoriesChanged`, `runtimeChecked` and `reloaded: false` flags. Records are not pruned, survive draft deletion, and an exact retry returns the recorded record without writing again. No promotion record is runtime validation, readiness, review approval or execution authority, and none of this is a model tool.

Create `CONFIG_DIR/environments.json` manually for live use (restart to discover definition changes):

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

`cwd` defaults to `.` and must resolve inside the owning task's workspace (an isolated skill worktree or an explicitly reviewed operator checkout/worktree), including a containment recheck immediately before spawn. All selected apps must belong to that task's repository. Dependencies and uncommitted source-checkout files are not copied into worktrees: configure an appropriate, separately approved install/build target if needed.

Literal `environment` values are public configuration and appear in catalog/review snapshots. **Do not put credentials there.** `secretRefs` maps child environment names to variables in `CONFIG_DIR/.env` (a dotenv data file, not executable shell); an explicitly referenced host environment variable is the fallback. Protect that file with user-only permissions. Missing references fail before acquiring or starting any app. Values are resolved after approval and are never placed in execution receipts or review snapshots. Only `PATH`, `HOME`, `LANG`, `TMPDIR`, `TERM`, the configured literals/references, and `WORKSPACE`/`CONFIG_DIR` are passed—not the host's whole environment. This is not a filesystem or credential sandbox: approved programs still run with the host user's OS authority.

### Direct environment UI and orchestrator controls

The environment interface remains a required part of v2; removing workflow graphs does not remove developer controls or orchestrator choices. Each configured project now offers Action, Runtime, Profile and Target selectors, eligibility/default explanations, a Workspace selector and explicit Kubernetes replica selection. **Prepare action for review** admits a native environment task, not a skill agent. No model profile, credential or model call is required for direct UI actions.

The default **developer checkout** includes local uncommitted files and can be modified by the approved command. Its HEAD is captured on admission and rechecked before dispatch; a changed HEAD requires a fresh action. Uncommitted contents remain mutable, not an immutable source snapshot. Alternatively choose **isolated worktree** and a Git base: the commit is captured, the worktree is retained for inspection and uncommitted checkout files are not copied. Neither mode is an OS sandbox.

Configured environment commands and runtime operations do not execute before authenticated approval of the exact frozen plan, workspace and resource disclosures. Admission may prepare the requested Git worktree before review. Run resources remain held by their native action until explicit **Stop operator batch**, process exit or host shutdown; stop also cleans coupled dependencies. Pending actions can be cancelled in the Environments topic. Build/test completion reports actual unsuccessful exits as failures, not successful verification. Issuance is journalled before dispatch and ambiguous interruption is not automatically resent. Restart does not adopt saved processes or resource IDs.

Authenticated `POST /api/environments/actions` takes `{apps, action, requestId, target?, profile?, runtime?, replicas?, workspaceMode?, baseRef?}`. A stable request ID deduplicates admission; changed intent with the same ID is refused. Apps must share an authorized repository. `baseRef` other than HEAD requires worktree mode. The orchestrator's `environment_action` offers the same choices with native-call-bound admission identity; it returns a task ID for review/progress, **not startup success**. Use `task_result`/`env_status` to inspect and `cancel_task` to stop that action. UI-started actions do not inject automatic model prompts.

For a live agent-held run, **Stop and revoke task environments** is a separate authenticated developer action. It stops all that task’s held environments and coupled dependencies, cancels retained waits and permanently prevents that native task from reacquiring environments, **without cancelling its coding task**. The API is `POST /api/environments/revoke` with `{runId, revision, requestId, reason}`: stale revisions and changed-request replays are refused, same-request retries join cleanup, and durable audit receipts appear in the UI. No agent tool grants this authority. Cleanup failures remain quarantined. Restart restores revocation, never cleanup authority: interrupted issuance needs inspection and does not adopt saved PIDs/container IDs.

These are initial restored controls, not full UI parity. An initial protected agent-only native-batch idle policy is implemented below. Definition drafts/promotion, broader infrastructure/endpoint/runtime support, finer-grained/shared lifecycle and richer diagnostics remain required unfinished work. Disposable tests and a headless browser smoke verify the new local controls, not compatibility with live engines or existing apps.

Available tools:

- `environment_action`: home-orchestrator direct environment preparation with target/profile/runtime/workspace/replica choices and exact human review; no skill agent.

- `env_discover`: explicit repository root evidence and untrusted package-script hints, without execution or configuration writes (see above).
- `env_list`, `env_status`, `env_logs`: inspect definitions, owners, queues, readiness, exit receipts and logs. A skill reads only its own logs; the home orchestrator and authenticated operator can inspect all host runs.
- `env_logs({app?, infra?, grep?, tail?, service?, since?})`: a compact run-framed log view, not full execution plans. It selects already-redacted retained lines using **literal** substring matching (not regex), then the newest matching lines per run (`tail` defaults to 200, range 1–1000; `grep` is at most 512 characters). At most 20 recent/live runs share a 12 KiB JSON-encoded output budget, newest/live runs first. Whole lines that cannot fit are omitted, never cut mid-line; per-run matched/selected/returned/omitted counts and tail/window flags distinguish budget loss from no matches. When a 64k-character retained buffer may start inside an old line, that first boundary line is conservatively withheld. Counts describe only the retained redacted window, never total historical logs. Selection makes no additional CLI/runtime or log-backend calls and has no execution effects. Runtime buffer order is not event-time ordering; Compose remains aggregate service buffers without a chronological merge, and Kubernetes exposes only client diagnostics, **not Pod logs**. Optional `service` selects an **exact declared Compose service**, before grep/tail, from a structured child buffer—not from parsing user-controlled `[service]` header text. Stack-network diagnostics are excluded; a selected child buffer can still contain that child's container-client diagnostics alongside retained application lines. Per-run `sourceAvailability` reports `available`, `not-declared`, `not-captured` (including older receipts without a snapshot), or `unsupported-runtime`; unavailable sources return no lines and never silently fall back to aggregate logs. New per-service snapshots share a separate 64k-character capture window per stack, divided equally among its declared services; clipped leading boundary lines are withheld and `sourceTruncated` reports capture-window loss, not historical completeness. Already-redacted snapshots survive normal owned cleanup; a host crash can still lose subsequent in-memory output. They are diagnostic data, never restart/adoption authority. A disposable Compose scenario verifies service isolation despite spoofed header lines, native-tool selection and retained output after cancellation cleanup; a shell scenario verifies unsupported filtering cannot expose aggregate output. Choose exactly one `app` or `infra` ID. `infra` selects only the immutable infrastructure kind captured in the execution plan, never ordinary app history relabelled by current configuration. The same task-owner scope and redaction apply. Initial native-shell host-receipt timestamp filtering is described below; provider application/event-time filtering and Kubernetes Pod logs remain pending. A native functional scenario verifies literal filtering, matching-line tails, secret redaction, another task's logs staying hidden and complete-line omission of an over-budget Unicode line. The authenticated dashboard uses the same bounded selector rather than returning raw execution-plan/timing journals.
- `env_start`: human approval for the exact command/cwd/variable-reference plan, then atomic reservation of the entire requested app batch. If a target is ambiguous, select its ID explicitly. Conflicting batches retain FIFO priority while unrelated apps can proceed; explicitly shared container names and published ports also count as conflicts. It waits inside the tool without model polling. `timeoutSec` defaults to 30 (maximum 7200). By default timeout removes the queue entry without starting anything; explicitly approved `retainQueue:true` instead returns a bounded-wait receipt and retains priority for `env_wait`. Cancellation always removes the entry. Acquire all required apps together; stop an existing batch before acquiring more, avoiding hold-and-wait deadlocks.
- `env_wait`: continue only this native task's live retained acquisition, with the original immutable plan and no new permissions. No selection/runtime overrides or queue adoption from history.
- `env_build`, `env_test`: separately approved commands in the task's worktree, with actual exit codes and redacted output. They require no app slot, but concurrent build/test actions in the same workspace are refused. Container builds conservatively serialize all image writers on the same local API socket, across workspaces and client families: Docker-compatible endpoints and Podman short-name policy make client-side tag identity unsafe to guess. An interrupted writer keeps that daemon's image-write resource quarantined. Nonzero exit codes remain failures reported as data, not invented successful verification.
- `env_http_get`: separately approved credential-free, non-redirecting GET to one named local endpoint of this task's live ready shell app. No other owner's app or saved receipt grants network authority.
- `env_http_request`: separately approved HTTP method/headers/body, optional bounded same-origin redirects and configured reference-only HTTPS authentication, with a durable native issuance fence. Non-read methods require `allowWrite:true`; this does not bypass human approval. See the endpoint contract below.
- `db_query`: exact-approved PostgreSQL diagnostics on this task’s live ready shell infrastructure required by a held app; verified TLS, frozen referenced credentials, read-only transaction, bounded/redacted rows and durable issuance fencing. See the SQL contract below.
- `env_stop`: live process-group or ownership-fenced container cleanup for this task's own selected apps and pending acquisitions. It cannot stop another owner. Durable stop receipts bind retries to the original selection, not newly started apps.

### Received-line timestamp selection

`env_logs({app:"api",since:"2026-01-01T10:00:00Z",grep:"request",tail:50})` first selects native shell lines received at/after the explicit ISO 8601 instant, then applies literal grep and the matching-line tail. **The basis is host receipt of a completed line (including final EOF flush), not the application's event time.** Date-like app text is never parsed as trusted timestamp metadata. Host wall-clock capture has millisecond precision and can be adjusted; it does not establish chronological application/service ordering. Submillisecond query instants are compared without rounding them down.

The host pairs already-redacted output with bounded length/time receipts: at most **2048 completed records and 64k characters**, covering only a suffix of the ordinary retained output. Text is not duplicated into the timing journal. `timeSelection` reports its basis, normalized instant, timing-window truncation, untimed retained lines and older timed lines excluded before grep. Untimed lines are never silently included when `since` is set. Older saved receipts and currently unsupported runtime/service timing return `not-captured` with no dated lines; corrupt timing fails closed as `invalid-capture`. This is not a request for arbitrary historical logs.

The authenticated operator endpoint `GET /api/environments/logs?app=api&since=2026-01-01T10:00:00Z&grep=request&tail=50` returns an array of the same selected run views. It accepts exactly `app`, `since`, `grep`, `tail`, `service` and optional `kind=infrastructure`; unknown or repeated query parameters are refused rather than silently dropping a requested filter. The shared validator enforces explicit instants, literal matching, exact services, line limits and the combined output budget. Operator reads can span tasks; native skill reads remain task-owner scoped. The dashboard’s **Log filters** expose literal grep, exact ISO since, 1–1000 matching-line tails and exact service selection. Results include the requested filters, source availability/truncation, time-selection/framing and match/tail/budget metadata before the retained text. A run outside the response window is never replaced with another run’s output. Filter values, viewed output and focused diagnostic inputs survive live run-state revisions; controls are not detached and recreated on every poll.

Shell capture timing survives ordinary owned cleanup alongside its redacted output. A host crash can lose later in-memory observations; retained timing grants no restart/adoption authority. Container/Compose/Kubernetes provider event times and service timing are still pending. Native scenarios verify spoofed future/past app dates cannot control selection, bounded timing excludes older untimed records, frozen-secret redaction, same dated output after stop, an empty future window, invalid-instant refusal and no aggregate fallback for an unavailable source. No runtime CLI call or extra permission is introduced by this selection.

### Agent-only idle lifecycle

Live **agent-owned native batches** expire after 30 minutes without owner-scoped environment use. The CLI drives a single throttled sweep through `Runtime.tick`, at most once per 60 seconds. The file-only `environment.instances.idle_ttl_minutes` setting in `config.json` is re-read each pass; a positive number representing a safe whole-millisecond duration is usable, otherwise the 30-minute default applies. Policy reads are bounded to 64 KiB; missing, malformed or oversized sources also use that default, never silently disable expiry.

Native start/reuse/wait, status/list, owner-scoped logs/telemetry and held HTTP/SQL checks renew live owner activity. Operator/dashboard reads and background telemetry ingestion do not keep an agent alive. **Operator owners, unrecognized owners, owners waiting for another environment acquisition, pending environment operations and any unknown/non-live member protect the entire owner batch.** A coding task paused for an ordinary human review is not an environment acquisition wait. Expiry is whole-batch, not independent per-app reference-counting: activity on one member renews its coupled resources. Activity is ephemeral, not restored execution authority.

An expiry revalidates the live owner/activity and every member inside the native stop-intent transaction, latches dispatch against new use, durably records the reason before cleanup, and uses the existing live-owned reverse cleanup path. It neither cancels coding nor permanently revokes environment authority: a surviving task may request a fresh exactly approved start. Failed/ambiguous cleanup remains quarantined; restart never retries an issued stop with saved IDs. Status/UI expose protection, last observed activity, remaining interval and a durable expiry reason/cleanup state. The browser now offers native owner/holder/waiter task jumps, global FIFO order with advancing wait age and bounded recent notices for newly observed waits, running grants and confirmed idle cleanup. Initial hydration suppresses historical notices; snapshot polling is best-effort, not a durable or complete event stream. Notices expire after 30 seconds (at most five retained); focused notice controls are not pruned while in use. Countdown-only polls update text without recreating task/topic controls or diagnostic inputs; owner activity also visibly renews the timer. Full independent per-app/shared-reference lifecycle remains pending. A disposable native scenario verifies renewal, operator protection, dependency cleanup, continued coding, fresh approved reacquisition and live policy reload/default fallback; existing killed container/Compose cases verify a future sweep makes zero engine calls against quarantined saved IDs. A disposable browser smoke verifies the timer, expiry reason, pending coding review and retained diagnostic focus without a live engine/model/credential.

### Opt-in native shell telemetry

A shell **run** target with `readyText` can explicitly add `"telemetry":{"protocol":"otlp-http-json","listen":"127.0.0.1:0"}`. This additional listener capability is part of the exact startup approval; it is off on existing targets. The native host opens one ephemeral numeric-loopback receiver per run, injects a private random bearer credential through the standard OTLP HTTP/JSON exporter variables, and binds `AC_OTEL_APP`, `AC_OTEL_OWNER`, `AC_OTEL_RUN` and resource attributes to the native execution. These variables, exporter overrides and metrics disabling cannot be replaced by target literals/secret references. This configures transport, **not automatic instrumentation**. Only uncompressed OTLP/HTTP JSON spans/logs on `/v1/traces` and `/v1/logs` are supported; no metrics, protobuf/gRPC, external backend, SDK compatibility or non-shell runtime parity is claimed.

`otel_query({app:"api",limit:20,status:"error",name:"GET /"})` returns trace summaries from that native task's live ready held run. `otel_query({app:"api",traceId:"<32 hex digits>"})` returns bounded **flat spans with parent IDs**, not a fabricated complete tree. `otel_query({app:"api",mode:"logs",severity:"ERROR",text:"request"})` selects retained structured logs. Trace `status`/`name` and log `severity`/`text` filters are mode-specific; mismatched or unknown options are refused. Status means an observed error span, not application health. Name/severity are case-insensitive substrings; text is literal case-sensitive matching over a structured log record. `since` requires an explicit ISO instant and filters **host receipt** times, never spoofable provider timestamps. Default limit is 20, maximum 200. Trace availability is independent of name/status/since filters: a retained trace with no matching spans stays `retained`. A bounded window of the 200 most recently evicted trace IDs distinguishes `evicted` from `unknown`; unknown means never captured or outside the retained/eviction-identity windows, not proof the trace never existed. In logs mode, availability describes linked records before filters in the retained log window, independently of span retention. Skill queries cannot read another task's run; authenticated home/operator inspection can inspect current live runs.

The authenticated operator endpoint `GET /api/environments/telemetry?app=api&run=<native-run-id>&mode=traces` requires the exact native run ID as well as the app. It accepts the same bounded `mode`, `traceId`, `limit`, `since`, `status`, `name`, `severity` and `text` selectors; unknown or repeated query parameters are refused. A stale/non-held run ID fails instead of selecting a later holder of the app. The dashboard’s **Native telemetry filters** expose mode, trace ID, limit, since, status/name and severity/text. Mode-inapplicable fields are disabled and omitted, not silently sent. Explicit summary/span/log query buttons are enabled only for telemetry-enabled running/ready captures; previously entered values and output survive status changes. Queries never run merely because a filter changes. Observations include their native app/task/run scope and loss metadata, render as text rather than HTML, and use a separate pane from retained process logs. Reading never starts an app or receiver and grants no lifecycle authority. Previously viewed redacted output may remain on a card as diagnostic text after cleanup; it cannot reopen capture.

Resource-provided identity is diagnostic only: a payload's `ac.owner` cannot change attribution or grant execution permission. Declared startup secrets and the generated receiver credential are redacted before retention, including the credential in child stdout. Encoded records with residual literal-secret matches are withheld rather than corrupting typed fields. String values are clipped with a marker, nested values/attributes are bounded, and oversize records are wholly dropped. This is literal redaction, not a sandbox against deliberate arbitrary encodings.

Capture admits at most four pending 64 KiB JSON requests with a five-second body deadline. The in-memory window holds at most 200 traces/500 spans per trace/3 MiB encoded trace data and 1000 logs/1 MiB encoded log data; each retained record is at most 16 KiB. Query records share a 48 KiB encoded budget with whole-record omission. Responses disclose limits, eviction/drop counts, matched/limit/budget omissions and incomplete-history status. A requested ID without retained matches is `not-retained`: it does **not** invent a distinction between never-received and evicted data. Buffers/tokens are not persisted or adopted after reopen. Returned redacted observations can remain in durable native task/chat history as diagnostic tool results; that does not restore capture state or authority. Stop, startup cancellation, process exit and owner cleanup close admission, clear buffers, force-close/join the listener and withhold lease release on uncertain cleanup. No current live ready run means unavailable, not a saved-history fallback. Disposable public native scenarios verify authenticated ingestion, forged resource-owner isolation, redaction, trace eviction/oversize omission, duplicate span replacement, foreign/stopped refusal, clean later-holder isolation and TCP-listener closure after cancelled startup. They do not establish third-party SDK or live-runtime parity.

### Bounded acquisition continuation

`env_start({apps:["api"],timeoutSec:30,retainQueue:true})` includes retention in its exact human approval. A bounded acquisition timeout returns `{acquisition,state:"still-waiting",queuedAt,ordinal,recordedPosition,observedAt,...}` rather than an execution error. Continue with `env_wait({acquisition,timeoutSec:30})`; each call accepts 1–7200 seconds and waits inside the tool without model-side polling. The queue's original admission ordinal/time survive repeated bounded calls. Only the original workspace-write native owner can continue the exact stored plan: no changed app list, target, runtime, replicas, dependency plan, workspace or credential references. A different request first requires `env_stop` to cancel its existing wait, then fresh startup approval.

No apps are reserved or started **between** explicit continuation calls. Retained priority can therefore block later conflicting batches even after resources become free; unrelated batches remain eligible. Continue promptly or cancel the wait. Ordinary target startup/readiness deadlines begin only after atomic reservation, and `acquired` in queue history means reservation occurred, **not** that startup/readiness/cleanup succeeded. Consult the run receipts.

Native input-bound poll receipts preserve completed bounded-wait observations and prevent their replay from re-enqueueing or starting apps. An old returned position/state is diagnostic as of its observation; inspect `env_status` for current queue state. Matching `env_stop`, task completion/cancellation and host shutdown remove retained positions. Reopen marks saved waiting records interrupted and does not restore FIFO/execution authority from them; fresh approval is required. Status includes up to 200 metadata-only queue history entries plus the live queue; no stored plan, command or secret values are exposed in this history. Native fixture scenarios verify FIFO handoff after two bounded calls, no start between continuations, foreign-owner refusal, stopped-queue refusal and persistent reopen without saved-queue adoption.

### Repeated holder starts

A new exact approved `env_start` request for the complete identical run plan already held by the same native task returns an explicit `acquisition:"already-held"` receipt. It names the original run/batch plus the new request batch and reuse time. No second process, reservation, reference count, secret resolution or application of changed workspace contents is implied. Changed/partial plans, closing batches, interrupted receipts and foreign tasks are not reusable. Current live-handle checks and native task cancellation fences apply within the receipt transaction.

Reuse references are durable, but never restore execution/network/cleanup authority: replay resolves the original run's current recorded state; missing references fail closed. Native scenarios verify two independently approved starts produce one actual command/lease and one owned cleanup, while an approved different target cannot replace a held run.

### Initial task-owned infrastructure and declared dependencies

Projects may declare `"kind":"infrastructure"` in `environments.json`. These are **exclusive task-owned run resources**, using the same authorized repository/workspace, runtime selection, readiness observations, immutable approval, atomic batch reservation and live-receipt cleanup as apps. Infrastructure definitions are run-only: no implicit image build or database-query authority. Their identity is captured as `projectKind` in new execution plans; old receipts are not reclassified from today's catalog.

Explicitly acquire all needed resources together, for example `env_start({apps:["store","api"]})`, and read retained infrastructure output with `env_logs({infra:"store"})`. Capture/response bounds and unavailable-runtime behavior are unchanged. A native scenario verifies approval before reservation, one mixed app/infrastructure batch, redacted kind-scoped logs and cancellation cleanup. App/infrastructure projects may declare `"requires":["store"]` for run actions. References must resolve to infrastructure in the same authorized repository; duplicates, cycles and expanded batches over 16 projects are rejected before effects. The complete expanded plan is approved once and atomically reserved, then starts dependency-first through the configured readiness observations. Root target/profile/runtime options apply to explicitly requested roots, not to automatic dependencies' default targets. Kubernetes dependencies must also be explicitly requested with an eligible target/runtime: no implicit Pod starts.

A dependency-expanded batch has an explicitly approved **coupled lifetime**: selecting any member in `env_stop`, any member exiting, startup failure, task cleanup or host shutdown stops the entire batch, dependents before dependencies. No partial release or automatic restart. Callback exits retain resource occupancy until ordered live cleanup reaches that member; late callbacks cannot reconstruct authority from saved receipts. Known cleanup failures do not skip cleanup attempts for the remaining selected live resources. Native scenarios verify dependency-first readiness, immutable expanded approval, member-selected dependent-first cleanup, unexpected dependency loss, failed startup settling, cycle refusal and expanded-limit refusal before approval/reservation.

There is **no cross-task sharing, external-service adoption or last-reference lease release yet**; do not treat these exclusive resources as shared services. No automatic endpoint/credential injection or new network links. Runtime readiness retains its existing limitations, not an end-to-end dependency health guarantee. Fixture verification is not a live infrastructure compatibility claim.

### Initial held-infrastructure SQL diagnostics

A declared infrastructure **shell run** target may add the following fields; it must also have an explicit `readyText`. The held application must require this infrastructure through its immutable `requires` graph in the **same native-owned atomic coupled batch**. Merely starting a standalone resource, knowing an ID, or reading an old receipt grants no SQL authority.

```json
{
  "secretRefs": { "PGUSER": "LOCAL_DB_USER", "PGPASSWORD": "LOCAL_DB_PASSWORD" },
  "queryConnection": {
    "protocol": "postgres",
    "host": "127.0.0.1",
    "port": 55432,
    "database": "application",
    "usernameRef": "PGUSER",
    "passwordRef": "PGPASSWORD",
    "caRef": "certificates/database-root.pem"
  }
}
```

Only explicit PostgreSQL numeric loopback (`127.0.0.1` or `::1`) is supported. TLS and certificate/IP verification are mandatory; no plaintext fallback, caller connection/credentials, hostname override, client key, external/shared service, MySQL or container/Compose/Kubernetes binding. The optional public `caRef` has the same config containment, regular-file/64-KiB/single-CA restrictions as endpoint CAs. Its digest is included in approval and checked before issuance; system trust is used without it. Declared query ports also participate in native admission conflicts. Neither a port declaration nor TLS proves which process owns a socket.

`db_query({infra:"store",sql:"SELECT id, status FROM requests",schema:"public",limit:50})` requires a workspace-write native task and **separate exact human approval**. The immutable request names the live infrastructure run, requiring app, connection references, SQL, schema, cap and public CA digest—not expanded credentials. Credentials and literal-secret redaction are frozen at approved infrastructure startup; later dotenv changes cannot replace them. The server verifies the connected database, session user, requested schema and read-only transaction mode before executing the user statement.

SQL is a bounded **SELECT/WITH subset** (20 KiB, no leading comments, disallowed control bytes or parameter-like `$digits` text, conservatively including literals/comments). Parameters are not caller inputs. A reserved nonempty driver binding forces the PostgreSQL single-statement extended protocol; relying on `prepare:true` without parameters is unsafe for Bun’s `unsafe()` path. The row cap defaults to 50, range 1–200, with one lookahead row. Each server-side JSON row projection is capped at 1025 characters; over-1024-UTF-16-unit rows are wholly withheld, never returned as a possibly secret-bearing prefix. Complete rows share an 8192-byte JSON budget, with explicit omission/lookahead metadata and no invented total count. Database numeric values become exact lexical **strings**, avoiding bigint/decimal rounding; nested data beyond eight levels is omitted. Complete row strings/keys receive literal startup-secret redaction, not protection against arbitrary transformations/encodings.

One reserved connection runs one **READ ONLY transaction**, a statement timeout and an explicit acknowledged `ROLLBACK` before success. One total ten-second deadline covers issuance/connection/query/rollback; connect has an additional five-second cap. Cancellation closes both the borrowed connection and pool, joins the run’s cleanup barrier, and rejects observations if any coupled member closes. READ ONLY is **not a sandbox for privileged SQL functions** or a guarantee against external/nontransactional effects; inspect the exact SQL and configure a least-privileged database role. On failure/cancellation, server-side rollback may be unconfirmed.

The native tool-task ID and canonical input bind an `issued` journal marker committed **before connection/query dispatch**. Only a completed bounded diagnostic may replay; uncertain issuance never resends, reconnects or adopts a saved lease. This is not exactly-once execution. Status exposes up to 200 metadata-only entries (no SQL, row data or credentials); `issued` means pending-or-uncertain, not proof of dispatch or failure. Host reopen leaves saved runs quarantined and grants no database authority.

Six native scenarios use a disposable in-memory PGlite relational engine, real PostgreSQL wire traffic, a small TLS-upgrade adapter and generated local certificates. They verify exact approval, frozen-secret JSON redaction, bigint precision, caps, database/schema/read-only binding, a refused function write and multi-statement transaction escape with unchanged data, certificate-IP/downgrade/changed-CA refusal, foreign/stopped refusal, total deadline, cancellation cleanup and SIGKILL/reopen without resend or saved-PID adoption. PGlite multiplexes one backend, reset between fixture connections; it does **not** establish production PostgreSQL authentication, concurrent-session, daemon, engine, MySQL or live-system parity. No existing database, real credential or live engine was used. The runtime adapter uses Bun’s built-in SQL client; PGlite packages are exact development-only fixture dependencies.

### Kubernetes crash/reopen verification

A disposable native-host SIGKILL/reopen scenario verifies that saved Pod UIDs remain diagnostic-only with unknown ownership/health. Reopen, refused saved-receipt stop, cancellation and inspected release issue no fixture-client commands; occupancy remains quarantined until authenticated revision-bound operator confirmation. The fixture operator removes only the owned synthetic UID and preserves an unrelated Pod. This tests the native no-adoption boundary, not live Kubernetes crash/recovery compatibility or actual cluster absence verification. No runtime behavior or cleanup authority was added by this verification increment.

### Initial local endpoint diagnostics

Shell **run** targets may declare up to 16 `endpoints` as name → HTTP/HTTPS numeric-loopback URL (`127.0.0.1` or `[::1]`, no DNS, credentials, configured query or fragment). IDs use the same lowercase kebab-case convention. Set the declared port to the actual application's listening port; this declaration is not discovery, allocation or proof that the process owns a socket. HTTP is unencrypted; an actual HTTPS request verifies its peer certificate and numeric IP, but does not prove which process owns the socket. Declared TCP ports participate in native app-batch admission conflicts, including container-published ports and wildcard bindings. External processes are not adopted or reserved against.

Usable `endpoints` are exported in run results/status only while the live shell app is ready and held; configuration/review snapshots can still show the static declaration before startup. A missing `readyText` establishes only shell startup, not application health. On stop, owner cancellation, exit or host reopen, usable endpoints disappear and requests fail closed. Container/Compose/Kubernetes address binding, automatic ports and Kubernetes forwards are **not implemented**.

HTTPS uses TLS 1.2+ with normal certificate and IP-SAN verification. Without an override it uses the runtime's system trust. An optional **operator-configured** target map `"endpointCaRefs": { "secure": "certificates/local-root.pem" }` supplies a public CA for a declared HTTPS endpoint named `secure`, replacing system trust for that request only. The tool cannot select a CA or hostname override. The reference must stay inside `CONFIG_DIR` after canonical containment checks. Only one regular, at-most-64-KiB PEM public CA certificate is supported; private keys, client certificates and bundles are refused. Its exact source digest joins the immutable request approval and is rechecked before every dispatch, including each redirect hop; changing even whitespace requires fresh approval. Certificate bytes and keys are not returned to the model. There is no insecure-TLS option or client-key loading. A CA reference grants peer trust, not authentication authority.

`env_http_get({app, endpoint, path?})` requires a workspace-write native task and exact separate human approval, including the current run ID and normalized URL. Paths append to the configured path prefix; the **origin**, not that prefix, is the scope boundary. The client never follows redirects and sends no cookies, credentials or custom headers; it connects directly without an ambient proxy. This compatibility tool supports only GET, and **GET can still have server-side effects**. It grants no write, redirect or authentication capability; those require the distinct `env_http_request` contract and approval below.

A request has a ten-second total deadline, a 16 KiB HTTP-header limit and a 64 KiB source-body cap. Only UTF-8-decoded text/JSON/XML is returned; other or encoded bodies are omitted without decompression. Returned headers are restricted to content type/length/location. Literal known app secrets are redacted using the app's original startup redactor, even if `.env` changes later; this is not protection against arbitrary secret transformations or encodings. At a source-body truncation, the incomplete final line is withheld so a secret split by the cap is not returned as a prefix. Redacted output is bounded again for model delivery. Reported `bytes` counts captured source bytes, not an invented total response size.

Ownership is checked before approval, immediately before sending, and before returning observations. A response is discarded if the run closes, becomes uncertain or is replaced. In-flight requests join the native run's cleanup barrier; cancellation interrupts the request. This is capability-bounded diagnostics, not an OS/socket-identity sandbox.

The HTTP functional test launches its own disposable app through the real native shell boundary: no request before approval or without a held app, a conflicting app's declared port never starts, frozen-secret redaction after dotenv rotation, a source cap bisecting a secret, no redirect follow, and cancelled in-flight request cleanup. A separate HTTPS scenario generates disposable test certificates with `openssl` (a test dependency), serves its own TLS app, rejects implicit trust of a self-signed peer and a trusted certificate for the wrong IP, succeeds with the configured matching CA, then changes the approved CA source and verifies no further GET reaches the server. These fixtures do not establish hosted/live-system parity. No existing app, credential, trust store or hosted service is used or modified.

### Approved HTTP operations, authentication and replay

`env_http_request({app,endpoint,path?,method?,headers?,body?,allowWrite?,followRedirects?,authenticate?})` uses the same held ready shell endpoint, numeric-loopback origin, verified TLS, public CA fencing, redaction and cleanup barriers as `env_http_get`. GET is the default; HEAD, OPTIONS, POST, PUT, PATCH and DELETE are supported. POST/PUT/PATCH/DELETE require explicit `allowWrite:true` **and** a separate immutable human review of the initial method, URL, headers, body, run and options. This is not a read-only server guarantee: even GET/HEAD/OPTIONS can have effects. Cancellation, timeout and app cleanup cannot roll back server-side changes.

Request bodies are UTF-8 strings capped at **16 KiB**. Explicit headers are restricted to printable `accept`, `content-type`, `if-match`, `if-none-match` and `idempotency-key` values (1024 characters each; 4 KiB total). Caller Authorization, cookies, proxy/transport headers and arbitrary header-based credentials are refused before approval or dispatch. A caller idempotency key is merely forwarded, not a claim that the server enforces it.

`followRedirects:true` explicitly approves up to **three same-origin redirects** within **one ten-second total deadline**, not a fresh deadline at each hop. Credentials/transport can never move to a different origin, port or protocol. POST on 301/302, and non-HEAD on 303, become GET with body/content-type removed; 307/308 preserve the method/body and may replay an approved write to another path. The origin, not an endpoint path prefix, is the scope boundary. Redirect response bodies are omitted. Owner, live-handle identity and approved public CA source are rechecked at every hop and before publishing the response. Final response source/output bounds are unchanged. Returned URLs and headers are redacted/bounded; no cookie jar or ambient proxy is used.

An operator may configure HTTPS-only **secret-variable references**, never inline credentials:

```json
{
  "endpoints": { "secure": "https://127.0.0.1:8443" },
  "secretRefs": { "API_TOKEN": "LOCAL_API_TOKEN" },
  "endpointAuthRefs": { "secure": { "type": "bearer", "variable": "API_TOKEN" } }
}
```

Basic authentication uses `{ "type":"basic", "usernameVariable":"API_USER", "passwordVariable":"API_PASSWORD" }`, both declared in that target's `secretRefs`; the UTF-8 Basic header is privately derived and bounded to 8 KiB. Bearer tokens must be bounded valid bearer-header values. Credentials resolve only at approved app startup and remain private in its live handle. Authentication requires `authenticate:true` in the subsequent exact HTTP review. No HTTP (unencrypted) authentication, inline credential argument, URL userinfo, OAuth acquisition/refresh, imported cookie/session, client certificate or custom credential-header scheme is supported. Changing `.env` does not replace the live app's frozen credentials. Both literal secrets and the derived Basic header/base64 value are included in its startup redactor; arbitrary transformations/encodings remain outside this literal-redaction contract.

Both HTTP tools bind their normalized input and approved request to their **native tool task ID**. An `issued` marker is durably committed before dispatch. A completed response is durably recorded only after renewed native-owner/live-handle checks. Replay returns only that original bounded diagnostic response (`replayed:true`) or refuses an issued/uncertain operation; it never resends it or restores network/cleanup authority from a receipt. A lost response or crash can leave `issued` even when no request was sent, or after partial redirect-chain effects. This conservative fence is **not exactly-once server execution**. Inspect server-side effects before requesting a fresh operation and approval. `env_status` exposes up to 200 recent operation summaries without bodies, headers, credentials, query strings or response data; `issued` means pending-or-uncertain, never a dispatch/outcome assertion. The compatibility `env_http_get` also uses this issuance journal; even its diagnostic GET is not silently resent after an uncertain response.

Native disposable scenarios verify approved HTTPS writes and 307/303 behavior, dotenv rotation with frozen Basic/Bearer credentials, derived-credential redaction, refusal of caller credentials and foreign redirects, bounded redirect loops, per-hop CA-source fencing, a shared deadline across slow redirecting writes, and SIGKILL after dispatch followed by native replay with **one actual write request**, uncertain issuance and no saved-app adoption. The crash fixture self-terminates its own heartbeat when the host pipe closes; no saved PID cleanup is used. These are fixture-backed boundary checks, not live-system parity claims.

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
