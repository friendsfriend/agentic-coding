## 0. Standalone package foundation

- [x] 0.1 Create independent `environment-mcp/` package with its own dependencies/lock, fresh composition, CLI, build, TypeScript and Biome gates; no v1/v2 or coding-harness imports.
- [x] 0.2 Define a strict versioned environment-native configuration and separate read-only v2 catalog adapter; retain bounded input/output and explicit repository authority.
- [x] 0.3 Copy/adapt v1 shared/external/owned lifecycle decision rules with provenance and direct functional tests; advertise only inspection tools until mutation authority is implemented.
- [x] 0.4 Verify real stdio MCP against a built artifact copied outside the checkout, independent install/build/type/lint/test gates, and document supported/deferred surfaces without changing active OpenCode bindings.
- [x] 0.5 Refactor package/module/symbol naming around standalone MCP boundaries without changing existing CLI or tool behavior; verify the refactor before adding functionality.

## 1. Establish the v1 reference

- [x] 1.1 Trace v1 build/start/stop, target/profile selection, shared/external/owned dependencies, readiness and network resolution; record a source-backed MCP parity matrix and the smallest reusable service boundary.
- [x] 1.2 Trace the actual installer-space Mocked configuration and existing PostgreSQL mapping without disclosing secrets; select the integration seam and record authority/state compatibility before runtime changes.

## 2. Implement shared dependency semantics

- [x] 2.1 Add configured shared/external identity and connectivity descriptors through the selected existing environment boundary, keeping operator configuration distinct from model intent.
- [x] 2.2 Resolve/freeze readiness and network bindings for exact approval; revalidate before startup and refuse replacement, ambiguity or inspection failure without duplicate creation.
- [x] 2.3 Implement shared already-running reuse and readiness-only external behavior; retain owned-only cleanup authority and prevent stop/cancel/expiry from touching borrowed services/data.
- [x] 2.4 Expose the resulting v1-compatible start/build/test/status/log/stop behavior through MCP with authenticated scope/issuance fences and explicit retained wait/result semantics.

## 3. Verify and try the requested application

- [x] 3.1 Add direct selection/identity/lifecycle rule tests and one lightweight public-boundary scenario covering reuse, refusal and shared-resource preservation; retain the full-suite before/after cost baseline.
- [x] 3.2 Supersede the old pending installer-space plans, present the new exact plans for approval, and exercise the user-requested Mocked build/start/log/readiness flow only after approval; record live results and any real blocker honestly.
- [x] 3.3 Update setup/parity/lifecycle documentation, run both packages' lint and whole-project type gates, the unfiltered v2 suite and strict OpenSpec validation; record verification limits without claiming unsupported runtime parity.
- [x] 3.4 Add one capability registry with MCP and server-independent OpenTUI entry points, plus an architecture parity test; document standalone/OpenCode UI injection.
- [x] 3.5 Implement the authenticated capability/UI transport and standalone OpenTUI, verify the real list/invoke path in a PTY, and add endpoint/health readiness plus file/env build-secret resolution.
- [x] 3.6 Add a separate operator OpenTUI for exact inspect/approve/reject and recovery acknowledgement, plus an operator-only acknowledgement route; verify the approval flow in a PTY and keep the surface out of the agent capability registry.
- [x] 3.7 Add a tested stdio-to-authenticated-HTTP MCP bridge for local host cutover without creating a second environment authority; document the OpenCode config and leave the existing entries unchanged pending explicit approval.
- [x] 3.8 Add bounded per-scope operation history and in-memory redacted log retention after stop, with agent/UI capability parity and direct tests.
- [x] 3.9 Add safe journal scope retention at capacity: evict only the oldest inactive scope with no owned resources, live review/issuance or inspection-required uncertainty; refuse otherwise.
- [x] 3.10 Add opt-in idle cleanup that stops only owned apps after capability inactivity, exempts busy clients, preserves borrowed resources and retains failed cleanup for retry; document that scope closure/rebinding is still pending.
- [x] 3.11 Add owned shell-process run targets with detached process groups, optional readyText/readyUrl, owned-ledger stop/logs, graceful shutdown cleanup and no restart adoption; test the real process adapter and service ledger path.
- [x] 3.12 Keep unsupported targets visible with a sanitized executionIssue code and record the real v2 container-name-prefix migration count without changing the user configuration.
- [x] 3.13 Supervise shell process groups so a controller crash kills the group, without adopting saved PIDs; test parent-death cleanup.
- [x] 3.14 Add a private bounded diagnostics event log with allowlisted fields, rotation and an operator-only tail route; exclude credentials, plans and tool arguments.
- [x] 3.15 Add a read-only configuration doctor with executable counts, sanitized executionIssue hints and no credentials/plans/paths.
- [x] 3.16 Migrate the real v2 Compose container names to the environment-mcp group with backups, add declared installer-space envRefs/.env inputs, start the standalone shared service, and cut over the scoped OpenCode entry through the stdio bridge.
- [x] 3.17 Add Podman build/compose providers and provider-specific single-container run support, with argv/fake-runtime tests and no live Podman claim.
- [x] 3.18 Implement controller-wide shared-service records and leases: explicit infrastructure start mapping, identity verification on successful start, cross-scope dependent leases, owner-stop refusal and scope-close release.
- [x] 3.19 Add native shell OTLP/HTTP JSON telemetry capture with bounded redaction, process environment injection and an env_telemetry read capability; verify the MCP surface through the live OpenCode bridge.
- [x] 3.20 Merge Compose service x-secret-refs and target secretRefs into declared execution references with conflict refusal, and automatically stop shared services on the last lease release.
- [x] 3.21 Inject Compose service secret references through a private override, add v2 TLS host-gateway collector telemetry with an ephemeral certificate, and verify the exact collector shape is executable.
- [x] 3.22 Render bounded telemetry summaries and trace trees in the shared OpenTUI result view without adding a UI-only action or bypassing the capability registry.
- [x] 3.23 Add safe Kubernetes helm-release-v1 execution: optional clusters.json/default devenv connection, bounded frozen chart digest, offline namespaced-manifest validation, fresh install, deployment readiness and exact revision/label uninstall; prove offline renders and fake-binary paths without claiming a live cluster.
- [x] 3.24 Add multi-repository client authority: one token binds several canonical scopes, explicit/unique-app routing, ambiguous refusal, repository filters for status/history and partitioned cleanup, then cut OpenCode over to the single all-repository client.
- [x] 3.25 Add network-only Compose bridge execution and label-verified networkFrom member attachment with empty-only cleanup, deterministic names and member-before-network shutdown ordering; reach 117/117 executable descriptors.
- [x] 3.26 Expose v2 target prerequisites, refuse networkFrom admission before the exact bridge exists, and report declared secret-reference gaps in the doctor without values.
- [x] 3.27 Auto-start approved network-only prerequisites during member dispatch when the bridge is absent, borrow an existing labelled bridge, and retain empty-only member cleanup.
- [x] 3.28 Close clean idle repository scopes after owned cleanup, retain historical scope reads, and lazily reopen a fresh scope only for execution actions; keep busy/pending/inspection work open.
- [x] 3.29 Add container-run TLS host-gateway telemetry with standard OTEL injection and CA mount, plus a selectable OpenTUI trace browser using the existing env_telemetry capability.
- [x] 3.30 Perform disposable live Docker network/Compose verification: create an owned bridge, start a temporary Compose Redis service, attach the exact container, refuse removal while attached, and remove all resources.
- [x] 3.31 Perform a disposable live Compose OpenTelemetry collector verification with synthetic OTLP JSON, generated TLS receiver configuration and complete cleanup.
- [x] 3.32 Refuse executable admission when a declared secret reference is absent, before human review, without exposing the missing value.
- [x] 3.33 Perform a disposable live kind/Helm verification: install a tiny chart, wait for Deployment availability, uninstall the exact release, and delete the cluster; fix Helm v4 list compatibility and extend readiness budget.
- [x] 3.34 Add the known local Redis/Postgres/portal values to the private v2 `.env` with a backup, without modifying existing databases; leave external Eon/grid/hwportal/EFIX credentials unresolved.
- [x] 3.35 Perform a disposable live Podman network/container verification with a locally loaded image, attached-container removal refusal and full cleanup; stop the machine afterward.
- [x] 3.36 Perform disposable live Podman build and Compose verification, fix podman-compose ps service-name incompatibility, and clean up images, containers and networks.
- [x] 3.37 Fill known local Eon MySQL/datasource, hwportal Postgres/API DB and grid mock values in the private v2 `.env`; retain only external EIV Jasypt/EFIX gaps.
- [x] 3.38 Exercise live idle scope closure and rebinding through the shared server: wait for the reaper, verify observation keeps the scope closed, then execute and verify a fresh active scope.
- [x] 3.39 Install, ready-wait and uninstall the real customer-external Helm chart on a disposable kind cluster using a local substitute image, dummy secret material and minimal CRDs; fix oversized install-output parsing by reading release metadata.
- [x] 3.40 Add a local OpenCode 2.0.22 TUI plugin over the existing authenticated capability HTTP API, with a searchable grouped list, schema forms, result/trace views, two-column help and footer parity; verify it live in a disposable TUI and install the global plugin symlink.
- [x] 3.41 Replace the OpenCode capability browser with an app-centric environment dashboard: Applications/Libraries/Infrastructure/History/Services tabs, application detail, target picker, exact-review operation view, owned logs/telemetry, keybind footer/help, and safe operation subject attribution.
- [x] 3.42 Remove the separate operator approval surface: `env_execute` admits and dispatches directly, `env_run`/`env_prepare_dependencies` and the operator API/UI/access file/listener are removed, new operations start ready and issue immediately, and UI/tests/docs reflect direct execution.
- [x] 3.43 Fix application filtering: Enter blurs the filter instead of opening, arrow keys move filtered results while the input is focused, and normal list navigation returns after blur.
- [x] 3.44 Open the environment dashboard as an in-session split panel with an `f` fullscreen toggle, auto-focus, focus-gated keymaps and a compact layout below 96 columns; keep the full-screen route as the fallback outside sessions.
- [x] 3.45 Add Docker-style build steps/logs to the environment panel: parse BuildKit output into ordered steps with status/duration/logs, add Info/Steps/Logs tabs and step navigation, and verify against real success and failure receipts.
- [x] 3.46 Stream live build output into the panel: expose bounded redacted `progress` deltas from `env_operation`, poll while issued, render steps/logs before settlement, auto-follow the running step, and remove the manual refresh hint.
- [x] 3.47 Show per-app run status and repository git state in the Applications table: add a read-only `env_git` capability with an authenticated repository allowlist, replace the repository/owned columns, and verify running/stopped plus clean/dirty/ahead/behind states live.
- [x] 3.48 Replace build/test/run words in the inventory target summary, detail target rows/defaults and target picker heading with compact glyphs (`⚒` build, `✓` test, `▶` run).
- [x] 3.49 Refresh scope status/history every 5s and repository git state every 10s while the inventory or application detail is open, pause off those views or when the panel closes, and show Git/Status in the application detail.
- [x] 3.50 Add an authenticated SSE invalidation stream for status/git/operation/services events, wire execution lifecycle emissions and repository filtering, reconnect with `Last-Event-ID` replay, and use 15s/30s reconciliation polling as fallback.
- [x] 3.51 Fix the SSE frame parser: heartbeat/comment frames skipped buffer advancement and caused a 100% CPU tight loop at the first 15s keepalive. Consume every frame, add a parser regression test, and verify idle panel CPU.
- [x] 3.52 Add read-only git change inspection: bounded `env_git_changes`/`env_git_diff` with app-relative paths, untracked-file diffs, binary/symlink/directory refusals, path-traversal validation, Changes/Diff views and keybinds.
- [x] 3.53 Add guarded git actions: branch/worktree listing, fetch, fast-forward-only pull, checkout, worktree add/remove with dirty/current/branch-in-use/path guards; add Git and Worktrees views and keep mutations out of read-only stdio mode.
- [x] 3.54 Add `<leader>g` Git-for-agent-cwd: session-scoped git capabilities outside the configured allowlist, session Git view without environment tabs, and close-back behavior.
- [x] 3.55 Add `/` branch filtering to the Git view with focus/blur/clear behavior, filtered arrow navigation, result counts, and footer/help entries.
- [x] 3.56 Style the Git view header like the environment shell: raised full-width bar, bold `git` title, current-branch status, branch/worktree counts, and the `/` filter row in the header.
- [x] 3.57 Finish git polish: editable new-branch worktree form with field focus and path suggestion, session-cwd changes/diff, and all/staged/worktree diff sides with a cycle key.
- [x] 3.58 Add safe branch deletion and remote management: `env_git_action` branch-delete/remote-add/remote-remove, sanitized `env_git_remotes`, Remotes view/add form, Git delete key, and guards for current/unmerged branches and invalid/existing remotes.
- [x] 3.59 Run supported targets from a linked worktree: validated shared git common directory, app-relative cwd mapping, repository-local program/arg and Docker build context rewriting, `worktree` execution intent/subject/UI, and explicit refusal for Compose/container/Helm targets.
- [x] 3.60 Add read-only provider access: v2 provider registry loading with token references, bounded/sanitized GitHub and GitLab repository, change, issue, pipeline and job capabilities, and Providers/Repositories/Changes/Issues/Pipelines/Jobs UI views with filtering and state cycling.
- [x] 3.61 Add provider read detail: change body/counts/timestamps, 100-file bounded patches, 100 versions, issue detail, 50 discussions, 64 KiB redacted job logs, and plugin detail/files/patch/discussions/issue/log views.
- [x] 3.62 Add scoped container stats: Docker/Podman stats adapter for owned and shared-service containers only, CPU/memory/network/PID projection, multi-repository aggregation, `env_container_stats`, and detail `m` stats view.
- [x] 3.63 Add read-only Kubernetes inspection: authorized cluster listing, fixed wide namespace resource reads through explicit context/kubeconfig, 128 KiB bound, `env_clusters`/`env_cluster_resources`, and `K` cluster/namespace/resources views.
- [x] 3.64 Add provider writes: preview-confirm intent digests, request-ID replay/conflict handling, durable bounded write receipts, change/issue comments, exact-head approval, pipeline retry/cancel, `env_provider_writes`, and plugin comment/approve/retry/cancel/receipt views.
- [x] 3.65 Add direct application provider navigation: resolve local git remotes to configured provider references, `env_provider_repository`, table `c`/`i` shortcuts for changes/issues, direct-to-table back behavior, and GitLab/GitHub remote matching tests.
- [x] 3.66 Add explicit provider token fallback via `--provider-env-file` (symlink-resolved private `.env`), launchd wiring to the environment `.env`, and enterprise CA trust for GitHub TLS; verify both providers report tokens and live issue/change reads.
- [x] 3.67 Fix stale provider detail selection: list Enter now opens the currently selected issue/change instead of reusing the previously loaded detail; refresh keeps the current detail explicitly.
- [x] 3.68 Fix application-table provider actions using the highlighted row: `i`/`c` no longer reuse the last opened application (`selectedAppId`); two-app fixture verified app-b opens repo-b issues after moving the table selection.
- [x] 3.69 Move provider change drill-down off fullscreen `f`: `d` opens changed files/diffs and `h` opens discussion history; clear list filters without resetting the selected provider so files/discussions stay on the correct provider.
- [x] 3.70 Improve provider detail UI: render change/issue Markdown with renderer-owned syntax styles, replace raw patch text with OpenTUI DiffRenderable (line numbers, signs, scroll), and render discussions as a Markdown timeline with system-event glyphs.
- [x] 3.71 Harden provider Markdown/diff styling against OpenTUI ResourceContext mismatch: renderer-owned style creation is wrapped and falls back to streamed host rendering instead of crashing `session.panel`.
- [x] 3.72 Improve list readability: two-line change/issue rows with branches/author or author/labels on the second line, and vertical scrollbars on the right of all scrollable lists when content overflows.
- [x] 3.73 Add app/target CRUD: digest-guarded preview-confirm configuration writes, atomic backups, full validation and refresh, app create/update/delete, target duplicate/shell-create/update/delete, profile labels, and OpenTUI forms.
- [x] 3.74 Complete provider read history: issue comment/note timeline, change version history UI, and a bounded 1 MiB provider JSON response limit for large issue pages.
- [x] 3.75 Add a continuous left timeline rail and typed event glyphs to discussion/issue history, plus commit glyphs and the rail to version history.
- [x] 3.76 Normalize provider HTML fragments to Markdown for change/issue descriptions, timeline notes and version messages, including entities, links, lists, code blocks, details and relative links.
- [x] 3.77 Add guarded provider merge, issue open/close and GitLab rebase writes with exact-head checks, preview-confirm, receipts and panel keys.
- [x] 3.78 Add `/issues` and `/changes` session commands that resolve the current repository remotes to a configured provider and open the requested list.
- [x] 3.79 Simplify plugin launch aliases: keep `/environment`, use `/git`, and keep only `/issues`/`/changes`; remove `/env`, `/git-actions`, `/git-cwd`, `/provider-issues` and `/provider-changes`.
- [x] 3.80 Add guarded provider unapprove, discussion reply/resolve, label, assignee and individual job retry writes with preview-confirm, exact heads where relevant and durable receipts.
- [x] 3.81 Bind Enter to preview in the provider write editor so comment, reply, label and assignee forms do not depend on input submit alone.
- [x] 3.82 Add `env_git_write` with preview-confirm digests for push, lightweight tag, branch rename, remote URL update, stage-all commit, stash, merge and rebase, including clean-worktree, current-branch and ref-name guards.
- [x] 3.83 Add Git write keys, a write view showing the exact target and digest, confirmation, result output and refresh of branches/worktrees/remotes after completion.
- [x] 3.84 Parse fixed Kubernetes resource listings into selectable structured items with status, readiness, restarts, containers and age instead of a raw table.
- [x] 3.85 Add bounded namespace events, single-resource describe and pod tail logs with panel views and keys, using only fixed read-only kubectl commands.
- [x] 3.86 Add tag and stash listing, annotated tag creation, tag deletion, and stash pop/apply/drop through preview-confirm writes.
- [x] 3.87 Add path staging and unstage-all/stage-all actions, and split commit into staged-only `commit` plus `commit-all`, with panel staging keys.
- [x] 3.88 Add force-with-lease push and rebase abort to guarded Git writes, with upstream/lease validation and panel keys.
