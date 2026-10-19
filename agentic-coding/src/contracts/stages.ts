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
	readonly planApproval: "always" | "when-writing" | "never";
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
