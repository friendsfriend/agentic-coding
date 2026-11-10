// Ported presentation types for the stage picker (pure types, no I/O).
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
