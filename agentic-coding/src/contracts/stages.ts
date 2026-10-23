// Stage wire contract (`add-stage-testing-foundation`): the read surfaces both
// the Settings section and a run's `stage_info` tool consume, and the one write
// the credential flow needs. Pure types and schemas; no I/O.
//
// Nothing here can carry a credential *value*: a credential appears as a field
// name and a status (`set` / `missing VAR`), and the set flow takes a value in
// and never returns one.
import { Schema } from "effect";

export interface StageCredentialStatus {
	readonly field: StageCredentialField;
	/** The `.env` variable this field references. Present with every status, so a
	 * value that is already `set` can still be replaced: the key a write would
	 * touch is the key the row names. */
	readonly variable: string;
	/** `set`, or `missing <VAR>`. */
	readonly status: string;
}

/** A credential field one stage file may reference: the login form's three, a
 * role's refresh token, or a provider's client id and secret
 * (`add-stage-oauth2-auth`). */
export type StageCredentialField =
	| "username"
	| "password"
	| "totp"
	| "refreshToken"
	| "clientId"
	| "clientSecret";

/** The login kinds a read surface reports: a declared recipe kind of the stage's
 * `logins` table, or `oauth2` — the reserved recipe a role selects to obtain a
 * token from a declared provider (`add-stage-oauth2-auth`). */
export type StageLoginKind = "form" | "http-basic" | "interactive" | "oauth2";

/** One OAuth 2.0 provider of a stage, as both read surfaces report it: endpoints,
 * scopes and the *status* of the client credential references. */
export interface StageOAuth2ProviderStatus {
	readonly name: string;
	readonly tokenEndpoint: string;
	readonly authorizationEndpoint?: string;
	readonly audience?: string;
	readonly scope: readonly string[];
	readonly clientAuth: "basic" | "body";
	readonly credentials: readonly StageCredentialStatus[];
}

export interface StageRoleStatus {
	readonly role: string;
	readonly login?: string;
	readonly loginKind?: StageLoginKind;
	/** The `oauth2` provider and grant this role selects. */
	readonly provider?: string;
	readonly grant?:
		| "client_credentials"
		| "refresh_token"
		| "authorization_code";
	/** The origins this role's bearer token is added on. */
	readonly bearerOrigins?: readonly string[];
	/** `set` when every credential reference the role declares is set, `none`
	 * when the role declares none at all, otherwise the first `missing <VAR>`. */
	readonly credentialStatus: string;
	/** What a run can expect of this login: `automated` (this server performs
	 * it), `handoff` (it needs the developer in a headed window), `unavailable`
	 * (it needs the developer and this configuration forbids the window, or a
	 * reference it needs is unset). The `authorization_code` grant is a hand-off:
	 * the provider's page is the sign-in, and the hand-off's window is where it
	 * happens. */
	readonly loginMode: "automated" | "handoff" | "unavailable";
	/** Whether a successful login of this role is remembered in the identity cache
	 * (`add-stage-identity-cache`), so a later session of it may sign in silently.
	 * False when the stage disabled the cache and for the `http-basic` recipe, whose
	 * credential the driver cannot observe (`design.md` D2). */
	readonly cacheable: boolean;
	readonly credentials: readonly StageCredentialStatus[];
}
/** One declared version probe, as the agent route reports it. A probe that
 * could not be read is `not discoverable` rather than a failure of the call. */
export interface StageVersionStatus {
	readonly path: string;
	readonly field: string;
	readonly status: "ok" | "not discoverable";
	readonly value?: string;
}

export interface StageAppStatus {
	readonly key: string;
	readonly label: string;
	readonly url: string;
	readonly kind: "ui" | "api" | "mail-catcher" | "probe";
	readonly api?: string;
	readonly app?: string;
	readonly roles: readonly StageRoleStatus[];
	readonly version?: StageVersionStatus;
}

/** One allow-listed stage. */
export interface StageStatus {
	readonly ident: string;
	readonly displayName: string;
	readonly environment: string;
	readonly system: string;
	readonly access: "read-only" | "writable";
	readonly exclusive: boolean;
	readonly apps: readonly StageAppStatus[];
	readonly origins: readonly string[];
	readonly readOnlyExceptions: readonly {
		readonly origin: string;
		readonly pathPrefix: string;
		readonly methods: readonly string[];
	}[];
	/** The effective, clamped bounds a stage session is held to. Numbers only: a
	 * limit can never carry a value. */
	readonly limits: {
		readonly maxSessions: number;
		readonly maxActionsPerMinute: number;
		readonly maxWaitSeconds: number;
		readonly maxScreenshots: number;
		readonly maxRecordingMinutes: number;
		readonly maxLoginHandoffSeconds: number;
	};
	/** The identity cache's effective bounds (`add-stage-identity-cache`): whether
	 * a successful login may leave a bounded identity in the server's memory, how
	 * long it lives, how many entries the process keeps and how often a living
	 * session refreshes it. Numbers and a boolean only — never a value. */
	readonly identityCache: {
		readonly enabled: boolean;
		readonly ttlMinutes: number;
		readonly maxEntries: number;
		readonly refreshSeconds: number;
	};
	/** The stage's own data conventions — a row prefix, notes, a cleanup step —
	 * which is what an agent on a `writable` stage has to follow. */
	readonly data: {
		readonly prefix?: string;
		readonly notes?: string;
		readonly cleanup?: string;
	};
	/** Knowledge hints: the wiki process paths `stage.plan` resolves. */
	readonly wiki: { readonly processes: readonly string[] };
	/** The stage's OAuth 2.0 providers (`add-stage-oauth2-auth`). */
	readonly oauth2?: {
		readonly providers: readonly StageOAuth2ProviderStatus[];
	};
	/** Value-free diagnostics (a clamped limit, an IdP origin outside the
	 * allow-list). An *error* diagnostic means the stage is excluded instead. */
	readonly diagnostics: readonly string[];
}

/** One stage file that is not in the allow-list, with its reasons. */
export interface ExcludedStageStatus {
	readonly file: string;
	readonly ident?: string;
	readonly diagnostics: readonly string[];
}

/** `GET /api/v1/stages`: the whole catalog, allow-listed and excluded. */
export interface StagesStatusResponse {
	readonly configDir: string;
	readonly stages: readonly StageStatus[];
	readonly excluded: readonly ExcludedStageStatus[];
}

/** One cached stage identity, as every surface reports it
 * (`add-stage-identity-cache`): the key, when it was captured and when it ends —
 * and nothing else. No cookie name, no storage key, no value, no token. */
export interface StageIdentityStatus {
	readonly stage: string;
	readonly role: string;
	/** Epoch milliseconds. */
	readonly capturedAt: number;
	/** Epoch milliseconds; an entry past it is not reported and is not installed. */
	readonly expiresAt: number;
	/** How many captured values this entry's bounds dropped — a count, never a
	 * value. Always present, so a surface has to decide what to say about it
	 * instead of guessing `undefined` means "none" (it does: 0 is none). */
	readonly truncated: number;
}

/** `GET /api/v1/stages/identity`: the live entries of this server's cache. */
export interface StageIdentitiesResponse {
	readonly entries: readonly StageIdentityStatus[];
}

/** `POST /api/v1/stages/identity/forget`: forget one stage, one role of it, or
 * everything. Both fields absent forgets every entry. */
export const stageIdentityForgetRequestSchema = Schema.Struct({
	stage: Schema.optional(
		Schema.String.pipe(
			Schema.minLength(1),
			Schema.maxLength(64),
			Schema.pattern(/^[a-z0-9][a-z0-9-]{0,62}$/),
		),
	),
	role: Schema.optional(
		Schema.String.pipe(Schema.minLength(1), Schema.maxLength(128)),
	),
});
export type StageIdentityForgetRequest =
	typeof stageIdentityForgetRequestSchema.Type;

export interface StageIdentityForgetResponse {
	/** How many entries left. */
	readonly removed: number;
	/** The live entries after the forget, so a dashboard needs one round trip. */
	readonly entries: readonly StageIdentityStatus[];
}

/** `GET /api/v1/agent-env/stages`: one run's view. Only allow-listed stages a
 * read-only tester may see, plus why something is missing. */
export interface AgentStagesResponse {
	readonly stages: readonly StageStatus[];
	readonly excluded: readonly ExcludedStageStatus[];
}

/** `POST /api/v1/stages/credential`: the protected credential flow of the
 * Settings section. The value goes in and never comes back; only a key the
 * catalog actually references is accepted. */
export const stageCredentialRequestSchema = Schema.Struct({
	variable: Schema.String.pipe(
		Schema.minLength(1),
		Schema.maxLength(256),
		Schema.pattern(/^[A-Za-z_][A-Za-z0-9_]*$/),
	),
	value: Schema.String.pipe(Schema.minLength(1), Schema.maxLength(4096)),
});
export type StageCredentialRequest = typeof stageCredentialRequestSchema.Type;

export interface StageCredentialResponse {
	readonly variable: string;
	readonly status: "set";
}

// ---------------------------------------------------------------------------
// OAuth 2.0 (`add-stage-oauth2-auth`)
// ---------------------------------------------------------------------------

/** `POST /api/v1/agent-env/stage-api-request`: one authenticated request to a
 * stage's API application, sent by the server with the role's token. A path and
 * nothing else: an absolute URL is refused, so the host is always the one the
 * stage file names. */

/** The most a `stage_api_request` body may carry, in bytes. The contract bounds
 * the field to these characters *and* the route checks the encoded bytes, so a
 * multi-byte body cannot slip past the advertised limit (QA-005). */
export const MAX_STAGE_API_REQUEST_BYTES = 64 * 1024;

/** The most of a `stage_api_request` answer that is read at all: the rest is
 * dropped at the source, so a misconfigured endpoint cannot stream a gigabyte
 * into the server process. Also the bound a compiled flow's replay fixture
 * applies to `ctx.api`'s own response reads, so the two paths agree without
 * duplicating the number. */
export const MAX_API_RESPONSE_BYTES = 256 * 1024;

export const stageApiRequestSchema = Schema.Struct({
	/** The stage ident. Optional only when exactly one allow-listed stage exists,
	 * which then applies to every request. */
	stage: Schema.optional(
		Schema.String.pipe(Schema.minLength(1), Schema.maxLength(128)),
	),
	/** The application key. Optional only when the stage has exactly one `api`
	 * application. */
	app: Schema.optional(
		Schema.String.pipe(Schema.minLength(1), Schema.maxLength(128)),
	),
	/** The role whose token authenticates the request. */
	role: Schema.String.pipe(Schema.minLength(1), Schema.maxLength(128)),
	method: Schema.Literal("GET", "HEAD", "POST", "PUT", "PATCH", "DELETE"),
	/** A path of that application, with an optional query string. */
	path: Schema.String.pipe(Schema.minLength(1), Schema.maxLength(2048)),
	/** Query parameters, as an object. Refused together with a `?` in `path`, so
	 * one request cannot express two different query strings. */
	query: Schema.optional(
		Schema.Record({
			key: Schema.String.pipe(Schema.minLength(1), Schema.maxLength(256)),
			value: Schema.String.pipe(Schema.maxLength(2048)),
		}),
	),
	headers: Schema.optional(
		Schema.Record({
			key: Schema.String.pipe(
				Schema.minLength(1),
				Schema.maxLength(128),
				Schema.pattern(/^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/),
			),
			value: Schema.String.pipe(Schema.maxLength(4096)),
		}),
	),
	body: Schema.optional(
		Schema.String.pipe(Schema.maxLength(MAX_STAGE_API_REQUEST_BYTES)),
	),
});
export type StageApiRequest = typeof stageApiRequestSchema.Type;

export interface StageApiRequestResponse {
	readonly stage: string;
	readonly app: string;
	readonly role: string;
	readonly method: string;
	/** The absolute URL the server actually called. */
	readonly url: string;
	readonly status: number;
	readonly statusText: string;
	/** The response headers the stage allows: a small allow-list, never a
	 * `Set-Cookie`. */
	readonly headers: readonly {
		readonly name: string;
		readonly value: string;
	}[];
	readonly body: string;
	/** Whether the body was cut at the response bound. */
	readonly truncated: boolean;
	/** The response's byte length, before truncation. */
	readonly bytes: number;
	/** How many times the token was renewed to answer this call: `0` or `1`. */
	readonly renewals: number;
}

/** `POST /api/v1/agent-env/stage-token-info`: the four fields an agent may learn
 * about the role's token. */
export const stageTokenInfoRequestSchema = Schema.Struct({
	stage: Schema.optional(
		Schema.String.pipe(Schema.minLength(1), Schema.maxLength(128)),
	),
	app: Schema.optional(
		Schema.String.pipe(Schema.minLength(1), Schema.maxLength(128)),
	),
	role: Schema.String.pipe(Schema.minLength(1), Schema.maxLength(128)),
});
export type StageTokenInfoRequest = typeof stageTokenInfoRequestSchema.Type;

/** Exactly four fields, and the schema is what keeps it that way: a provider's
 * claims, the subject and every token value stay on the server. */
export const stageTokenInfoResponseSchema = Schema.Struct({
	/** Epoch **milliseconds**, directly comparable with `Date.now()`. */
	expiresAt: Schema.Number,
	scopes: Schema.Array(Schema.String),
	audience: Schema.optional(Schema.String),
	issuer: Schema.optional(Schema.String),
});
export interface StageTokenInfoResponse {
	/** The instant the access token expires, in epoch milliseconds (so
	 * `expiresAt - Date.now()` is a lifetime in ms, *not* an `expires_in` value).
	 */
	readonly expiresAt: number;
	readonly scopes: readonly string[];
	readonly audience?: string;
	readonly issuer?: string;
}

// ---------------------------------------------------------------------------
// Step journal (`add-stage-flow-evidence`)
// ---------------------------------------------------------------------------
// The journal one workflow's stage flow writes beside its evidence manifest.
// Every field is either server-derived (the sequence number, the time, the
// session, the application, the role, the sanitized URL, the segment and the
// offset) or already redacted agent text: the reader here is the dashboard, and
// it must never be handed a value the store would not have written.

/** A bounded, control-character-free journal text field. */
const journalText = (max: number) =>
	Schema.String.pipe(Schema.maxLength(max)).pipe(
		Schema.filter(
			(value) => {
				for (let index = 0; index < value.length; index++) {
					const code = value.charCodeAt(index);
					if (code < 0x20 || code === 0x7f) return false;
				}
				return true;
			},
			{ message: () => "control characters are not allowed" },
		),
	);

/** What the step showed about the process being tested. */
export const stageJournalKnowledgeSchema = Schema.Struct({
	concept: journalText(256),
	section: Schema.optional(journalText(256)),
	kind: Schema.Literal("confirmed", "contradicted", "missing", "new"),
	suspectedCause: Schema.optional(
		Schema.Literal("product-change", "regression", "unknown"),
	),
});
export type StageJournalKnowledge = typeof stageJournalKnowledgeSchema.Type;

/** One journal entry, exactly as the file holds it. `segment` and `offsetMs` are
 * present only for a step written while its session recorded, and `video` is
 * back-filled with the kept segment's evidence id. */
export const stageJournalEntrySchema = Schema.Struct({
	seq: Schema.Number.pipe(
		Schema.filter((value) => Number.isInteger(value) && value > 0, {
			message: () => "seq must be a positive integer",
		}),
	),
	at: journalText(64),
	session: Schema.optional(journalText(64)),
	app: Schema.optional(journalText(64)),
	role: Schema.optional(journalText(128)),
	url: Schema.optional(journalText(2048)),
	label: journalText(512),
	/** The reviewed block layer (`add-stage-flow-blocks`). A plain step omits
	 * these; a block sub-step carries its plan, route and executable identity. */
	planId: Schema.optional(journalText(128)),
	routeStepId: Schema.optional(journalText(64)),
	block: Schema.optional(journalText(160)),
	blockVersion: Schema.optional(journalText(32)),
	subStep: Schema.optional(journalText(512)),
	status: Schema.optional(Schema.Literal("passed", "failed", "skipped")),
	/** Replay identity. Live exploratory entries omit these. */
	flowId: Schema.optional(journalText(64)),
	revision: Schema.optional(
		Schema.Number.pipe(
			Schema.filter((value) => Number.isInteger(value) && value >= 0, {
				message: () => "revision must be a non-negative integer",
			}),
		),
	),
	inputsHash: Schema.optional(journalText(80)),
	replayRunId: Schema.optional(journalText(80)),
	source: Schema.optional(Schema.Literal("replay")),
	expected: Schema.optional(journalText(4096)),
	observed: Schema.optional(journalText(4096)),
	captures: Schema.optional(
		Schema.Record({ key: journalText(128), value: journalText(1024) }),
	),
	evidence: Schema.optional(Schema.Array(journalText(32))),
	knowledge: Schema.optional(stageJournalKnowledgeSchema),
	segment: Schema.optional(
		Schema.Number.pipe(
			Schema.filter((value) => Number.isInteger(value) && value > 0, {
				message: () => "segment must be a positive integer",
			}),
		),
	),
	offsetMs: Schema.optional(
		Schema.Number.pipe(
			Schema.filter((value) => Number.isInteger(value) && value >= 0, {
				message: () => "offsetMs must be a non-negative integer",
			}),
		),
	),
	video: Schema.optional(journalText(64)),
});
export type StageJournalEntry = typeof stageJournalEntrySchema.Type;

/** What `stage_journal` and the dashboard's journal read answer with: the
 * entries in journal order, and whether the workflow has a flow page yet. */
export const stageJournalSchema = Schema.Struct({
	workflowId: journalText(80),
	entries: Schema.Array(stageJournalEntrySchema),
	flowPage: Schema.optional(journalText(64)),
});
export type StageJournal = typeof stageJournalSchema.Type;
