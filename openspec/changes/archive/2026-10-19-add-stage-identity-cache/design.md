## Open questions for the developer

Each had a default; the implementation took every default, so none is open. An
answer would change a default, not the architecture.

1. **Default time-to-live.** *Taken:* 4 hours (`ttlMinutes: 240`), ceiling 24 hours (1440) in `stages/policy.json`. Entra's own sign-in frequency and conditional access can end a session earlier; then the normal login path runs.
2. **Share one identity across roles of the same identity provider?** *Taken:* no — the key is `(stage, role)` because roles are different users.
3. **Cache across stages?** *Taken:* no; a stage is the trust boundary.
4. **One real-browser check against a live Entra tenant.** *Deferred, not decided:* the change is verified against the fake driver and the unit seams; a manual end-to-end check (a real window login, a silent reuse in a later session, a policy that ends the session early) is recorded in `tasks.md` as `pending-for-developer` and does not hold the change.

## Context

- Foundation (`add-stage-testing-foundation`): stage-bound sessions in isolated browser contexts, login recipes, credential-safe redaction, and the rule that no session state is persisted (live tokens at rest rejected). The script facade refuses `context.cookies`, `context.storageState` and `context.addCookies` for stage sessions.
- Interactive login (`add-stage-interactive-login`): the developer completes the login in a visible window when no credentials are configured.
- Entra ID applications typically keep their own tokens in `sessionStorage` (lost with the context) or `localStorage`; other applications keep a JWT in a cookie or storage after a basic-auth or form login. A new context can reuse the identity provider's sign-on cookie (silent redirect round trip) and, when restored, the application's own token.
- HTTP basic typed into the browser's native dialog is not page state: it lives in the browser's HTTP auth cache and is invisible to `storageState`. The browser then sends it as an `Authorization: Basic` request header, which Playwright can read on the request.
- The existing recording swap already carries cookies, localStorage and the current origin's sessionStorage between contexts of one session (`pool.ts`), so cookie install at context creation is a known operation.
- A role may also sign in over OAuth 2.0 (`add-stage-oauth2-auth`), and that path already keeps a token in memory (`src/server/stages/oauth2.ts`, `stageTokenStore()`). Its boundary with this cache is stated in D8: it stores a *bearer token the server presents*, this cache stores *what a browser keeps*.

## Goals / Non-Goals

**Goals:** one hand-off (or one automated login) serves later runs within a bounded time and keeps a long run logged in across a recreated session; nothing on disk; no value ever visible to the model.

**Non-Goals:** persistent browser profiles or `storageState` files on disk; capturing origins outside the stage's own application and login origins; unattended/CI identity injection (a later server design may seed this cache); sharing across stages or users; bypassing MFA — the cache only reuses a session the developer or recipe already established.

## Decisions

### D1 — In memory, owned by the server, keyed `(stage, role)`

A `Map` inside the server process (`identity-cache.ts`), not in the workflow store, not in `config`, not in snapshots. It is lost on restart; that is the point. Rejected: encrypted file (key management for a local single-user tool, same-user readable anyway), OS keychain (platform-specific dependency), persistent browser profile (full tokens at rest, large surface).

### D2 — Capture the stage origins' session state, refresh it while the session lives

After the login's success condition is met, capture, for each origin of the stage's applications and declared login origins only (never a third-party host the page happened to call):

- cookies whose domain matches those origins,
- `localStorage` and `sessionStorage` of those origins (`storageState()` for cookies and localStorage; `sessionStorage` through the same origin-scoped `page.evaluate` read that the recording swap already uses).

Implementing this made three details decide the shape of the module:
`storageState()` answers cookies for *every* origin of the context (an identity
provider's `Domain=…` cookie included), so the capture filters by the stage's
own origin set instead of trusting the answer; `sessionStorage` is not in
`storageState()` at all, so it is read per origin and folded in (an origin the
page is not currently on answers nothing, which is why a capture never replaces
a non-empty entry with an empty one — a token-only `authorization_code` login
leaves no browser state behind and must not wipe a good entry); and a live
`sessionStorage` read is only meaningful when the page is *on* one of the stage
origins, compared by origin rather than by raw URL.

**Spike 2.0 (the `http-basic` hand-off) — result: not exposed, so not cacheable.**
The driver sees a navigation's *response* (`page.goto` → status) and a page's
cookies, but the `Authorization: Basic …` header of the browser's own
authentication dialog is generated inside the network stack: it is attached to
requests this server does not observe (`page.on("request")` is not part of the
driver surface, and `request.allHeaders()` would need that hook), so there is
nothing to read after the dialog completes. A configured `http-basic` role
installs its credential per session from the `.env` (unchanged), and a role whose
Basic login a *developer* typed into the dialog is re-prompted: the cache holds
no Basic credential, and task 2.4 is dropped as a legitimate outcome rather than
implemented on a guess. The spec's Basic sentence is therefore conditional on
the header being observable.

**Refresh is bound to use, not to a timer.** There is no background sweep: a
capture happens (a) after a successful `stage_login`, (b) on the first browser
call of a session whose entry is older than `identityCache.refreshSeconds`
(default 120, floor 30, ceiling 3600, and never longer than the TTL) — the point
where a rotated refresh token matters,
because a call is about to rely on the state — and (c) on a clean close, before
the context is discarded, so the state of the last page a run used is what a
later session starts from. A crashed session captures nothing: its context is
gone and a partial state is worse than the previous capture. A session recreated
mid-run (idle timeout, a recording swap) restarts from the latest capture.
The floor exists because of that binding: at a one-second interval every browser
call would re-serialise the whole context, which is exactly the per-call cost the
interval is there to keep off the hot path. The interval is clamped below the TTL
as well, so a policy cannot ask for one longer than the entry it refreshes lives.

Tokens are never parsed to decide anything except a bounded, server-side read of
a JWT's `exp` for the listing's `expiresAt` hint; the success condition is the
only judge of whether a state still works.

### D3 — Install before first navigation; the success condition stays the judge

On creating a stage session for `(stage, role)` with a live entry, the server installs the state before the first navigation, through server-internal paths only: cookies by `DriverContext.addCookies` (a new driver method, so the fake driver can assert exactly what was installed), and storage by one origin-scoped init script whose JSON blob is guarded by `location.origin`, so init order never matters and no other origin is written. The install happens at context creation, *before* `context.page()`, so the application's first document already sees the token it reads at load. The session has to name the role for this to be possible — hence `browser_open({ stage, stageApp, stageRole })`; an unknown role is refused as `stage-role-unknown` rather than silently opening a logged-out session. `stage_login` then still runs the declared success condition. If the page shows the login form or the application reports an unauthenticated state, the cache is treated as rejected: the entry is evicted, and the automated recipe or developer hand-off continues. A cache never answers "logged in" by itself. A token that expired but has a working refresh path is handled by the application itself and needs no special case.

The init script runs on every document of the context, so it seeds only what a document does not already have (`area.getItem(name) === null`). Without that guard every later load — a reload, a link navigation, the redirect back from the identity provider — would rewrite the storage areas to the open-time snapshot and throw away the rotated token the live session had just written.

### D4 — Bounds

`identityCache` per stage (`true` default, `false` opt-out); `stages/policy.json` `identityCache: { ttlMinutes, maxEntries, refreshSeconds }` ceilings; per-cookie expiry honoured (session cookies live until the entry TTL); entries beyond `maxEntries` evict the oldest. An entry's lifetime is absolute from its *capture*: a read never extends it, and every capture restarts it — which is exactly how a living session (D2's refresh-on-use and the clean-close capture) keeps its entry alive, and why an idle one expires.

Five bounds, each with a hard ceiling the store itself enforces so a bad policy
file cannot widen them: `ttlMinutes` 240 default / 1440 ceiling, `maxEntries` 8 /
50, `refreshSeconds` 120 / 3600 with a 30 s floor, and — for what *one capture* may
hold —
`MAX_IDENTITY_VALUES_PER_ENTRY` (256 values), `MAX_IDENTITY_VALUE_LENGTH`
(32 KiB), `MAX_IDENTITY_ENTRY_BYTES` (512 KiB) together with
`MIN_IDENTITY_VALUE_LENGTH`, which *is* the scrubber's `MIN_SECRET_CHARS`
(`src/server/redaction.ts`): one shared constant, so the capture floor and the
redaction floor cannot drift apart. A page writes its own
storage, so without the last three a stage application would decide how much of
this process's heap the cache occupies and how much work every browser reply
does; a capture drops what is over the bound and the entry carries a `truncated`
count, which every listing reports: a number, never a name or a value, so an
operator can see that a key was stored cut short without learning what was cut.
A policy value above a ceiling is clamped *and* warned about once (the same
treatment `limits` gets), and the store clamps a per-capture TTL again on `put`,
so the effective bound does not depend on the caller. `maxEntries` is a
process-wide cap on the store, not a per-stage one: the cache is a convenience
and its size is what the process pays for. `refreshSeconds` is stored on the
effective policy but read by the pool's refresh decision; there is no timer. The
value floor is what makes the "every cached value is a secret" rule (D6) true
unconditionally: a value too short to be a credential is not kept at all, rather
than being kept and left out of the redaction set.

### D5 — Forgetting

`agentic-coding stage identity forget [--stage S] [--role R] [--all]` and
Settings → Stages both go through one pair of instance-authenticated routes —
`GET /api/v1/stages/identity` for the value-free listing,
`POST /api/v1/stages/identity/forget` for the removal, answering both the count and the remaining listing from the
store it removed from (so one answer never describes two caches). The
registration is production-wide: one process builds one pool, so it lives as long
as the process, and the clear exists for a test or a second assembly rather than
for a shutdown. A forget rewrites only a session's *attribution* — its source and
its capture instant — and keeps the rest of what the session knows, in particular
the roles it logged in as, because that history is what the cross-role guard reads
(SEC-001). An operator has one
action behind two surfaces and no surface has another. All three granularities
exist on all three surfaces: one `(stage, role)`, every role of one stage, and
the whole cache (no filter at all). The dashboard reaches them as Enter on an
entry, Enter on the stage's cache-bounds row, and Enter on the section's
"forget every cached sign-in" row, which also lists an entry whose stage the
catalog no longer allows, so nothing becomes invisible by being dropped from
the allow-list. Also automatic on
rejection (D3). Forgetting does not log a live session out: it decides what the
*next* session starts from, which is the only thing the cache ever influenced.
A live session of the forgotten key is told, though: its `source` and
`capturedAt` are cleared and the store's generation for the key moves on, so
neither its next refresh nor its clean-close capture puts the entry straight
back — the operator's forget holds until the next successful login.
There is no agent-facing twin (`/api/v1/agent-env/stages/identity`): it would
collide with the per-ident stage path (`identity` matches the ident pattern), and
forgetting is an operator action, not something a run decides mid-flight. No bulk
export or listing of values; a listing shows `(stage, role, capturedAt,
expiresAt)` only.

### D6 — Never exposed

Cached values (cookies and storage values, JWTs included) pass only between the Playwright context and the cache. Every value the store holds — each cookie value, each storage value, and the base64url segments of anything JWT-shaped — is part of its `secrets()`, which the browser routes add to their redaction set (plain and URL-encoded) alongside the `.env` values, and the identity listing route passes its answer through the same redactor. There is no length floor in that set: the *capture* is what refuses a value too short to be a credential (D4), so a stored value is always a registered one. The set a context accumulates *is* bounded, though — every capture re-registers the whole current state and a rotating token is a distinct value each time, so `mergeIdentitySecrets` keeps the newest values, up to 512 values and 1 MiB per context (`MAX_LIVE_IDENTITY_SECRETS` / `MAX_LIVE_IDENTITY_SECRET_BYTES`). What survives is what a page is most likely to echo, and the scrubber's cost stops following the length of the run. The set also carries what the live contexts *installed* (`pool.installedIdentitySecrets()`): an entry can be forgotten, expire or be evicted while the browser still holds its cookies and storage, and an echo of one of those is still an echo of a credential. So an accidental echo in a page title, a URL, a console line or a script result comes back masked. The store's own surfaces are value-free *by construction*, not by filtering: `list()` builds `{stage, role, capturedAt, expiresAt}` from the key and two timestamps, and `toJSON`/`toString` are defined to serialise only that, so a log line, a snapshot or a `JSON.stringify` of the cache cannot carry a cookie.

Three limits are worth stating rather than implying:

- **A heap snapshot is memory.** `diagnostics --heap` writes a V8 heap snapshot; there is no cache-free view of that file and pretending otherwise would be a false guarantee. The rule this change can and does keep is that no *diagnostic surface* serialises a value: no log line, no telemetry attribute, no evidence file, no workflow-store row, no tool result and no listing carries one, and the heap snapshot is not produced by this change or uploaded anywhere. The residual risk (a developer who dumps this process's heap can read what its memory holds) is the same one the OAuth 2.0 token store already carries, and it is accepted on that precedent.
- **The cache outlives a run.** It is the server's, keyed by `(stage, role)` and not by owner, so a second workflow on the same stage and role starts from the identity the first one captured — intended (the identity does not belong to the run), bounded by the TTL, and forgettable. The bounds on a *cache hit* are unchanged: a session's stage guard, its read-only rule and its origin allow-list all still apply, because the state is installed into a context that already answers to them.
- **The workflow store, evidence and telemetry stay empty of it.** None of them is on a path a value travels: the journal receives `identity: "cache" | "recipe" | "user"` (a word, not a state), and the login result carries that word plus the role it belongs to.

### D7 — Concurrency
Parallel runs on the same `(stage, role)` share the entry read-only (each gets its own copy of the cookies at install); the entry is replaced by the newest successful login. No exclusivity (decided for stage tests).

Three orderings are made explicit rather than left to timing, because a capture
is two awaits over shared state:

- **One capture per session at a time**, through the pool's per-key gate: two
  overlapping captures of one session could otherwise write back in either order
  and file a login under the role of the earlier one.
- **The role has to be the same before and after the read.** A `stage_login` that
  names another role while a capture is reading wins, and the capture is dropped
  instead of re-attributed. A context that was *installed* for one role is not
  captured under another at all: the jar and the storage in it belong to the role
  the session was opened for. Neither is a context that logged in as *two* roles
  captured under either of them: no install is needed for that to happen
  (`stage_login` accepts any declared role on an existing session), and the jar a
  capture would read then holds the first user's cookies as well as the second's.
- **A capture that is still running at close is still a capture.** A clean-close
  capture keeps its session registered until its read is done, so a forget that
  lands in that window disarms it; and a context's secret set accumulates — a
  later capture extends what an earlier install recorded instead of replacing it,
  so a value the context still holds never leaves the redaction set.
- **A generation, observed before the read, guards the write.** A forget (or an
  eviction) that lands while a capture reads moves the key on and the write is
  dropped, which is what makes D5's forget hold.

A capture is also bounded in time (a few seconds, after which it fails rather
than hangs the call that triggered it) and throttled by *attempts*, not by
successes: an attempt is stamped before the reads, so a stage whose login leaves
no browser state is not re-read on every browser call.

## Risks / Trade-offs

- [A stale identity masks that a login flow is broken] → the login result carries `identity: "cache" | "recipe" | "user"`, so whether a login was silent is visible in every result the moment it happens; the journal step that records a login belongs to `add-stage-test-workflow`/`-launch`, and it consumes this field rather than re-deriving it. `identityCache: false` or a forget gives a cold start.
- [Cookies outlive the intended TTL in the browser] → contexts are discarded; the cache enforces its own absolute TTL.
- [A test user's session is shared by parallel runs] → acceptable, the sessions belong to the same test identity.
- [Server restart drops the cache] → by design; costs one hand-off.
- [Refresh-token rotation makes an older copy unusable] → the entry is replaced by every capture, the newest wins; a parallel run that used a stale copy sees the login form, evicts, and logs in normally.
- [An application keeps the JWT in `HttpOnly` cookies only] → cookies are captured by the driver, which sees `HttpOnly` cookies; the page never does.
- [Capture widens the secret surface compared with IdP cookies only] → bounded to the stage's own origins, in memory, absolute TTL, redacted, forgettable; the residual same-user risk is accepted as in the foundation.

### D8 — The cache is not the token store

`stageTokenStore()` (`src/server/stages/oauth2.ts`) holds the access token the
*server* presents to an application: obtained by `stage_login` for an `oauth2`
role, keyed by `(stage, app, role, provider, scope set)`, renewed single-flight,
and read by `stage_api_request` and by the `bearerOrigins` header injection.
This cache holds what a *browser context* keeps — cookies and origin storage —
keyed by `(stage, role)`, and it is never read by a request the server makes on
its own behalf. Neither can be derived from the other: an OAuth 2.0 role may
hold a token and cache no browser state at all (an `authorization_code` login
ends on an application page that sets nothing), and a form-login role may cache a
session cookie with no token in the store. They stay two stores with two
lifetimes, two bounds and two forget actions; a shared store would have to decide
which of the two a "forget" means, and there is no such ambiguity worth
inventing.

## Migration Plan

Additive for this build; the field and policy keys are optional, the cache is empty on start, and there is no store or config migration (`STORE_SCHEMA_VERSION` stays 6).

One direction is not additive: both stage documents decode with
`onExcessProperty: "error"`, so a build from *before* this change does not read
an upgraded `stages/policy.json` as "policy without cache bounds" — it refuses
the file as unusable and then refuses every stage. Rolling back therefore means
removing the `identityCache` key from `stages/policy.json` (and any stage that
declares it) before running the older build, exactly like any other field the
older build does not know. The same note is in `docs/agent-environments.md`.

Rollback: remove the cache; every run logs in cold as before.
