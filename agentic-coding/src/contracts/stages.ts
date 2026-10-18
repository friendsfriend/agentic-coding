// Stage wire contract (`add-stage-testing-foundation`): the read surfaces both
// the Settings section and a run's `stage_info` tool consume, and the one write
// the credential flow needs. Pure types and schemas; no I/O.
//
// Nothing here can carry a credential *value*: a credential appears as a field
// name and a status (`set` / `missing VAR`), and the set flow takes a value in
// and never returns one.
import { Schema } from "effect";

export interface StageCredentialStatus {
	readonly field: "username" | "password" | "totp";
	/** The `.env` variable this field references. Present with every status, so a
	 * value that is already `set` can still be replaced: the key a write would
	 * touch is the key the row names. */
	readonly variable: string;
	/** `set`, or `missing <VAR>`. */
	readonly status: string;
}

export interface StageRoleStatus {
	readonly role: string;
	readonly login?: string;
	readonly loginKind?: "form" | "http-basic";
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
