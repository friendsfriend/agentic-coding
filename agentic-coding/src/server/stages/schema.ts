// Stage definition schema (`add-stage-testing-foundation`, task 1.1).
//
// A stage is one operator-owned, hosted test environment named by its file
// stem under `<config-root>/stages/definitions/<ident>.json`, plus one global
// `stages/policy.json`. This module owns the *structural* contract: what a
// stage file and a policy file may contain. Semantic refusal (production-like
// names, denied hosts, `https`, `${VAR}`-only credentials, declared login
// recipes, known app idents, ceiling clamping) belongs to `catalog.ts`, which
// turns one decode failure into a value-free diagnostic.
//
// Credentials are references and nothing else: every credential field is a
// whole `${VARIABLE}` reference resolved from the configuration root `.env` at
// the moment of use (`catalog.ts` `resolveStageCredential`). The schema cannot
// enforce that a string *is* a reference — a literal that fails the check must
// produce a diagnostic that never quotes it — so the check lives in the
// catalog, which formats its own message.
import { Schema } from "effect";
import { ArrayFormatter, ParseError } from "effect/ParseResult";
import {
	formatIssuePath,
	sanitizeIssueMessage,
} from "../../contracts/decode.ts";

/** The ident grammar a stage file stem has to match. */
export const STAGE_IDENT_PATTERN = /^[a-z0-9][a-z0-9-]{0,62}$/;

/** How a stage may be used, as a real control: `read-only` refuses every
 * state-changing request, `writable` allows them. */
export const stageAccessSchema = Schema.Literal("read-only", "writable");

/** When a derived test plan must wait for the developer (phase 3 reads it; the
 * field is configuration from phase 1 on). */
export const stagePlanApprovalSchema = Schema.Literal(
	"always",
	"when-writing",
	"never",
);

/** What a staged application is: a UI to drive, an API to read, a mail catcher
 * to wait on, or a probe for version discovery. */
export const stageAppKindSchema = Schema.Literal(
	"ui",
	"api",
	"mail-catcher",
	"probe",
);

/** The credential values a *login form* may type, in section order. */
export const STAGE_CREDENTIAL_FIELDS = [
	"username",
	"password",
	"totp",
] as const;
export const stageCredentialFieldSchema = Schema.Literal(
	...STAGE_CREDENTIAL_FIELDS,
);

/** The credential values one role may reference: the login form's three, plus
 * the OAuth 2.0 refresh token an unattended `refresh_token` role exchanges for
 * access tokens (`add-stage-oauth2-auth`). A refresh token is never typed into a
 * page, so it is not a login field. */
export const STAGE_ROLE_CREDENTIAL_FIELDS = [
	...STAGE_CREDENTIAL_FIELDS,
	"refreshToken",
] as const;
export const stageRoleCredentialFieldSchema = Schema.Literal(
	...STAGE_ROLE_CREDENTIAL_FIELDS,
);

/** The OAuth 2.0 grants a stage role may declare. The implicit and password
 * grants are deliberately absent: both are refused by the schema, so a stage
 * file that declares one is excluded with a value-free diagnostic. */
export const STAGE_OAUTH2_GRANTS = [
	"client_credentials",
	"refresh_token",
	"authorization_code",
] as const;
export const stageOAuth2GrantSchema = Schema.Literal(...STAGE_OAUTH2_GRANTS);

/** How a confidential client authenticates at the token endpoint: HTTP basic
 * (the default) or the client id and secret in the form body. */
export const stageOAuth2ClientAuthSchema = Schema.Literal("basic", "body");

/** One named OAuth 2.0 provider of a stage. Every credential is a whole
 * `${VARIABLE}` reference, exactly as a role's are; `catalog.ts` refuses a
 * literal without quoting it. */
export const stageOAuth2ProviderSchema = Schema.Struct({
	tokenEndpoint: Schema.String,
	authorizationEndpoint: Schema.optional(Schema.String),
	clientId: Schema.String,
	clientSecret: Schema.optional(Schema.String),
	scope: Schema.optional(Schema.Array(Schema.String)),
	audience: Schema.optional(Schema.String),
	clientAuth: Schema.optional(stageOAuth2ClientAuthSchema),
});

/** The OAuth 2.0 providers a stage declares, by name. */
export const stageOAuth2Schema = Schema.Struct({
	providers: Schema.Record({
		key: Schema.String,
		value: stageOAuth2ProviderSchema,
	}),
});

/** Where a login step finds one element: an accessible label, a role plus its
 * accessible name, or a raw selector. At least one is required, and the catalog
 * refuses a locator that names none. */
export const stageLocatorSchema = Schema.Struct({
	label: Schema.optional(Schema.String),
	role: Schema.optional(Schema.String),
	name: Schema.optional(Schema.String),
	selector: Schema.optional(Schema.String),
});

/** One field of one login step: which credential goes into it, and where. */
export const stageLoginFieldSchema = Schema.Struct({
	credential: stageCredentialFieldSchema,
	label: Schema.optional(Schema.String),
	role: Schema.optional(Schema.String),
	name: Schema.optional(Schema.String),
	selector: Schema.optional(Schema.String),
});

/** One page of a login: the fields it fills, the control that submits it, and
 * whether it may be absent (the "Stay signed in?" style prompt). */
export const stageLoginStepSchema = Schema.Struct({
	optional: Schema.optional(Schema.Boolean),
	fields: Schema.Array(stageLoginFieldSchema),
	submit: Schema.optional(stageLocatorSchema),
});

/** When a login counts as complete. */
export const stageLoginSuccessSchema = Schema.Struct({
	/** The main frame must have left this origin (an application origin, or the
	 * identity provider's when the application itself is the IdP page). */
	notOrigin: Schema.optional(Schema.String),
	/** The URL must match this substring. */
	url: Schema.optional(Schema.String),
	/** This text must be visible. */
	text: Schema.optional(Schema.String),
});

/** A declarative login: an ordered multi-page form (a single-page form is one
 * step), HTTP basic authentication through the session's credentials, or the
 * `interactive` kind (`add-stage-interactive-login`): a login this server
 * cannot perform at all, so the developer performs it in a headed window. An
 * `interactive` recipe declares no steps — its `success` is the only
 * declaration, and it is required (`validateRecipe`). */
export const stageLoginRecipeKindSchema = Schema.Literal(
	"form",
	"http-basic",
	"interactive",
);
export const stageLoginRecipeSchema = Schema.Struct({
	kind: stageLoginRecipeKindSchema,
	/** The origin the recipe's steps run on; informational for `http-basic`. */
	origin: Schema.optional(Schema.String),
	steps: Schema.optional(Schema.Array(stageLoginStepSchema)),
	success: Schema.optional(stageLoginSuccessSchema),
});

/** Whether this server may open a headed window for a stage whose login it
 * cannot automate. The operator sets the policy; a stage may only narrow it
 * (default `local`). */
export const stageInteractiveLoginSchema = Schema.Literal("local", "never");

/** One role of one staged application. `login` names a recipe of the stage's
 * own `logins` table, or the reserved recipe kind `oauth2` — a login this server
 * performs against a declared provider instead of typing into a page. A role
 * with no credential reference needs none. */
export const stageRoleSchema = Schema.Struct({
	login: Schema.optional(Schema.String),
	username: Schema.optional(Schema.String),
	password: Schema.optional(Schema.String),
	totp: Schema.optional(Schema.String),
	/** The `oauth2` recipe's own fields: which provider, which grant, and the
	 * origins a browser request gets the role's bearer token on. */
	provider: Schema.optional(Schema.String),
	grant: Schema.optional(stageOAuth2GrantSchema),
	bearerOrigins: Schema.optional(Schema.Array(Schema.String)),
	/** The refresh token a `refresh_token` grant exchanges for access tokens. */
	refreshToken: Schema.optional(Schema.String),
});

/**
 * Whether a role selects the `oauth2` recipe.
 *
 * The new fields decide, never the bare name: `oauth2` stays a legal name for a
 * recipe of a stage's own `logins` table, which existing stage files declare
 * (MIG-001). A role that carries `provider` or `grant` is an OAuth 2.0 role, and
 * such a role has to say `login: "oauth2"` — the two directions are checked by
 * `validateOAuth2Role`.
 */
export function isOAuth2Role(role: StageRole): boolean {
	return role.provider !== undefined || role.grant !== undefined;
}

/** A declared version probe: a path on the application's own origin and the
 * dotted field of its JSON answer that carries the version. */
export const stageVersionProbeSchema = Schema.Struct({
	path: Schema.String,
	field: Schema.String,
});

export const stageAppSchema = Schema.Struct({
	label: Schema.String,
	/** Optional link to a configured app ident (`apps/definitions`). */
	app: Schema.optional(Schema.String),
	url: Schema.String,
	kind: stageAppKindSchema,
	/** The product a mail-catcher application speaks (`mailpit`). */
	api: Schema.optional(Schema.String),
	roles: Schema.optional(
		Schema.Record({ key: Schema.String, value: stageRoleSchema }),
	),
	version: Schema.optional(stageVersionProbeSchema),
});

/** One method-specific exception to a read-only stage's method guard. */
export const stageReadOnlyExceptionSchema = Schema.Struct({
	origin: Schema.String,
	pathPrefix: Schema.String,
	methods: Schema.optional(Schema.Array(Schema.String)),
});

/** Per-stage bounds. Every one of them is clamped to the policy ceiling. */
export const stageLimitsSchema = Schema.Struct({
	maxSessions: Schema.optional(
		Schema.Number.pipe(
			Schema.filter((value) => Number.isInteger(value) && value > 0, {
				message: () => "expected a positive integer",
			}),
		),
	),
	maxActionsPerMinute: Schema.optional(
		Schema.Number.pipe(
			Schema.filter((value) => Number.isInteger(value) && value > 0, {
				message: () => "expected a positive integer",
			}),
		),
	),
	maxWaitSeconds: Schema.optional(
		Schema.Number.pipe(
			Schema.filter((value) => Number.isInteger(value) && value > 0, {
				message: () => "expected a positive integer",
			}),
		),
	),
	maxScreenshots: Schema.optional(
		Schema.Number.pipe(
			Schema.filter((value) => Number.isInteger(value) && value > 0, {
				message: () => "expected a positive integer",
			}),
		),
	),
	maxRecordingMinutes: Schema.optional(
		Schema.Number.pipe(
			Schema.filter((value) => Number.isInteger(value) && value > 0, {
				message: () => "expected a positive integer",
			}),
		),
	),
	/** How long one hand-off may wait for the developer before the deadline ends
	 * it. Defaults to 900 s, ceilinged at 1800 s. */
	maxLoginHandoffSeconds: Schema.optional(
		Schema.Number.pipe(
			Schema.filter((value) => Number.isInteger(value) && value > 0, {
				message: () => "expected a positive integer",
			}),
		),
	),
});

/** Test-data conventions and cleanup hints. Free text, never a credential. */
export const stageDataSchema = Schema.Struct({
	prefix: Schema.optional(Schema.String),
	notes: Schema.optional(Schema.String),
	cleanup: Schema.optional(Schema.String),
});

/** Where the process knowledge of this stage lives in the wiki. */
export const stageWikiSchema = Schema.Struct({
	processes: Schema.optional(Schema.Array(Schema.String)),
});

/** One stage definition file. The ident has to equal the file stem. */
export const stageDefinitionSchema = Schema.Struct({
	ident: Schema.String,
	displayName: Schema.String,
	environment: Schema.String,
	system: Schema.String,
	access: stageAccessSchema,
	planApproval: Schema.optional(stagePlanApprovalSchema),
	exclusive: Schema.optional(Schema.Boolean),
	/** Allow `http` for a host that is not loopback. Deliberate and staged: a
	 * plaintext stage carries credentials in the clear. */
	insecureHttp: Schema.optional(Schema.Boolean),
	apps: Schema.Record({ key: Schema.String, value: stageAppSchema }),
	logins: Schema.optional(
		Schema.Record({ key: Schema.String, value: stageLoginRecipeSchema }),
	),
	/** The named OAuth 2.0 providers a role's `oauth2` recipe selects from. */
	oauth2: Schema.optional(stageOAuth2Schema),
	allowedOrigins: Schema.optional(Schema.Array(Schema.String)),
	readOnlyExceptions: Schema.optional(
		Schema.Array(stageReadOnlyExceptionSchema),
	),
	data: Schema.optional(stageDataSchema),
	limits: Schema.optional(stageLimitsSchema),
	/** Narrow the policy for this stage: `never` denies interactive login here
	 * even where the policy allows it. `local` under a `never` policy is ignored,
	 * because a stage may never widen what the operator denied. */
	interactiveLogin: Schema.optional(stageInteractiveLoginSchema),
	wiki: Schema.optional(stageWikiSchema),
	/** Whether a successful login of this stage may leave a bounded identity in
	 * the server's memory cache (`add-stage-identity-cache`). Absent reads as
	 * `true`: the cache is the default, and a stage that must never keep a
	 * sign-on says `false`. */
	identityCache: Schema.optional(Schema.Boolean),
});
export type StageDefinition = typeof stageDefinitionSchema.Type;

/** The stage app as the decoded file declares it. */
export type StageApp = typeof stageAppSchema.Type;
/** One role of a staged application. */
export type StageRole = typeof stageRoleSchema.Type;
/** One declared login recipe. */
export type StageLoginRecipe = typeof stageLoginRecipeSchema.Type;
/** The recipe kinds a stage may declare. */
export type StageLoginRecipeKind = typeof stageLoginRecipeKindSchema.Type;
/** The interactive-login policy value. */
export type StageInteractiveLogin = typeof stageInteractiveLoginSchema.Type;
/** One login step of a form recipe. */
export type StageLoginStep = typeof stageLoginStepSchema.Type;
/** Where one login field is: label, role+name, or selector. */
export type StageLocator = typeof stageLocatorSchema.Type;
/** Per-stage bounds, as declared. */
export type StageLimits = typeof stageLimitsSchema.Type;
/** One read-only method exception. */
export type StageReadOnlyException = typeof stageReadOnlyExceptionSchema.Type;
/** The declared version probe of one staged application. */
export type StageVersionProbe = typeof stageVersionProbeSchema.Type;
/** The credential fields a login form may type. */
export type StageCredentialField = typeof stageCredentialFieldSchema.Type;
/** The credential fields a role may reference. */
export type StageRoleCredentialField =
	typeof stageRoleCredentialFieldSchema.Type;
/** One OAuth 2.0 grant a role may declare. */
export type StageOAuth2Grant = typeof stageOAuth2GrantSchema.Type;
/** One named OAuth 2.0 provider of a stage. */
export type StageOAuth2Provider = typeof stageOAuth2ProviderSchema.Type;
/** How a client authenticates at the token endpoint. */
export type StageOAuth2ClientAuth = typeof stageOAuth2ClientAuthSchema.Type;
/** The bounds of the in-memory stage identity cache
 * (`add-stage-identity-cache`). All three are ceilings: a stage cannot raise
 * them, and a policy that sets none reads as the documented defaults. */
export const stageIdentityCachePolicySchema = Schema.Struct({
	/** How long one captured identity lives, from its capture and never extended
	 * by a read. Defaults to 240 (four hours). */
	ttlMinutes: Schema.optional(
		Schema.Number.pipe(
			Schema.filter((value) => Number.isInteger(value) && value > 0, {
				message: () => "expected a positive integer",
			}),
		),
	),
	/** How many `(stage, role)` identities the process keeps at once; the oldest
	 * capture is evicted first. Defaults to 8. */
	maxEntries: Schema.optional(
		Schema.Number.pipe(
			Schema.filter((value) => Number.isInteger(value) && value > 0, {
				message: () => "expected a positive integer",
			}),
		),
	),
	/** How often a living session re-captures its identity into the cache, so a
	 * long run's rotated token is what a later session reuses. Defaults to 120
	 * (two minutes). */
	refreshSeconds: Schema.optional(
		Schema.Number.pipe(
			Schema.filter((value) => Number.isInteger(value) && value > 0, {
				message: () => "expected a positive integer",
			}),
		),
	),
});
export type StageIdentityCachePolicy =
	typeof stageIdentityCachePolicySchema.Type;

/** The global policy file: the operator's deny list and the ceilings no stage
 * may exceed. Both optional; absent means "no denial, documented defaults". */
export const stagePolicySchema = Schema.Struct({
	deniedHostPatterns: Schema.optional(Schema.Array(Schema.String)),
	ceilings: Schema.optional(stageLimitsSchema),
	/** The allow-list-wide interactive-login policy. Absent reads as `local`. */
	interactiveLogin: Schema.optional(stageInteractiveLoginSchema),
	/** The identity cache's ceilings. Absent reads as the documented defaults. */
	identityCache: Schema.optional(stageIdentityCachePolicySchema),
});
export type StagePolicy = typeof stagePolicySchema.Type;

/** One value-free complaint about one stage or policy file. It names the file * and the field, and never a value — in particular never a credential that
 * failed the reference check. */
export interface StageIssue {
	readonly path: string;
	readonly message: string;
}

/** Decode a stage document. A failure answers value-free issues (the offending
 * value is stripped exactly as the transport contracts strip it), so a literal
 * password in a stage file never appears in a diagnostic, a log or a response. */
export function decodeStageDefinition(
	value: unknown,
): DecodeResult<StageDefinition> {
	return decodeStageDocument("stage", stageDefinitionSchema, value);
}

/** Decode the global policy document. */
export function decodeStagePolicy(value: unknown): DecodeResult<StagePolicy> {
	return decodeStageDocument("stage-policy", stagePolicySchema, value);
}

type DecodeResult<T> =
	| { readonly ok: true; readonly value: T }
	| { readonly ok: false; readonly issues: readonly StageIssue[] };

function decodeStageDocument<T>(
	id: string,
	schema: Schema.Schema<T>,
	value: unknown,
): DecodeResult<T> {
	try {
		const decoded = Schema.decodeUnknownSync(
			schema,
			// An unknown field is a typo in an allow-list file, so it is refused
			// rather than silently dropped.
			{ onExcessProperty: "error" },
		)(value) as T;
		return { ok: true, value: decoded };
	} catch (error) {
		if (!(error instanceof ParseError)) throw error;
		const issues = ArrayFormatter.formatErrorSync(error)
			.slice(0, 8)
			.map((issue) => ({
				path: formatIssuePath(issue.path),
				message: sanitizeIssueMessage(issue.message),
			}));
		return {
			ok: false,
			issues:
				issues.length > 0
					? issues
					: [{ path: "$", message: `${id}: expected a valid document` }],
		};
	}
}
