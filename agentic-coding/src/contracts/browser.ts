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

/** `browser_open`: a raw URL, or an app endpoint the calling workflow holds. */
export const browserOpenRequestSchema = Schema.Struct({
	url: Schema.optional(browserField(2048)),
	app: Schema.optional(browserName(256)),
	endpoint: Schema.optional(browserName(256)),
	session: sessionField,
	viewport: Schema.optional(browserViewportSchema),
});
export type BrowserOpenRequest = typeof browserOpenRequestSchema.Type;

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

/** `browser_screenshot`: returned to the model always, stored only when the
 * agent asked for evidence. */
export const browserScreenshotRequestSchema = Schema.Struct({
	session: sessionField,
	ref: refField,
	selector: selectorField,
	fullPage: Schema.optional(Schema.Boolean),
	evidence: Schema.optional(Schema.Boolean),
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
