## Context

Investigation baseline: branch `feat/agentic-coding-v2`, HEAD `c05a6c3c6a43f1af90c73d825ae25293faa6e384`, initially clean. Current checkout explicitly retained; no feature worktree. Only static source/declaration/manifest inspection and OpenSpec CLI are used in this phase. No integration was initialized. The originating request remains authoritative, including its approval boundary and preservation constraints.

### Current v2 integration points

- `src/runtime.ts:191-289` constructs one registry/Harness, selects four extensions and their explicit tools for the root, and configures persisted conversations. `orchestratorAgent` supplies the same surface to project orchestrators and interactive skill sessions; `NodeExecutionEnv` resolves conversation cwd, falling back to the configured repository.
- `src/skill-task.ts:35-91` separately assembles the same four extensions/tools when creating the task's child conversation **after** preparing its actual shared/worktree workspace. This is the second mandatory wiring point; changing root tools alone misses nested verifiers/fixers.
- `src/agent-tools.ts:37-50` uses native coding tools and leaves native unsafe shell replay unchanged. `src/orchestrators.ts` owns sibling conversations and retirement; `src/task-retention.ts` dismisses history and cancels owned task trees, not arbitrary lineage. Integration cleanup must follow these real identities.
- `src/cli.ts:136-145` calls normal `Runtime.open({resume:false})` for stopped-host cleanup. Merely putting integration startup before `resume()` would violate the maintenance contract.
- `scripts/build.ts` currently builds a JS CLI bundle and only externalizes OpenTUI. Codemode worker/WASM resolution is not yet handled. This is not a request for a new standalone executable distribution.

### Exact static public API evidence

All paths below are relative to `agentic-coding-v2/node_modules/@earendil-works/` unless identified otherwise. These declarations describe API support, not runtime acceptance.

| Evidence | Finding and consequence |
| --- | --- |
| `pi-durable/package.json`, `pi-coding-agent/package.json`, `pi-mcp/package.json`, `pi-codemode/package.json` | Actual local packages are **1.4.0**, matching v2's pinned Pi dependencies. Installed CLI is separately **1.5.2**, confirmed by reading `~/.pi/agent/install/current-version` and that release's package manifest, never running it. Do not mix the CLI installation into module resolution. |
| `pi-durable/package.json` exports `./codemode` and `./tool-search`; `dist/codemode/index.d.ts` | Public `createCodemodeExtension`, `createCodemodeTool`, native tool name and details; public native tool-search extension exists. No new Pi version is needed merely to enable native codemode. |
| `pi-durable/dist/codemode/codemode.d.ts` | `createCodemodeExtension({sandbox,namespaces?,inlineBudget?,models?})`. Module version 2 documents deterministic VM replay, journal delivery order, fingerprints, keyed child calls and divergence refusal. Interrupted child calls retain their **own** replay policy, not exactly-once external effects. |
| `pi-durable/dist/codemode/codemode.js:93,118,683,758` | Native `searchTools`, `describeTool`, `describeNamespace`; deferred tools omitted from inline declarations but searchable; nested calls use `api.executeTool(...,{key:c<id>})`. Do not replace these with text-only imitation discovery or direct callback execution. |
| `pi-codemode/dist/index.d.ts`, `dist/types.d.ts` | Public `CodemodeSandbox`, `loadQuickJSWasm`; sandbox options `wasm`, `workerUrl`, `acquireWorker`, `onWorkerStarted`. `pi-codemode/package.json` exports `./worker`. Worker capacity must be released on actual exit, not merely result settlement. |
| `pi-durable/dist/harness/types.d.ts:155-270` | Public invocation-bound `ToolExecutionApi`: `conversationId`, `callId`, `env`, `agent`, `executeTool`, details/output/diagnostics; `ToolRegistration` has `replay` (default unsafe), `callers`, `deferred`, `structuredOutputSchema`, limits and argument preparation. Nested execution validates, runs hooks, applies replay/limits and reports native progress. |
| Same file `:320-348,784-825` | Registry snapshots/publications/subscriptions; generation `beforeRequest`/`afterTools` and tool `beforeTool`/`afterTool` hooks. Publication wakes scheduler but is **not** by itself conversation tool selection. Conversation configuration must reconcile explicit tools too. |
| `chord/dist/context/index.d.ts` | Public `Context.abortSignal` and cancellation derivation; propagate the actual call context rather than background context for invocation effects. |
| `pi-mcp/dist/index.d.ts`, `dist/client.d.ts` | Public `McpClient`, `StdioTransport`, `StreamableHttpTransport`, `connect`, `listTools`, `callTool`, `onNotification`, `onClose`, `close`; request options include signal/progress. Direct clients need no Pi agent session. |
| `pi-coding-agent/dist/index.d.ts:7-22,32-33` | Root exports `getAgentDir`, `createEventBus`, `createExtensionRuntime`, `discoverAndLoadExtensions`, `DefaultResourceLoader`, `DefaultPackageManager`, `SettingsManager`, extension types, `ExtensionRunner`, `createMcpExtension`; **not** `loadExtensions`, `loadExtensionFromFactory`, `loadMcpConfig`, `validateMcpServerConfig` or `getMcpToolExposure`. File existence and barrel re-exports deeper inside `dist` are not package public exports. |
| `pi-coding-agent/package.json` | Only `.` and `./rpc-entry` are exported. No sanctioned deep-import loader/config entrypoint. `ExtensionRunner` constructor requires a `SessionManager` and `ModelRegistry`; do not manufacture a session just to satisfy it. |
| `pi-coding-agent/dist/core/extensions/loader.js:666-703` | Root-public `discoverAndLoadExtensions` always discovers `cwd/.pi/extensions` before global/configured entries and has no user-only switch/runtime injection argument. Calling it with an invented cwd is not a valid way to claim actual conversation initialization context. |
| `pi-coding-agent/dist/core/resource-loader.js:356-413`; `core/package-manager.js:704-744,1000-1060` | Public resource loader calls `packageManager.resolve()` without missing-source policy. Missing package resolution defaults to install. Public `DefaultPackageManager.resolve(onMissing)` can skip missing sources, but the loader has no injected package-manager option. Filtering **after loading** is too late to prevent extension side effects. |
| `pi-coding-agent/dist/core/settings-manager.d.ts` | Public `SettingsManager.fromStorage` and `inMemory` allow read-only/in-memory semantics; file-backed create/setters must not be assumed read-only. Read global settings only and never persist migrations or write credentials. |
| `pi-coding-agent/dist/config.js` | Public `getAgentDir()` uses nonempty `PI_CODING_AGENT_DIR` with tilde expansion, otherwise `~/.pi/agent`; use the supported function, not v1's independently trimmed interpretation. |
| `pi-coding-agent/dist/core/extensions/types.d.ts:395,473-495,1600-1634` | All five exposures, output schema, default activation, exported runtime state including `mcpServers`; registry has `setChangeListener`, `list`, register/unregister. Public runtime actions include `refreshTools`. Suitable event sources exist without sleeps or recreation. |
| Installed 1.5.2 `pi-coding-agent/dist/index.d.ts` and package exports, statically diffed against 1.4.0 | Same missing loader/MCP config exports; loader declarations unchanged. Added UI/markdown types do not provide safe headless lifecycle support. **Upgrading coding-agent to 1.5.2 is not a solution to this blocker.** |
| Installed 1.5.2 `pi-mcp/dist/index.d.ts`, `dist/config.d.ts` | Adds public config validation, MCP naming, input-schema normalization and content-limiting helpers. Config adds `clientRegistration: auto`; pinned Pi's MCP config type only accepts `dcr`/`cimd`. Shared validation does not load Pi's exposure policy or existing auth storage. |

### V1 lessons, not dependencies

Read `agentic-coding/src/agent-host/{pi-tool-bridge,codemode,codemode-assets}.ts`, `src/workflow/pi-tools.ts`, and `test/agent-host-pi-tool-bridge.test.ts`. V1's codemode uses native extension plus explicit assets: retain the concept, not imports or projection code. Its bridge calls `createAgentSession` (around lines 418-510), holds a Pi session per owner and has startup waiting; none is permissible in v2. Its workflow global-tool selection makes codemode optional and enforces capability distinctions: also not this contract. Its tests demonstrate useful cases (bounds, errors, images, cancellation-resistant shutdown, native collisions, late schemas/removals), but restrictive allow rules, session setup, timing assumptions and broad UI rejection must not be copied. Existing main specs describe those v1 contracts, so use a separately scoped v2 capability.

## Goals / Non-Goals

**Goals:** Mandatory native codemode and native discovery for all durable agents; identical capability surface independent of reviewer role; direct MCP and compatible trusted extension tools; actual context/native executor; safe replay, live catalog evolution, sanitized diagnostics and deterministic isolated tests in source/bundle.

**Non-Goals:** A Pi session/process, extra model or second runtime; importing/delegating to v1; full emulation of Pi UI/session/model/provider APIs; implicit project config trust; automatic package install/update/auth/login; modifying real integration config/credentials; live acceptance without separate approval. Standalone explicit no-tools chat is unchanged. No web changes, manual embedded generation, docs recreation, unrelated fixes or default tmux manipulation.

## Decisions

### 1. Public API gate before implementation

Native codemode and direct clients work at 1.4.0. Full user-config loading does **not** yet have a demonstrated single safe public composition meeting every constraint. Treat this as a blocker, not license to deep-import internals, silently upgrade or invent an incompatible config stack.

Recommended route: obtain supported public user-only, no-install resource resolution/loading with actual cwd and injectable runtime; and supported Pi MCP config/auth read access. An approved upstream release/export addition is preferable to maintaining a duplicate extension loader. Recheck existing public package-manager + extension-loading composition first; if a side-effect-free solution is demonstrated, retain 1.4.0 and document it in call-site tests/comments. Otherwise return the exact proposed package/version/API changes for developer approval before touching dependencies. 1.5.2 pi-mcp's public validator is useful but insufficient to promise all Pi behavior; upgrading only it may avoid broad churn, but requires compatibility proof and approval.

Until resolved, no claim of complete compatibility, and do not mark unsupported configured integrations as absent. A locally authored parser for `mcp.json` with explicitly bounded supported fields is an alternative **requiring developer agreement**, not an assumed substitute for requested supported primitives. Never run `!cmd` credential resolvers implicitly; diagnose them unless a supported, separately approved policy exists. Read-only auth cannot silently refresh/write tokens or launch login: usable read-only credentials or a visible auth-required limitation only.

### 2. One durable tool-surface composition

One v2 assembly policy supplies native coding/delegation/environment tools, codemode, native tool search, and the owning conversation's imported extension. Use this at root/persisted orchestrator reconciliation, project/interactive session creation, and task child configuration after workspace preparation. No role-based capability filtering. Persist names/configuration through supported configure commits; do not capture another conversation's mutable tool list. Keep registry install separate from per-conversation selection.

Use native `createCodemodeExtension` and `CodemodeSandbox`. Set `models:false` so optional codemode model helpers cannot introduce additional model requests. Discovery/tool execution are still native. Host wrappers may supply assets, limits and ownership, never replace QuickJS, replay/journaling or native `executeTool`.

### 3. Per-conversation integration owner

```
one Harness / public registry
  -> durable conversation (actual cwd + configuration generation)
      -> isolated owner: extension runtime/event bus + direct MCP clients
      -> selected imported registrations + native codemode/search
      -> ToolExecutionApi.executeTool -> native nested task lifecycle
```

Owners are acquired only for integration-capable live durable work; no empty/disabled config process/network effects. User Pi dir is resolved once through the public primitive; project-local configuration remains untrusted. Config/credentials are references to existing read-only storage, never serialized into catalog/transcript. Runtime artifacts go under v2 state. No global process.chdir/env mutation. Do not use global cached extension instances shared across conversations.

The adapter inspects returned public extension registrations. UI renderers/commands/shortcuts alone produce headless-unavailable diagnostics without blanket rejection of otherwise independent tools. Support lifecycle start/shutdown against honest owner creation/disposal. Session-manager/provider/prompt-transform/safety hooks must either be faithfully mapped to native semantics (including nested calls) with tests or disable dependent extension tools and explain why. For initial scope, reject extensions with unsupported safety/session hooks conservatively; do not simply omit the hooks. Throwing unsupported runtime methods and disabling the source on use are necessary but not a claim that arbitrary JS dependencies can be statically discovered. Extensions are trusted executable code; their arbitrary import-time side effects are not sandboxed or rolled back.

Execute tools with native call id, current cwd and cancellation signal; supported `ctx.executeTool` maps to the invocation's native executor, with name mapping and bounded depth/count. No callback shortcut around native validation/hooks/replay. Do not fabricate a sessionManager, model registry or affirmative UI answers.

### 4. Exposure and identity

| Imported exposure | Durable mapping |
| --- | --- |
| direct | model + tools callers, normal declaration |
| deferred | model + tools callers, `deferred:true`, native search activation |
| codemode | tools callers only; native codemode discovery/invocation |
| model-only | model callers only, excluded from script-callable discovery |
| hidden | no model/tools callers; not discoverable/invocable |

Honor activation and exposure independently; reconcile removals and defaultActive semantics, never just append tools. MCP normally supplies four exposures; model-only comes from extension tools. Native names always win. Use deterministic source-kind + stable canonical source identity + original tool identity mapping with a bounded digest suffix; normalization collisions (hyphen/underscore etc.) must not depend on registration order. Check codemode JS identifiers too. Preserve forward/reverse mapping for nested extension calls and diagnostics, without leaking absolute private paths/endpoints or credential-bearing names. Unsupported/invalid schemas remain unavailable visibly.

### 5. Event-driven catalog publication

Subscribe to extension `runtime.mcpServers.setChangeListener`, runtime tool-refresh notifications and MCP `notifications/tools/list_changed`; coalesce synchronous batches by microtask, not sleep/polling. Asynchronous events carry owner/generation tokens and cannot resurrect disposed owners. Re-list schemas through the existing client, no connection/session recreation. Maintain desired and applied generations.

Publish a coherent owner-scoped registry extension **and** configure its owning conversation at a supported safe boundary before its next model/tool round. Freeze schemas/exposure for in-flight native calls/codemode start snapshots; defer replacement/removal until affected work settles. An already-running script retains its original native discovery snapshot; the next script in the **same conversation** sees the applied catalog. Use public task/conversation watches and generation hooks as needed; prove ordering with controllable barriers, especially publication between tool result and next generation. Do not claim a registry install alone updates explicit conversation tool lists. If public APIs cannot establish this boundary, stop at the API gate rather than modify private scheduler state.

### 6. Replay, results and resource limits

Every imported tool starts with `replay:unsafe`, irrespective of remote read-only/idempotence annotations or names. A proven pure operation needs a separate reviewed classification to become safe. Native codemode remains replay-safe for VM recovery; its unsafe nested calls remain unsafe. Restart ambiguity must refuse/retain an interrupted result, never resend a remote request to complete the script. Stored completed results may be replayed natively.

Map text/images, output schemas + structured content, details, error flags and bounded progress explicitly; preserve structured errors and reject late success after cancellation. Missing or unsupported content yields a visible bounded diagnostic, not silent empty success. Bound traversal before serialization, including array entries/depth/nodes/base64 images. Initial proposed budgets: 32 owners, 16 MCP connections per owner and 64 host-wide, 256 accepted tools per owner, 64 nested adapter calls and depth 8, 32 progress updates/16 KiB text, 64 KiB result content and 24 KiB details, 256 container/content entries, depth 8/1024 traversal nodes, 4 active QuickJS workers with actual-exit accounting. Bound diagnostic count (32 per owner), item length (512 chars), and retained bytes (16 KiB); stable failure classes rather than raw exceptions, env, commands, headers or URLs. Admission returns explicit capacity errors, never evicts active work. Confirm limits in unit tests; do not inflate deadlines to make tests pass.

On task completion/cancel/removal, conversation closure and host shutdown: fence owner, unsubscribe, abort and join owned calls, close clients/transports, emit supported shutdown once, invalidate runtime and remove selected registrations. Idle owner eviction only; never silently detach a trusted callback that ignores abort. Uncooperative trusted code can delay shutdown; report accurately rather than claim sandbox guarantees. Late results/events cannot publish or turn aborted calls into success.

### 7. Integration-inert maintenance and build assets

Introduce an explicit maintenance/open mode distinct from merely `resume:false`; do not acquire owners, invoke extension loaders, connect MCP, execute extension code, start workers or resume agents for stopped-host `--clear-finished-tasks`. Prefer lazy imports/acquisition as well; test the actual CLI path. Preserve native history/admission fences and unrelated conversations.

Resolve WASM and worker through supported package assets. Source execution must work without prebuilt dist; bundle build emits/copies a worker entry importing the public `/worker` API and resolves WASM relative to the bundle, with no v1 import or source-tree fallback. Match the current JS-bundle distribution rather than copy v1 compiled-binary `$bunfs` assumptions. Assert asset presence and run a synthetic bundled codemode call with fake model and isolated config/state.

## Risks / Trade-offs

- [Public loading/auth gaps] → Explicit blocking decision before coding/dependency edits; no silent claim that CLI 1.5.2 fixes them.
- [Trusted extensions can execute arbitrary code at import] → Honest trust disclosure, temp synthetic-only acceptance, no claim of malicious-code containment.
- [Unsupported session/safety dependencies] → Fail dependent tools closed, preserve independent UI-bearing tools where provable, sanitized actionable diagnostics.
- [Shared registry leaks or schema races] → Owner-specific selection, immutable in-flight snapshots, safe-boundary commits and generation guards with barrier-driven concurrency tests.
- [Native replay is not external exactly-once] → Unsafe defaults including nested calls and explicit restart refusal tests.
- [Credential freshness requires writes/network] → Read-only limitations visible; never refresh/login implicitly.
- [Bundle loaders/workers resolve package-relative files differently] → Independent source and bundle fixtures; no real integration initialization as a shortcut.

## Migration Plan

Proposal phase modifies OpenSpec only. After developer approves both plan and any dependency/API decision: unit-first batches (native surface/assets; inert owner/config layer; adapters; catalog reconciliation/lifecycle; source/bundle acceptance). Existing state is reconciled at normal safe startup/turn boundaries; standalone chat remains unchanged. Do not start integrations from maintenance migrations. On incompatibility, retain native codemode and expose explicit integration failure diagnostics rather than execute a partial unsafe bridge. Rollback restores prior code/dependency pins; no copied credential store or live integration state needs migration. No deployment, host restart, merge or push is authorized.

After an approved implementation batch run unfiltered from v2: `bun run type-check`, `bun run lint`, `bun scripts/build.ts`; run the full suite and report measured duration and failures together. Do not run these during the proposal as a pretext to initialize real integrations. Tests use temporary isolated HOME/Pi/config/state, fake models, synthetic extensions and local mock MCP only; no real extensions/services. Unit tests use explicit events/barriers, not deadline sleeps, polling or timeout inflation.

Independent verification coordinator must establish the actual feature base/diff, assign each reviewer an explicit relevant changed-file list and diff, reject preexisting/unrelated/preference findings before fixes, and refresh assignments after fixes. Preserve unrelated work. Keep decisions in call-site comments, tests, OpenSpec and commits, not recreated docs. Tabs, Biome zero and no non-null assertions. Never overwrite `test/telemetry.test.ts` or unrelated target/discovery tests. No default tmux manipulation; if necessary, only a dedicated unique socket. Real `~/.config/agentic-coding-v2`, `~/.config/agentic-coding`, `~/.pi/agent` are read-only; never output secrets or `.env` contents. Authorized delegation uses `copilot-sol` and this shared checkout, never another worktree. Current tool catalog does not list this repository for background-task admission: resolve that configuration if delegation is needed rather than substitute a different repository.

## Approved dependency upgrade and compatibility evidence

After proposal review, the developer directed: “You should upgrade to 1.5.2 before implementation.” Applied only the four existing direct chord/pi-ai/pi-coding-agent/pi-durable pins and bun.lock using `bun update --no-env-file --ignore-scripts --exact` with explicit 1.5.2 package versions. Local pi-codemode and pi-mcp also resolve to 1.5.2. Earlier 1.4.0 evidence above is historical comparison, not the current implementation baseline. No feature or compatibility application code has been changed.

Unfiltered post-upgrade checks: `bun run lint` passed (773 files, no fixes). `bun run type-check` failed with seven diagnostics: activity.ts compares removed task status ready; environment/operator-task.ts and reviews.ts consume watch values rather than WatchCall envelopes; environment/tools.ts and reviews.ts import Context from the chord root; server/client/watch.ts imports removed watchEvents; promotion-uncertainty.test.ts calls an API with two arguments where three are required. `bun scripts/build.ts` failed on the removed watchEvents export. These are concrete upgrade compatibility blockers to migrate under implementation approval, not reasons to revert or silently broaden scope. Full tests have not run in this dependency-only phase; isolated execution safety remains required.

The dependency upgrade is authorized and complete; the public-only loading strategy and feature implementation approval remain open. No real integration initialization, lifecycle scripts, host restart, merge or push occurred.

## Open Questions

1. Approve an upstream public loading/config/auth API addition (recommended), or require a demonstrated safe composition on the now-approved 1.5.2 before feature implementation? Exact release/version is not established by this static investigation; do not guess or silently upgrade. Installed 1.5.2 is specifically insufficient for the loader gate.
2. If upstream support is unavailable, would an explicitly scoped host-owned MCP parser and compatible extension loader boundary be acceptable? This changes the supported-primitives strategy and needs a revised design/approval, not unilateral fallback.

Both questions are gates, not permission to start implementation. No live compatibility claim is made. Separately approved real-service acceptance would still be needed later for actual installed extensions/auth flows; isolated acceptance cannot certify arbitrary trusted user code.

## Apply-session public API gate decision (task 3788)

Implementation approval is now explicit ("Good. Lets go"); this does not authorize private imports, a replacement loader/parser, upstream edits or another dependency upgrade. Entry HEAD is actually `87bda0743a1f1e90f3c379b32ceb711ad694f6f6`, not the original feature baseline. That commit already implements the seven compatibility fixes and records type-check/lint/build passing and 265 tests passing, zero failures, 1822 assertions, 67 files, 15.92 seconds. This session independently ran unfiltered `bun run type-check` from v2: exit 0. No application edits or implementation batch occurred here; lint/build/full suite were not rerun. Intervening queued-input and repository-admission work must not be attributed to this feature or reverted. Review must partition the baseline-to-HEAD diff, not treat every changed file as feature-owned.

Static inspection of the locally resolved **1.5.2** declarations, exports and implementation confirms the gate remains unresolved:

- Package `exports` still exposes only `.` and `./rpc-entry`. The root exports `discoverAndLoadExtensions` but not `loadExtensions` or `loadExtensionFromFactory`. The public discovery implementation unconditionally includes actual-cwd `.pi/extensions` before global/configured entries. Supplying another cwd violates the initialization-context contract.
- `DefaultResourceLoader` does have project-trust handling (`loadProjectTrustExtensions`/`resolveProjectTrust`), so project exclusion alone is not the reason to reject that route. It still constructs its own private package manager and calls `resolve()` without a missing-source policy. Its public options have neither package-manager injection nor no-install resolution; filtering in `extensionsOverride` occurs too late. Public `DefaultPackageManager.resolve(onMissing)` cannot be composed with a public explicit-path extension loader because the latter is not exported.
- Root-public `SettingsManager.fromStorage`/`inMemory`, `getAgentDir`, `createEventBus` and `createExtensionRuntime` are useful building blocks, not a complete loader. `loadMcpConfig` and `getMcpToolExposure` remain internal exports despite root-exported MCP types. The public pi-mcp validator does not supply Pi's file selection/exposure policy.
- Root-public `readStoredCredential` provides a read-only primitive for stored provider credentials; it must not be misrepresented as wholly absent. It does not by itself establish Pi MCP OAuth storage/config composition or authorize command resolution, token refresh, login or writes. No auth initialization was used to investigate.

### Exact consequential decision requested

Recommended: approve seeking an upstream **public API contract**, with no upstream edit/install authorized yet. Minimum contract to unblock a composition:

1. Publicly export the existing explicit-path `loadExtensions(paths, actualCwd, eventBus, runtime)` (and factory variant if required), so user-scoped paths resolved through a read-only SettingsManager and `DefaultPackageManager.resolve(() => "skip")` can load without automatic cwd discovery. Confirm package resolution itself makes no writes or installer effects under this policy; otherwise add an explicit read-only/user-only resolution mode and v2-owned cache location. Loader must accept the isolated runtime, retain real cwd and avoid hidden sessions/model initialization.
2. Publicly export Pi's existing `loadMcpConfig({agentDir,cwd,projectTrusted:false})` and exposure helper with documented read-only/no-command semantics. If current implementations resolve commands or mutate state, provide a read-only mode returning unsupported diagnostics instead.
3. Provide a public read-only MCP credential lookup for existing OAuth storage (or document an existing supported one), returning usable stored credentials or auth-required without refresh/login/command execution/token persistence. Provider references can use `readStoredCredential` subject to the same policy; no credential duplication.

No release containing this contract has been established. A concrete version, dependency diff and acceptance evidence must be separately reviewed **before installation**, and no upstream modification is requested by this document. Merely exporting a symbol does not prove all side-effect guarantees above; synthetic tests must verify them before feature wiring.

Alternative, only by explicit revised-design approval: permit a host-owned bounded config/extension-loader compatibility implementation, accepting ownership of Pi semantic drift and credential-policy limitations. This is a material departure from supported-primitives requirements, not an automatic fallback. Another possible separately scoped batch is native codemode/assets alone while the integration gate remains open; it would not complete this change.

Task 1.2 remains unchecked. Feature implementation is paused; no integration initialized, no private import, dependency edit, real config read/write, model/MCP request, host restart, merge, push or archive occurred in this session. Live acceptance remains separately authorized and cannot be claimed from static evidence or fake-backed tests.

## Successor task 3858 — fresh static gate re-evaluation

**Outcome: BLOCKED at task 1.2; 3/29 tasks remain complete.** The retry request authorizes re-evaluation, not a bypass of the supported-primitives gate. No feature implementation batch was made.

Fresh checkout inspection confirms branch `feat/agentic-coding-v2`, HEAD `87bda0743a1f1e90f3c379b32ceb711ad694f6f6`, no tracked working-tree edits, and only this untracked OpenSpec change directory. The baseline-to-HEAD range contains unrelated `b5068a8` (queued input previews) and `c2d48b6` (custom-workspace delegation admission). Do not attribute or revert those changes. The upgrade/compatibility scope is the nine-file diff `87bda074^..87bda074`: `bun.lock`, `package.json`, `src/activity.ts`, `src/environment/operator-task.ts`, `src/environment/tools.ts`, `src/reviews.ts`, `src/server/client/watch.ts`, `test/context-progress.test.ts`, and `test/promotion-uncertainty.test.ts`, all under v2. The context-progress/watch changes also exercise queued-input behavior; review their precise hunks rather than assuming exclusive feature ownership.

Fresh static reads of the locally resolved packages (not the installed CLI and without importing or initializing any integration) confirm pi-coding-agent, pi-durable, pi-codemode and pi-mcp are 1.5.2. Evidence paths below are under `agentic-coding-v2/node_modules/@earendil-works/`:

- `pi-coding-agent/package.json` exports only root and `./rpc-entry`; `dist/index.d.ts` does not export explicit-path `loadExtensions`, factory loading, `loadMcpConfig` or `getMcpToolExposure`.
- `pi-coding-agent/dist/core/extensions/loader.js:672-708` unconditionally discovers actual-cwd `.pi/extensions`, then global/configured entries. Its public declaration has no user-only selection or runtime-injection parameter. Internal explicit-path loading has runtime injection but is not a public package API.
- `pi-coding-agent/dist/core/resource-loader.d.ts` has no package-manager injection/no-install option; implementation `:266` constructs its own manager and `:383` and `:512` call `resolve()` without policy. Project-trust support at `:363-380` is real, but does not remove this install-policy gap.
- `pi-coding-agent/dist/core/package-manager.js:1113-1135` calls installation for missing sources unless offline or an explicit callback skips/errors. Public `DefaultPackageManager.resolve(onMissing)` therefore helps resolution, but cannot compose with the unexported explicit loader. `PI_OFFLINE` exists (`:38-40`) but is process-global; changing global environment violates owner isolation and does not provide missing public loading/config APIs. No environment mutation was attempted.
- `pi-coding-agent/dist/extensions/mcp/config.d.ts` declares user/project selection and exposure helpers internally; its implementation `:103-115` reads selected files. These are not root public exports. `pi-mcp/dist/index.d.ts` exports validation/client/transports, not Pi file selection/exposure semantics or Pi MCP credential storage.
- Root-public `readStoredCredential` is genuinely read-only according to `dist/core/auth-storage.d.ts:66-70`, without resolving configured values. It is not evidence that MCP OAuth lookup/refresh policy is solved. Do not describe all credential primitives as absent.
- `pi-durable/dist/codemode/index.d.ts` exports native codemode and `codemode.d.ts:163-172` supports disabling model helpers. Native codemode is not itself the blocker; it does not solve required integration loading.

**Decision needed:** approve pursuing the public upstream contract specified in the task-3788 section above (explicit-path/runtime-injected user-only loading with read-only/no-install resolution; public Pi MCP config/exposure access; documented read-only MCP credential access). No release containing that contract is established, so no exact new version or install is proposed as if known. Any release/dependency change still needs separate approval and isolated proof. Alternatively explicitly revise the design to permit a host-owned loader/parser, or separately scope a native-codemode/assets-only batch. Neither alternative is assumed approved by a retry or the existing 1.5.2 approval.

This session performed static repository/package inspection and OpenSpec status/instructions only. No tests/type-check/lint/build were rerun: there was no application implementation batch, and previous commit/test claims remain historical evidence, not fresh verification. No real config/credential reads, integration initialization, extension execution, model/MCP requests, installs, private runtime imports, branch/worktree creation, host restart, merge, push or archive occurred. All feature and acceptance checkboxes remain honestly pending. Live compatibility acceptance remains separately authorized.
