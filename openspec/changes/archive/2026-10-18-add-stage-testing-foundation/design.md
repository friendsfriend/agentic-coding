## Developer decisions (answered after plan approval)

The plan was approved; the developer answered the six open questions of the original draft (kept below as the decisions' record):

1. **Login mechanisms.** The target setup has three kinds of application: **one without authentication**, **one behind Microsoft Entra ID**, **one with HTTP-basic or form username/password**. Consequences for this change: (a) a role-less application needs no login recipe (`stage_login` is not required, `browser_open` of it just works inside the allow-list); (b) Entra ID is a **multi-page form recipe across an allowed IdP origin** (`login.microsoftonline.com` plus the tenant's own federation host if any): identifier page → password page → the optional "Stay signed in?" prompt → redirect back to the app's origin, so the `form` recipe takes an ordered list of `steps` (each step: the fields it fills, the control it submits, an optional "if present" flag for prompts) instead of one page; the stage's `allowedOrigins` must contain the IdP hosts; (c) basic auth uses `http-basic` (the context's `httpCredentials`) or the app's own form recipe, whichever the app implements; (d) the TOTP factor stays optional, and push/SMS/number-matching MFA remains unsupported (`login-mfa-required`, affected expectations `blocked`). **Still to confirm by the developer at implementation time: whether the Entra test accounts have MFA enforced; if they do, a conditional-access exception for the test accounts or a TOTP-capable authentication method is a precondition, not something this system can work around.**
2. **Plan approval:** the default `when-writing` stands.
3. **Wiki namespace:** the default stands (`projects/<system>/processes/<process>` with `system` named by the stage). The business and testing logic of a flow lives there, in the wiki.
4. **Exclusive stages:** none. `exclusive` stays an opt-in field that is `false` everywhere; the developer wants parallel stage tests.
5. **Residual same-user risk:** accepted for now. The developer plans a jev-based guard for all `bash` and `read` commands separately; this change neither depends on it nor builds a shell sandbox. Role instructions still forbid reading `.env`.
6. **Video:** per-role-session segments plus the generated timeline page; no stitched file.

### Original open questions (for the record)

These are the only decisions the design could not settle from the repository. Every one has a stated default the plan proceeds with; an answer changes a default, not the architecture.

1. **Login mechanisms on the real stages.** Do the customer / clerk / installer apps log in with a form on their own origin, through a shared SSO identity provider (Keycloak, Entra ID), and is a second factor involved? *Default:* `form` recipes that may span an allowed IdP origin, `http-basic`, and an optional TOTP factor computed server-side; push/SMS MFA is unsupported and yields `login-mfa-required` (the affected expectations become `blocked`).
2. **Plan approval before writing.** Should the stage-test workflow stop for the developer to approve the derived test plan before it creates data on a writable stage? *Default:* per-stage `planApproval: "when-writing"` (stop only when the plan creates data on a `writable` stage); `always` and `never` are configurable.
3. **Wiki namespace for a cross-application process.** A process spans several repositories. *Default:* a stage names a `system` id (for example `grid-allocation`) and process knowledge lives under `projects/<system>/processes/<process>`, treating the system as the project; `shared/` is not used because the evidence comes from one system.
4. **Exclusive stages.** Do workflows share test users, so that two stage tests on the same stage must not overlap? *Default:* `exclusive: false`; a stage may opt in, and a second workflow is then refused (`stage-held`, naming the holder) rather than queued.
5. **Residual same-user risk.** Agents run as the developer's OS user with a `bash` tool (`openspec/specs/durable-agent-tools/spec.md`, "Coding tools and read-only policy" — bash is always offered because the handoff runs through it), so a deliberately misbehaving agent could read `~/.config/agentic-coding/.env`. The design guarantees that credentials never enter the model context, telemetry, logs, evidence, wiki or report through the product's own surfaces; it does not sandbox the shell. *Default:* accept this residual risk (it already applies to provider tokens) and forbid it in the role instructions. Say if a stronger boundary (a separate secret file the bash tool path-denies) is wanted.
6. **One video vs. segments.** *Default:* one recording per role session and flow segment, plus a generated timeline page that plays the segments in order and seeks to each step (`#t=` media fragments). A single stitched file would need `ffmpeg` and is not proposed.

## Context

### What exists today (verified)

- **Configuration root and layout.** One resolver (`agentic-coding/src/config-root.ts`), root `~/.config/agentic-coding` or `AGENTIC_CODING_CONFIG_DIR`. Domain trees `apps/definitions`, `libraries/definitions`, `infrastructure/definitions`, `apps/defaults`, plus `config.json` (layered: repository overlay `.pi/herdr-workflow.json` deep-merges over it), `.env` (secret values), `providers/*.json` (`${VAR}` placeholders only, 0600), `environment-server.json` (server handoff, not configuration), `wiki/` (`HERDR_WIKI_DIR` overrides) — `agentic-coding/docs/config-inventory.md` §2–3. An app definition today is tiny (`ident`, `displayName`, `repositoryPath`, `provider`), verified on `apps/definitions/customer-fe.json` and `grid-allocation-frontend.json` (read only for shape, no secrets).
- **Secrets.** Secret-bearing JSON fields store `${VARIABLE}` references resolved field-by-field from the root `.env`; expanded secrets never appear in config files, Settings responses, logs, traces or pins (`openspec/specs/unified-json-configuration/spec.md`, "Shared .env secret references", "Credentials remain confined to their owner"). Precedent: `src/server/integrations/provider-store.ts` reports a clear-text provider file as invalid. Settings edits credentials through the protected flow with masked values (`openspec/specs/centralized-application-settings/spec.md`, "Safe configuration and credential persistence").
- **Redaction.** `environmentSecrets(configDir)` loads every non-empty `.env` value and `redact()` replaces them (and the `NAME=value` form for short values) in any JSON value (`src/server/environment/agent-routes.ts:162-249`). It is applied to the env routes, `http_request` and `db_query` (`src/server/debug/routes.ts:120`). `src/server/browser/routes.ts` and `src/agent-host/browser-tools.ts` contain no redaction (verified by search).
- **Browser sessions.** One server-owned Chromium, isolated contexts per session, `browser.max_sessions` (default 4) and idle TTL 15 min (`src/workflow/effects.ts:311-350`), FIFO queueing, run-scoped (`openspec/specs/agent-browser-sessions/spec.md`). `browser_open` accepts a raw URL unconditionally — the comment says refusing it "would be theatre" because the agent has a shell — and resolves `app`+`endpoint` only for an app the workflow holds (`routes.ts:325-384`). Recording swaps the session onto a recording context that inherits cookies and localStorage (`storageState`) and re-opens the URL (`pool.ts:346-390`); sessionStorage is not carried. A recording is capped at 10 minutes and kept only on request; videos are WebM with a poster.
- **Script facade.** `browser_run_script` hands an allow-list facade of page/context that includes `context.cookies` and `context.storageState` (tool description; `routes.ts:763-1044`), so a script can read session cookies today.
- **Evidence.** Per-workflow manifest, path-safe copy-in, per-file cap 20 MB (video 100 MB), per-workflow cap 1 GB, refuse-never-evict (`src/server/evidence/store.ts:45-50`, `docs/workflow-architecture.md` "Evidence store"). The evidence panel lists entries, renders screenshots/posters inline under kitty graphics, opens video externally (`openspec/specs/dashboard-evidence-panel/spec.md`).
- **Debug family.** `debug.investigate` → `debug.review` (approve / follow-up ≤5) → `core.completed` (close only); repository target, detached worktree, `startRequirements: ["branch", "task"]`; the engine writes `debug-report.md` from the output's `report` field (`src/workflow/definitions/graphs/debug.ts`, `src/workflow/steps/debug.ts`, `openspec/specs/debug-workflow/spec.md`). The dashboard reviews the report with line comments (`src/tui/dash/App.tsx:2843`).
- **Non-repository workflows.** Manifest policy `targetKind` is `repository | wiki | research` (`src/workflow/registry.ts:72`). A `research` target needs no repository, branch or worktree, accepts an optional read-only repository context, requires a task, and keeps its data under the shared workflow data root (`src/workflow/runtime/engine.ts:1300-1370`, `openspec/specs/research-workflow/spec.md`). Blueprints and custom definitions must target a repository (`src/workflow/definitions/custom.ts:86`).
- **Wiki.** OKF v0.2 concepts, `projects/<project-id>/…` vs `shared/…`, trust tiers from `verified`, `status`/`stale_after`; only the managed `wiki` and `research-wiki` roles may write drafts and only inside an authenticated `core.wiki` run; any managed-role write resets the concept to `draft` and removes `verified` (`src/workflow/wiki.ts:966-975`); developer approval at `core.wiki-approval` runs the engine-owned `wiki.verify` effect that grants human-reviewed trust (`openspec/specs/knowledge-wiki/spec.md`). The research family shows the non-code wiring `core.wiki` → `core.wiki-approval` (approve → completed with `wiki.verify`, comments → `core.wiki` ≤6) (`src/workflow/definitions/graphs/research.ts`). The live bundle has `projects/agentic-coding/*` and `projects/grid-allocation-backend/*` concepts and no process-flow concepts yet (listed, not read).
- **Workflow metadata** is part of the snapshot JSON (`src/contracts/workflow.ts:271`, `snapshot_json` in `src/workflow/runtime/engine.ts`); it already has `task`, `ticket` and `app`. The workflow store schema is `STORE_SCHEMA_VERSION = 6` (`src/workflow/runtime/store.ts:97`).
- **Cost evidence.** Orientation before the first artifact, tool-output size, polling turns and an unreachable compaction threshold are the measured cost drivers (`agentic-coding/docs/efficiency/03-synthesis.md`, RC2–RC6). A screenshot-heavy browser run is exactly the long, context-growing run that report describes.

### Assumed (not verified)

- Playwright's `context.route` sees main-frame navigations and in-page requests of every page of the context, and `page.screenshot({ mask })` masks locators; both are standard Playwright behaviour and the existing driver wraps Playwright (`src/server/browser/playwright-driver.ts`).
- The Settings credential flow can upsert an arbitrary named `.env` key through the authenticated server (the provider flow does this via `upsertEnvFile`); if the route is provider-specific, phase 1 adds a stage-scoped variant of it.
- Research-target start behaviour has no coupling to the `core.research` step beyond requiring a task (checked at `engine.ts:1300-1370` only).

## Goals / Non-Goals

**Goals (whole capability):**
- The developer hands in only ticket text (and optionally a stage); the result is an evidence report reviewed like a debug report.
- Stages are an explicit, operator-owned allow-list; production can never be configured as a stage.
- Stage credentials never enter the model context, the wiki, evidence, telemetry, logs or the report.
- Process knowledge is read from the wiki before a test and improved after it through the existing human review gate; contradictions are flagged, never silently overwritten.
- Every expected behaviour of the ticket gets a verdict with evidence; the run is reproducible from its recorded steps.
- Bounded: sessions, waits, screenshots, video, run length and wiki writes all have caps.

**Goals (this change, phase 1):** stage configuration domain, allow-list, credential handling, stage-bound logged-in browser sessions, redaction of browser output.

**Non-Goals:**
- Testing production, load testing, security testing of the stages.
- Automatic cleanup/reset of stage data (only hints and an inventory of created data).
- A Settings *editor* for stage structure (file-authored; Settings shows and sets credentials).
- Pulling ticket text from a ticket system (the seam is left; phase 4 note).
- Push/SMS MFA, CAPTCHA, client certificates.
- A sandbox for the agent's own shell (open question 5).

## Decisions

### D1 — A new `stage-test` workflow family, not a debug extension or a blueprint (phase 3)

| Option | Verdict |
| --- | --- |
| Extend `debug` with `--stage` | Rejected. `debug` is a repository family with a detached worktree and `startRequirements: ["branch","task"]`; a stage test has no code under test, needs no branch, needs a plan step, a conditional plan gate and a wiki write-back loop, and a structured report. Bolting these on would turn `debug` into two families behind flags. Reused instead: the report-as-output-field pattern, the approve/follow-up review action pair, close-releases-resources. |
| Blueprint of existing steps (`list_steps` composition) | Rejected. Blueprints compile only catalog steps and custom definitions must target a repository (`custom.ts:86`); no catalog step plans or executes a stage test, so the steps would be new anyway. The new steps may join the blueprint catalog later. |
| New built-in family with its own steps | **Chosen.** Same shape as `debug` / `env-setup`: graph in `src/workflow/definitions/graphs/stage-test.ts`, behaviors in `src/workflow/steps/stage-test.ts`, registered in the newest tier (and every older tier only so pinned lookups resolve, per the version-bump rule in `docs/workflow-architecture.md`). |

Target: the application-owned non-repository target already used by `research` (`targetKind: "research"` today), with an optional read-only repository context. Adding a fourth target kind would touch the registry, start path, view and CLI for no behavioural gain; phase 3 verifies there is no research-step coupling on that path and introduces a `stage` kind only if there is.

Graph (explicit steps in the workflow record):

```text
stage.plan ──complete──────────────────────────▶ stage.execute ──complete──▶ stage.review
   │  └─needs-approval─▶ stage.plan-review ─approve─▶ ┘                     │  approve ──────────▶ core.completed
   │                          └─comments (≤3)─▶ stage.plan                  │  approve-wiki ─────▶ core.wiki ─▶ core.wiki-approval
   └─blocked/failed (≤3) ─▶ stage.plan                                       │  comments (≤3) ─────▶ stage.execute
                                                                             core.wiki-approval: approve ─▶ core.completed (+ wiki.verify)
                                                                                                 comments (≤6) ─▶ core.wiki
core.completed ─close─▶ core.closed   (close stops sessions, releases stage lease)
```

- `stage.plan` (role `stage-planner`): reads the ticket, the stage (`stage_info`) and the wiki; writes the test plan. Its `onAgentComplete` deterministically turns `complete` into `needs-approval` when the stage's `planApproval` is `always`, or `when-writing` and the plan declares data creation on a writable stage — the agent cannot skip the gate.
- `stage.execute` (role `stage-tester`): drives the stage, records steps, attaches evidence, outputs verdicts and knowledge observations.
- `stage.review` (developer): approve, approve-and-update-wiki, or follow-up comment.
- `core.wiki` (role `stage-wiki`, directive-first like `research-wiki`) and `core.wiki-approval` exactly as in `research`.
- No separate reporter agent: the engine renders `stage-report.md` deterministically from the plan, the step journal, the tester's verdicts and the evidence manifest (like `debug-report.md`), which costs no turns and keeps timestamps server-authored.

Roles and model pools: three new roles join the preset role catalog with `classification: "single"` (no classifier routing): `stage-planner` (balanced default; reasoning over ticket + wiki), `stage-tester` (must be vision-capable because it receives screenshots; balanced default, capable for complex flows), `stage-wiki` (balanced/economy). The default preset maps them to the configured default profile; a preset may override per role.

### D2 — Stages are their own configuration tree, global only (phase 1)

| Option | Verdict |
| --- | --- |
| `config.json` key `stageTesting.stages` | Rejected: `config.json` is deep-merged with a repository overlay (`config-inventory.md` §3), so a repository could add or alter an allow-listed stage. The allow-list must be operator-owned. |
| Extend `apps/definitions/<app>.json` with stage URLs | Rejected: a stage bundles several apps, roles and one login/IdP; per-app files would scatter one allow-list entry over several files. |
| `environment-server.json` | Rejected: it is a server handoff file, not configuration. |
| `stages/definitions/<ident>.json` + `stages/policy.json` | **Chosen.** Mirrors `apps/`, `infrastructure/`, `libraries/`; read only from the canonical root, never from an overlay or the env-setup staged root; reloaded per read like other definitions. |

Schema (illustrative; credentials are references only):

```json
{
  "ident": "grid-int",
  "displayName": "Grid allocation – INT",
  "environment": "int",
  "system": "grid-allocation",
  "access": "writable",
  "planApproval": "when-writing",
  "exclusive": false,
  "apps": {
    "customer":  { "label": "Customer portal", "app": "customer-portal-fe", "url": "https://customer.int.example.com",
                   "kind": "ui", "roles": { "applicant": { "login": "keycloak", "username": "${STAGE_GRID_INT_APPLICANT_USER}", "password": "${STAGE_GRID_INT_APPLICANT_PASSWORD}" } },
                   "version": { "path": "/assets/version.json", "field": "version" } },
    "clerk":     { "label": "Clerk app", "app": "grid-allocation-frontend", "url": "https://clerk.int.example.com",
                   "kind": "ui", "roles": { "sachbearbeiter": { "login": "keycloak", "username": "${…}", "password": "${…}", "totp": "${…}" } } },
    "installer": { "label": "Installer app", "url": "https://installer.int.example.com", "kind": "ui", "roles": { "installer": { "login": "keycloak", "username": "${…}", "password": "${…}" } } },
    "backend":   { "label": "Backend", "app": "grid-allocation-backend", "url": "https://api.int.example.com", "kind": "api",
                   "version": { "path": "/actuator/info", "field": "build.version" } },
    "mail":      { "label": "Mail catcher", "url": "https://mail.int.example.com", "kind": "mail-catcher", "api": "mailpit" }
  },
  "logins": {
    "keycloak": { "kind": "form", "origin": "https://sso.int.example.com",
                  "username": { "label": "Username" }, "password": { "label": "Password" },
                  "submit": { "role": "button", "name": "Sign In" },
                  "success": { "notOrigin": "https://sso.int.example.com" } }
  },
  "allowedOrigins": ["https://sso.int.example.com"],
  "readOnlyExceptions": [{ "origin": "https://sso.int.example.com", "pathPrefix": "/realms/", "methods": ["POST"] }],
  "data": { "prefix": "AC-TEST", "notes": "Use postcode 12345 test area.", "cleanup": "Clerk app → Admin → Testdaten löschen (prefix AC-TEST)." },
  "limits": { "maxSessions": 3, "maxActionsPerMinute": 60, "maxWaitSeconds": 600, "maxScreenshots": 60, "maxRecordingMinutes": 30 },
  "wiki": { "processes": ["projects/grid-allocation/processes/grid-connection-request"] }
}
```

- `ident` = file stem, `^[a-z0-9][a-z0-9-]{0,62}$`. The **stage name** is the ident; **environment** is a free lowercase label, so "one stage per environment" and "several stages per environment" are both valid.
- Stage app `app` optionally links a configured app ident (validated against `apps/definitions`); it gives the planner the project namespace and an optional read-only repository context. Stage apps are *not* environment slots: they are hosted, never started, never held through `env_start`.
- `stages/policy.json` (global): `deniedHostPatterns` (glob list, for example `*.prod.*`, `www.example.com`) and `ceilings` that cap every stage's limits.
- Validation refuses (stage excluded from the allow-list, value-free diagnostic naming file and field): environment or ident matching `prod|production|prd|live`; a URL/origin matching a denied host pattern; a non-`https` URL unless the host is loopback or the stage sets `insecureHttp: true`; a credential field that is not exactly one `${VAR}`; a role naming an undeclared login recipe; an unknown `app` ident; limits above the policy ceilings (clamped with a diagnostic, not refused). A missing `.env` variable does not refuse the stage: the role reports `missing VAR` and `stage_login` fails naming the variable.

Edit path: the developer edits the files (like `browser.*` bounds, which are file-only); Settings shows a read-only Stages section with validation diagnostics and credential status, and sets a credential value through the existing protected `.env` credential flow. A full structural editor is a later change.

### D3 — Credentials stay in the server; the browser types them, the model never sees them (phase 1)

- **Storage:** values in the root `.env`, references in the stage file — the established mechanism. Rejected: OS keychain (new platform-specific dependency), wiki (plain text, review surface), persisted Playwright `storageState` files (live session tokens at rest).
- **Use:** `stage_login({ session, app, role })` resolves the references inside the server at call time and runs the declared recipe: `form` (fill username/password located by label, role or selector; optional TOTP code computed from the `totp` seed with RFC 6238 via `node:crypto`; click submit; wait for the success condition, bounded), or `http-basic` (context `httpCredentials`, set at session creation). For irregular forms, `browser_fill({ ref, credential: { app, role, field } })` fills one resolved field. Tool arguments therefore only ever carry references, so tool telemetry cannot record a secret.
- **Never on video:** `stage_login` and credential fills are refused on a session that is recording (`recording-active`). The recommended order is open → login → record; phase 2 makes the recording swap carry sessionStorage so SPA logins survive it.
- **Never in output:** every browser route response is passed through the shared redactor (`.env` values + the session's resolved credentials) and a URL sanitizer that replaces values of token-like query/fragment parameters (`token`, `access_token`, `id_token`, `refresh_token`, `code`, `state`, `session`, `sid`, `sig`, `signature`, `password`, `secret`, `key`, `auth`) — snapshot text, eval and script results, console, network, wait, open and error messages. This applies to **all** sessions: the redactor is cheap and a local app can leak a secret too.
- **Never in evidence:** stage-session screenshots pass Playwright `mask` locators for `input[type=password]` and for every element a credential was filled into. Saved repro specs for a stage session start with a login preamble that reads `process.env.<VAR>` names, never values.
- **Never extractable:** on a stage-bound session the script facade refuses `context.cookies`, `context.storageState` and `context.addCookies` (`stage-session-restricted`).

### D4 — Stage-bound sessions enforce the allow-list where credentials live (phase 1; tightened in phase 3)

- `browser_open({ stage, stageApp, path?, session })` resolves the URL from the catalog; the session is bound to the stage for its life (it cannot be re-bound; another stage needs another session). A raw `url` into a stage-bound session must be inside the allow-list.
- The allow-list of a stage = the origins of its apps ∪ `allowedOrigins`. A context route guard aborts main-frame document navigations to any other origin and reports `origin-not-allowed` (with the sanitized URL) on the next tool result; subresources (fonts, CDNs) are not blocked.
- `read-only` stages: the guard aborts requests with methods other than GET/HEAD/OPTIONS unless a `readOnlyExceptions` entry matches (login endpoints). This is a real control, not an instruction.
- `maxActionsPerMinute` counts the agent's browser tool calls on the stage's sessions; above it a call is refused with `stage-rate-limit` and a `retryAfterMs`. `maxSessions` caps concurrent stage sessions per workflow (within `browser.max_sessions`). `exclusive: true` takes an in-memory per-stage lease for the workflow (no database change; a restart drops it together with the sessions it protects).
- Phase 1 leaves raw-URL sessions as they are (the existing rationale in `routes.ts` holds for local debugging). Phase 3's `stage-test` family refuses raw-URL and app-endpoint opens altogether, so its tester can only browse its pinned stage. Honest bound: the guard prevents testing the wrong system by mistake and confines credentials to allow-listed origins; it does not stop an agent from `curl`ing a URL through its shell (open question 5).

### D5 — Execution model: per-role sessions, journaled steps, segment videos, server-side waits (phase 2)

- **One context per role.** Each role is its own isolated session (`customer`, `clerk`, `installer`, `mail`), logged in once; this matches the isolated-context design and avoids SSO cookie collisions between roles on one IdP.
- **Step journal.** `stage_step({ session, label, expected?, observed?, captures?, evidence?, knowledge? })` appends a server-timestamped entry to the workflow's `stage-journal.jsonl` (beside the evidence) with the session's app/role, the sanitized URL and, when the session records, the segment and the offset into it. `stage_journal()` reads it back (bounded), so the run survives compaction. Captured values (the request id from the customer app) are ordinary observed data carried in the journal and used in the next app.
- **Video.** Playwright records per page/context, so one continuous video across contexts is impossible without post-processing. The tester records **segments**: one per role session per contiguous part of the flow, each within the existing 10-minute cap, stopped (kept) around long waits. The engine renders `stage-flow.html` next to the report: an ordered list of segment videos with each journal step as a link using a media fragment (`segment.webm#t=102`), opened with the system opener. Rejected: stitching with `ffmpeg` (new binary dependency; open question 6); one shared context for all roles (SSO collisions, one 10-minute cap for the whole flow).
- **Waiting.** `stage_wait({ session, until: { text | selector | url | mail }, reload?, intervalSeconds ≥ 5, timeoutSeconds ≤ limits.maxWaitSeconds })` polls server-side and answers once; for a `mail-catcher` app with `api: "mailpit"` it queries the Mailpit search API for `to`/`subject` matches. One tool call replaces dozens of polling turns (RC5 of the efficiency synthesis).
- **Context cost.** `browser_screenshot({ evidence: true, view: false })` stores without returning the image; `limits.maxScreenshots` caps stored screenshots per run (`evidence-quota`-style refusal `stage-screenshot-limit`); the tester is instructed to judge from `browser_snapshot` text and keep screenshots for verdict points.

### D6 — Process knowledge lives in the wiki and is improved through the existing gate (phase 3)

Page structure (OKF concepts, project namespace = the stage's `system`):

- `projects/<system>/processes/<process>` — `type: process`. Sections: *Covers* (what tickets it applies to, tags), *Actors & apps* (stage app keys and role names, never credentials), *Steps* (numbered; per step: app, role, screen landmark by accessible name, action, expected result, captured data), *Hand-overs*, *Asynchronous steps* (mail/job, typical and maximum latency), *Test data* (conventions, which role account to use), *Assertions that matter*, *Gotchas*. Sources cite `stage://<stage>/<workflow-id>` and the step ids that confirmed a claim.
- `projects/<system>/stages/<stage>` — `type: stage-notes`: non-secret quirks of one stage (slow mail, nightly reset, known broken areas).
- `projects/<system>/processes/index` — a hub linking the processes.

Read: `stage.plan` resolves knowledge from `wiki.processes` hints, then `wiki search` with ticket terms inside `projects/<system>/`; records the chosen concept ids with trust tier and staleness in the plan; the tester receives the relevant steps in its assignment and does not re-read the wiki (avoids RC3 orientation cost).

Write back: the tester attaches `knowledge` observations to journal steps: `confirmed`, `contradicted`, `missing`, `new`, each with concept id + section and, for `contradicted`, a `suspectedCause` of `product-change` (the ticket changes this behaviour), `regression` or `unknown`. At `stage.review` the developer chooses approve (no wiki work) or approve-and-update-wiki. The `stage-wiki` role then works directive-first from the observations:
- `missing` / `new` / `contradicted` + `product-change` → update the concept in place (new draft), with a dated "Changed" note naming the workflow and the previous statement;
- `contradicted` + `regression`/`unknown` → do **not** change the claim; add a dated "Disputed" callout linking the report, so a regression never rewrites the knowledge it violated;
- `confirmed` → no write (any managed write resets a concept to `draft` and drops `verified`, `wiki.ts:966-975`); confirmations are listed in the report only.
Approval at `core.wiki-approval` runs `wiki.verify` (human-reviewed). The `stage-wiki` role is added to the permitted wiki writers; a managed wiki write that contains a declared `.env` secret value is refused.

### D7 — Report format (phase 3; viewer additions phase 2)

`stage-report.md`, engine-rendered from the tester's `core.stage-report@1` output plus journal and manifest, every value passed through the redactor:

1. Ticket summary (and ticket reference when given).
2. Stage and versions tested (stage ident, environment, access; per app the version from its probe or "not discoverable").
3. Derived test plan (expectations E1…En with source `ticket`/`wiki`, knowledge concepts used with trust tier and staleness).
4. Findings: per expectation — verdict `pass | fail | blocked | inconclusive`, severity for `fail` (`critical | major | minor`), expected vs observed, step ids, evidence ids (screenshots with captions; video segment with `mm:ss`).
5. Steps (timeline): the journal — time, app/role, action, expected, observed, captures, evidence, video offset — doubling as reproduction steps.
6. Data created on the stage (inventory with cleanup hints).
7. Wiki updates proposed (the knowledge observations).
8. Not tested and why.
`validateEvidence` refuses a report whose expectations lack a verdict, whose `pass`/`fail` cites no evidence, or that cites an evidence or step id that does not exist. The dashboard reuses the debug report review (line comments → follow-up). Evidence panel (phase 2): entries grouped by flow segment with step captions and offsets, and an "open flow" action that opens `stage-flow.html`.

### D8 — Starting it (phase 3 CLI, phase 4 UI/orchestrator)

Phase 3: `workflow start --workflow stage-test --stage IDENT --task "<ticket text>" [--ticket REF] [--repo PATH]`; the stage is validated against the catalog before anything is written (`400 stage-not-configured`) and pinned in metadata (`stage`), like `app` for `env-setup`. When no stage is given and exactly one stage exists for the ticket's system the planner may pick it; otherwise the start requires it. Phase 4: the New Workflow modal and the orchestrator's `start_workflow` gain the same fields. A ticket *reference* resolver (ticket system integration) fills `task` from `ticket` later; out of scope.

### D9 — No store schema change

Workflow metadata (`stage`) lives in the snapshot JSON; the journal and flow page are files beside the evidence; evidence manifest additions are optional fields; the stage lease is in memory; the stage catalog is configuration. `STORE_SCHEMA_VERSION` stays 6 and the environment state database is untouched.

## Phasing

| Phase | Change | Delivers | Depends on |
| --- | --- | --- | --- |
| 1 | `add-stage-testing-foundation` (**this change**) | stage config + allow-list + credentials + stage-bound logged-in sessions + browser output redaction; usable from `debug` | — |
| 2 | `add-stage-flow-evidence` (draft) | `stage_step`/`stage_journal`/`stage_wait`, segment recordings with sessionStorage carry-over, `view:false` screenshots, flow page, evidence panel grouping | 1 |
| 3 | `add-stage-test-workflow` (draft) | the `stage-test` family, roles, plan gate, report rendering/validation, wiki read/write loop, `stage-wiki` role, CLI start | 1, 2 |
| 4 | `add-stage-test-launch` (draft) | New Workflow modal + orchestrator start with stage picker and ticket text; ticket-reference seam | 3 |

## Risks / Trade-offs

- [Flaky UI assertions on shared stages] → verdict `inconclusive` exists; the tester re-snapshots and retries a failing assertion once before `fail`; a stage-down/login failure is `blocked`, never `fail`; `stage_wait` replaces sleeps.
- [SSO/MFA login flows] → declarative recipes across an allowed IdP origin, TOTP support, explicit `login-mfa-required`; unsupported mechanisms degrade to `blocked` with the reason (open question 1).
- [Stage data pollution] → `read-only` enforced by method guard; `writable` requires the data prefix, the plan declares data creation (gate per `planApproval`), the report inventories created data with cleanup hints; destructive actions on data the run did not create are forbidden in the tester instructions (instruction-level, reviewed in the report).
- [Credential leak through same-user shell] → residual, stated (open question 5); product surfaces are covered by references-only arguments, server-side resolution, redaction, masking and facade restrictions.
- [Redaction gaps: a secret transformed (base64, URL-encoded) by a page] → URL-encoded forms of resolved credentials are added to the session's redaction set; other transformations are a residual risk, mitigated by masking and by never typing secrets outside `stage_login`.
- [Long run cost: screenshots, long flows, compaction ceiling] → text snapshots first, `view:false`, screenshot cap, server-side waits, planner hands the tester a complete route (no wiki orientation), journal as durable memory, and the `stage-tester` preset should set a compaction ceiling well below the default `max(32k, 30 %)` threshold that the efficiency synthesis found unreachable.
- [Video size] → 10-minute cap per segment (existing), `maxRecordingMinutes` per run, 100 MB per video and 1 GB per workflow (existing refuse-never-evict caps).
- [Session lost on recording swap (sessionStorage SPAs)] → phase 2 carries sessionStorage of the current origin through the swap; until then, log in and record in the order open → login → record and report a lost login as `blocked`.
- [Allow-list is a guard, not a sandbox] → stated in D4; phase 3 removes raw-URL opens from the stage-test family.

## Migration Plan

Additive. No migration, no compatibility shims: a configuration without `stages/` has an empty allow-list and every existing browser behaviour is unchanged except that browser outputs are now redacted. Rollback is removing the code; stage files are inert without it.
