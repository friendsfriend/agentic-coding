// Browser wire contract (`add-agent-browser-sessions`): the bodies a durable
// run's `browser_*` tools send to the owner-scoped browser surface, and the
// non-secret status the Settings section reads from the instance-authenticated
// surface. Pure schemas and types; no I/O.
import { Schema } from "effect";

/** One bounded, control-character-free text field. */
function browserText(max: number): Schema.Schema<string> {
	return Schema.String.pipe(
		Schema.maxLength(max),
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
}

const browserField = (max: number) => browserText(max);
/** Free-form text: a script, an expression and a field value are multi-line by
 * nature, so the control-character filter (which rejects `\n` and `\t`) would
 * refuse the ordinary case. Bounded by length only.
 *
 * Captions keep the filtered field: a caption is stored in the evidence
 * manifest, whose own contract is control-character-free. */
const browserFreeText = (max: number) =>
	Schema.String.pipe(Schema.maxLength(max));
const browserName = (max: number) => browserText(max).pipe(Schema.minLength(1));

/** The width and height bounds the server enforces when it opens a session. */
export const browserViewportSchema = Schema.Struct({
	width: Schema.Number.pipe(
		Schema.filter((value) => Number.isFinite(value), {
			message: () => "viewport.width must be a finite number",
		}),
	),
	height: Schema.Number.pipe(
		Schema.filter((value) => Number.isFinite(value), {
			message: () => "viewport.height must be a finite number",
		}),
	),
});

const sessionField = Schema.optional(browserName(64));
const refField = Schema.optional(browserName(32));
const selectorField = Schema.optional(browserField(1024));
const timeoutField = Schema.optional(
	Schema.Number.pipe(
		Schema.filter((value) => Number.isFinite(value) && value > 0, {
			message: () => "timeoutMs must be a positive number",
		}),
	),
);

/** `browser_open`: a raw URL, an app endpoint the calling workflow holds, or a
 * stage application (`add-stage-testing-foundation`). A stage open is bound to
 * the stage for the session's whole life. */
export const browserOpenRequestSchema = Schema.Struct({
	url: Schema.optional(browserField(2048)),
	app: Schema.optional(browserName(256)),
	endpoint: Schema.optional(browserName(256)),
	stage: Schema.optional(browserName(64)),
	stageApp: Schema.optional(browserName(64)),
	/** The role whose cached identity this session starts from
	 * (`add-stage-identity-cache`). Absent means the session starts with an empty
	 * browser, exactly as before: a run that does not ask for an identity never
	 * gets one installed. */
	stageRole: Schema.optional(browserName(64)),
	path: Schema.optional(browserField(1024)),
	session: sessionField,
	viewport: Schema.optional(browserViewportSchema),
});
export type BrowserOpenRequest = typeof browserOpenRequestSchema.Type;

/** One credential a tool may ask the server to resolve and type
 * (`add-stage-testing-foundation`): the role field of one staged application.
 * The value never travels: the server resolves the reference itself. */
export const browserCredentialRefSchema = Schema.Struct({
	app: browserName(64),
	role: browserName(64),
	field: Schema.Literal("username", "password", "totp"),
});
export type BrowserCredentialRef = typeof browserCredentialRefSchema.Type;

/** `browser_snapshot`, `browser_close` and the reads that need no more. */
export const browserSessionRequestSchema = Schema.Struct({
	session: sessionField,
});
export type BrowserSessionRequest = typeof browserSessionRequestSchema.Type;

/** `browser_click`, `browser_fill`, `browser_press`, `browser_select` and
 * `browser_hover`: one body, because they take the same target and exactly one
 * action-specific value. */
export const browserActionRequestSchema = Schema.Struct({
	session: sessionField,
	action: Schema.Literal("click", "fill", "press", "select", "hover"),
	ref: refField,
	selector: selectorField,
	value: Schema.optional(browserFreeText(8192)),
	/** A credential the server fills in, instead of a literal `value`: the
	 * resolved credential of one role field of the session's stage. */
	credential: Schema.optional(browserCredentialRefSchema),
	key: Schema.optional(browserField(64)),
	values: Schema.optional(
		Schema.Array(browserField(512)).pipe(Schema.maxItems(32)),
	),
	timeoutMs: timeoutField,
});
export type BrowserActionRequest = typeof browserActionRequestSchema.Type;

/** `browser_wait`: one of target/text/url, bounded by a timeout. */
export const browserWaitRequestSchema = Schema.Struct({
	session: sessionField,
	ref: refField,
	selector: selectorField,
	text: Schema.optional(browserField(2048)),
	url: Schema.optional(browserField(2048)),
	timeoutMs: timeoutField,
});
export type BrowserWaitRequest = typeof browserWaitRequestSchema.Type;

/** `browser_eval`: JavaScript evaluated in the page. */
export const browserEvalRequestSchema = Schema.Struct({
	session: sessionField,
	code: browserFreeText(20_000).pipe(Schema.minLength(1)),
	timeoutMs: timeoutField,
});
export type BrowserEvalRequest = typeof browserEvalRequestSchema.Type;

/** `browser_console` and `browser_network`: bounded, filterable reads. */
export const browserLogRequestSchema = Schema.Struct({
	session: sessionField,
	level: Schema.optional(browserField(32)),
	status: Schema.optional(
		Schema.Number.pipe(
			Schema.filter((value) => Number.isInteger(value), {
				message: () => "status must be an integer",
			}),
		),
	),
	url: Schema.optional(browserField(2048)),
	limit: Schema.optional(
		Schema.Number.pipe(
			Schema.filter((value) => Number.isInteger(value) && value > 0, {
				message: () => "limit must be a positive integer",
			}),
		),
	),
});
export type BrowserLogRequest = typeof browserLogRequestSchema.Type;

/** `browser_screenshot`: returned to the model by default, stored only when the
 * agent asked for evidence. `view: false` stores it without returning the
 * image (`add-stage-flow-evidence`), which is what keeps a process-flow test
 * from inflating the model's context; it is valid only together with
 * `evidence: true`. */
export const browserScreenshotRequestSchema = Schema.Struct({
	session: sessionField,
	ref: refField,
	selector: selectorField,
	fullPage: Schema.optional(Schema.Boolean),
	evidence: Schema.optional(Schema.Boolean),
	view: Schema.optional(Schema.Boolean),
	caption: Schema.optional(browserField(512)),
});
export type BrowserScreenshotRequest =
	typeof browserScreenshotRequestSchema.Type;

/** `browser_record_start` / `browser_record_stop`. A stop with `keep: false`
 * leaves neither file nor manifest entry behind. */
export const browserRecordRequestSchema = Schema.Struct({
	session: sessionField,
	action: Schema.Literal("start", "stop"),
	keep: Schema.optional(Schema.Boolean),
	caption: Schema.optional(browserField(512)),
});
export type BrowserRecordRequest = typeof browserRecordRequestSchema.Type;

/** `browser_run_script`: Playwright JavaScript against the session page. */
export const browserScriptRequestSchema = Schema.Struct({
	session: sessionField,
	code: browserFreeText(200_000).pipe(Schema.minLength(1)),
	save: Schema.optional(Schema.Boolean),
	caption: Schema.optional(browserField(512)),
	timeoutMs: timeoutField,
});
export type BrowserScriptRequest = typeof browserScriptRequestSchema.Type;

/** `stage_login`: run one role's declared login recipe on a stage-bound session.
 * The server resolves the credential references itself, so this body carries
 * names only. */
export const browserStageLoginRequestSchema = Schema.Struct({
	session: sessionField,
	app: browserName(64),
	role: browserName(64),
});
export type BrowserStageLoginRequest =
	typeof browserStageLoginRequestSchema.Type;

/** `stage_login_wait`: block in the server until the hand-off ends or the
 * timeout is reached. The server caps the wait at the smaller of the remaining
 * deadline and 600 s, whatever the tool asks for. */
export const browserStageLoginWaitRequestSchema = Schema.Struct({
	session: sessionField,
	timeoutSec: Schema.optional(
		Schema.Number.pipe(
			Schema.filter((value) => Number.isFinite(value) && value > 0, {
				message: () => "expected a positive number of seconds",
			}),
		),
	),
});
export type BrowserStageLoginWaitRequest =
	typeof browserStageLoginWaitRequestSchema.Type;

/** One agent-captured value: a name and a short text, both redacted before the
 * journal is written. */
const stageCaptureKey = browserText(128).pipe(Schema.minLength(1));
const stageCaptures = Schema.Record({
	key: stageCaptureKey,
	value: browserFreeText(1024),
});

/** The optional knowledge observation a journal step may carry
 * (`add-stage-flow-evidence`): what the step showed about the process being
 * tested, and — for a contradiction — which cause the agent suspects. */
export const stageKnowledgeSchema = Schema.Struct({
	concept: browserField(256).pipe(Schema.minLength(1)),
	section: Schema.optional(browserField(256)),
	kind: Schema.Literal("confirmed", "contradicted", "missing", "new"),
	suspectedCause: Schema.optional(
		Schema.Literal("product-change", "regression", "unknown"),
	),
});
export type StageKnowledge = typeof stageKnowledgeSchema.Type;

/** `stage_step`: append one server-timestamped step to the workflow's journal.
 * Everything the server already knows — the time, the session's application and
 * role, its current URL, the recording segment and offset — is filled in by the
 * server, never accepted from the caller. */
export const browserStageStepRequestSchema = Schema.Struct({
	session: sessionField,
	label: browserField(512).pipe(Schema.minLength(1)),
	expected: Schema.optional(browserFreeText(4096)),
	observed: Schema.optional(browserFreeText(4096)),
	captures: Schema.optional(stageCaptures),
	evidence: Schema.optional(
		Schema.Array(browserName(32)).pipe(Schema.maxItems(64)),
	),
	knowledge: Schema.optional(stageKnowledgeSchema),
});
export type BrowserStageStepRequest = typeof browserStageStepRequestSchema.Type;

/** `stage_journal`: read the latest journal entries back, bounded and optionally
 * narrowed to one session or application. */
export const browserStageJournalRequestSchema = Schema.Struct({
	session: sessionField,
	app: Schema.optional(browserName(64)),
	limit: Schema.optional(
		Schema.Number.pipe(
			Schema.filter(
				(value) => Number.isInteger(value) && value > 0 && value <= 200,
				{ message: () => "limit must be an integer between 1 and 200" },
			),
		),
	),
});
export type BrowserStageJournalRequest =
	typeof browserStageJournalRequestSchema.Type;

/** The one condition a `stage_wait` waits for: a mail caught by the stage's mail
 * catcher, named by recipient and subject. */
export const stageWaitMailSchema = Schema.Struct({
	to: Schema.optional(browserField(320)),
	subject: Schema.optional(browserField(256)),
});
export type StageWaitMail = typeof stageWaitMailSchema.Type;

/** `until`: exactly one of `text`, `selector`, `url` or `mail`. The filter is
 * what makes "exactly one" a contract rather than a convention the route would
 * have to police. */
export const stageWaitConditionSchema = Schema.Struct({
	text: Schema.optional(browserField(2048)),
	selector: Schema.optional(browserField(1024)),
	url: Schema.optional(browserField(2048)),
	mail: Schema.optional(stageWaitMailSchema),
}).pipe(
	Schema.filter(
		(value) =>
			[
				value.text !== undefined,
				value.selector !== undefined,
				value.url !== undefined,
				value.mail !== undefined,
			].filter(Boolean).length === 1,
		{
			message: () => "`until` takes exactly one of text, selector, url or mail",
		},
	),
);
export type StageWaitCondition = typeof stageWaitConditionSchema.Type;

/** `stage_wait`: poll one condition *inside the server* until it holds or the
 * bound elapses, so a wait costs one tool call rather than one call per poll. */
export const browserStageWaitRequestSchema = Schema.Struct({
	session: sessionField,
	until: stageWaitConditionSchema,
	reload: Schema.optional(Schema.Boolean),
	intervalSeconds: Schema.optional(
		Schema.Number.pipe(
			Schema.filter((value) => Number.isFinite(value) && value > 0, {
				message: () => "intervalSeconds must be a positive number",
			}),
		),
	),
	timeoutSeconds: Schema.optional(
		Schema.Number.pipe(
			Schema.filter((value) => Number.isFinite(value) && value > 0, {
				message: () => "timeoutSeconds must be a positive number",
			}),
		),
	),
});
export type BrowserStageWaitRequest = typeof browserStageWaitRequestSchema.Type;

/** The refusal codes the stage surfaces answer with
 * (`add-stage-testing-foundation`), declared here so the tool side and the
 * route side name the same vocabulary and a test can assert it. */
export const STAGE_ERROR_CODES = [
	"stage-not-configured",
	"stage-app-unknown",
	"stage-mismatch",
	"origin-not-allowed",
	"stage-read-only",
	"stage-rate-limit",
	"stage-held",
	"stage-session-limit",
	"stage-session-restricted",
	"recording-active",
	"credential-missing",
	"login-failed",
	"login-mfa-required",
	"login-timeout",
	"login-step-not-found",
	"login-not-required",
	// `add-stage-interactive-login`: the hand-off vocabulary. `login-needs-user`
	// is deliberately absent — it is a *result*, not a refusal.
	"login-user-unavailable",
	"login-handoff-unavailable",
	"login-handoff-unverified",
	"login-handoff-timeout",
	"login-handoff-aborted",
	"session-held-by-user",
	// `add-stage-identity-cache`: the role an open names has to be one the
	// application declares, or there is no identity whose login could establish it.
	"stage-role-unknown",
	// `add-stage-flow-evidence`: the per-run bounds of a flow test — kept video,
	// stored screenshots and the journal's own file cap — plus a `mail` wait on a
	// session whose application is not a Mailpit mail catcher.
	"stage-recording-limit",
	"stage-screenshot-limit",
	"stage-journal-full",
	"stage-mail-unsupported",
] as const;
export type StageErrorCode = (typeof STAGE_ERROR_CODES)[number];

// ---------------------------------------------------------------------------
// Settings: non-secret install state
// ---------------------------------------------------------------------------

/** Browser install and capability state, server-owned so no view downloads
 * anything itself. */
export interface BrowserStatusResponse {
	readonly available: boolean;
	readonly source: "system-chrome" | "installed-chromium" | "none";
	readonly executablePath?: string;
	readonly channel?: "chrome";
	readonly browsersPath: string;
	readonly systemChrome?: string;
	/** Whether this server can open a visible window at all, which is what a
	 * login hand-off needs. */
	readonly headed: boolean;
	readonly install: {
		readonly phase: "idle" | "downloading" | "ready" | "failed" | "cancelled";
		readonly detail?: string;
		readonly startedAt?: number;
	};
	readonly settings: {
		readonly maxSessions: number;
		readonly idleTtlMs: number;
		readonly viewport: { readonly width: number; readonly height: number };
	};
}

export const browserStatusResponseSchema: Schema.Schema<BrowserStatusResponse> =
	Schema.Struct({
		available: Schema.Boolean,
		source: Schema.Literal("system-chrome", "installed-chromium", "none"),
		executablePath: Schema.optional(Schema.String),
		channel: Schema.optional(Schema.Literal("chrome")),
		browsersPath: Schema.String,
		systemChrome: Schema.optional(Schema.String),
		headed: Schema.Boolean,
		install: Schema.Struct({
			phase: Schema.Literal(
				"idle",
				"downloading",
				"ready",
				"failed",
				"cancelled",
			),
			detail: Schema.optional(Schema.String),
			startedAt: Schema.optional(Schema.Number),
		}),
		settings: Schema.Struct({
			maxSessions: Schema.Number,
			idleTtlMs: Schema.Number,
			viewport: Schema.Struct({
				width: Schema.Number,
				height: Schema.Number,
			}),
		}),
	});

/** The install/cancel routes take no body fields; the filter makes that
 * strict rather than merely empty. */
export const browserInstallRequestSchema = Schema.Struct({}).pipe(
	Schema.filter((value) => Object.keys(value as object).length === 0, {
		message: () => "this route takes no body fields",
	}),
);
