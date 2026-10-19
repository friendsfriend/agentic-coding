// Credential-safe login of a stage-bound session
// (`add-stage-testing-foundation`, task 3.5).
//
// One function runs one role's declared recipe. Two rules hold everywhere in
// this module:
//
// * **A credential value exists only between `resolve` and `fill`.** It is never
//   put into a message, a return value, a log line or a telemetry attribute; the
//   only thing this module remembers about a filled field is its *locator*, so
//   the next screenshot can cover it.
// * **Every failure is named.** `credential-missing` names the variable,
//   `login-step-not-found` names the step index, `login-mfa-required` says the
//   page asked for a factor the recipe does not provide, and none of them
//   contains a value.
//
// The recipe forms are the three the design names: a `form` of ordered steps
// (an Entra ID login is identifier page → password page → an optional "Stay
// signed in?" prompt, across the stage's allowed IdP origins), `http-basic`
// through the context's own credentials, and no recipe at all for an
// application without authentication.
import { createHmac } from "node:crypto";
import {
	resolveStageCredential,
	StageCredentialError,
	type StageEntry,
} from "../stages/catalog.ts";
import { sanitizeStageUrl } from "../stages/guard.ts";
import type {
	StageCredentialField,
	StageLoginRecipe,
	StageLoginStep,
} from "../stages/schema.ts";
import {
	type ActionTarget,
	type BrowserSession,
	BrowserSessionError,
} from "./session.ts";
import type { DriverHttpCredentials, DriverLocator } from "./types.ts";

/** The longest one login may take, whichever bound is smaller. */
const LOGIN_MAX_WAIT_MS = 20_000;
/** How often the success condition is re-checked. */
const POLL_INTERVAL_MS = 250;
/** The per-control bound inside one step. */
const STEP_CONTROL_TIMEOUT_MS = 5_000;

/** The controls that mean "a second factor the recipe does not provide" is
 * being asked for. Probed only after the success wait has already failed. */
const MFA_PROBES: readonly DriverLocator[] = [
	{ selector: 'input[autocomplete="one-time-code"]' },
	{ selector: 'input[name="otc"]' },
	{ label: "Enter code" },
	{ label: "Code" },
];

export interface StageLoginInput {
	readonly session: BrowserSession;
	/** The allow-listed stage the session is bound to. */
	readonly entry: StageEntry;
	readonly appKey: string;
	readonly role: string;
	readonly configDir: string;
	/** Install HTTP basic credentials on the session (the pool remembers them so
	 * a recording's replacement context keeps them). */
	readonly installHttpCredentials?: (
		credentials: DriverHttpCredentials,
	) => Promise<void>;
	readonly now?: () => number;
}

export interface StageLoginResult {
	/** The sanitized landing URL: origin plus path, never a query or fragment. */
	readonly url: string;
	/** How many steps ran, and which optional ones were skipped. */
	readonly steps: number;
	readonly skipped: readonly number[];
	/** The application declares no roles, so there was nothing to type. */
	readonly notRequired?: boolean;
}

/** Run one role's login recipe. Throws `BrowserSessionError` with the code the
 * spec names; never a value. */
export async function runStageLogin(
	input: StageLoginInput,
): Promise<StageLoginResult> {
	const { session, entry } = input;
	session.assertStage(entry.ident);
	if (session.recording)
		throw new BrowserSessionError(
			"recording-active",
			"this session is recording; stop the recording before logging in, so a credential is never written to a video",
			409,
		);
	const app = entry.stage.apps[input.appKey];
	if (!app)
		throw new BrowserSessionError(
			"stage-app-unknown",
			`stage ${entry.ident} declares no application ${JSON.stringify(input.appKey)}`,
			404,
		);
	const roles = app.roles ?? {};
	if (Object.keys(roles).length === 0)
		return {
			url: sanitizeStageUrl(session.url),
			steps: 0,
			skipped: [],
			notRequired: true,
		};
	const role = roles[input.role];
	if (!role)
		throw new BrowserSessionError(
			"login-failed",
			`${input.appKey} declares no role ${JSON.stringify(input.role)}; it declares ${Object.keys(roles).join(", ")}`,
			400,
		);
	if (role.login === undefined)
		return {
			url: sanitizeStageUrl(session.url),
			steps: 0,
			skipped: [],
			notRequired: true,
		};
	const recipe = entry.stage.logins?.[role.login];
	if (!recipe)
		throw new BrowserSessionError(
			"login-failed",
			`${input.appKey}.${input.role} names the login recipe ${JSON.stringify(role.login)}, which the stage does not declare`,
			400,
		);
	const timeoutMs =
		Math.min(LOGIN_MAX_WAIT_MS, entry.limits.maxWaitSeconds * 1_000) || 1;
	if (recipe.kind === "http-basic")
		return await runHttpBasic(input, recipe, timeoutMs);
	return await runFormLogin(input, recipe, timeoutMs);
}

// ---------------------------------------------------------------------------
// One credential, one fill (`browser_fill` with `credential`)
// ---------------------------------------------------------------------------

export interface StageCredentialFillInput {
	readonly session: BrowserSession;
	readonly entry: StageEntry;
	readonly appKey: string;
	readonly role: string;
	readonly field: StageCredentialField;
	/** The element to fill, as the tool named it: a snapshot ref or a selector. */
	readonly target: ActionTarget;
	readonly timeoutMs: number;
	readonly configDir: string;
}

/**
 * `browser_fill({ credential })`: resolve one reference and type it.
 *
 * The value exists between the resolver and the driver's `fill` and nowhere
 * else — no return value, no message — and the element it went into is recorded
 * on the session so the next screenshot covers it. A `totp` reference holds the
 * shared secret and types a derived code, exactly as a login recipe does: a
 * six-digit code is the one thing an agent cannot read out of a stage file.
 */
export async function fillStageCredential(
	input: StageCredentialFillInput,
): Promise<void> {
	const { session } = input;
	session.assertStage(input.entry.ident);
	if (session.recording)
		throw new BrowserSessionError(
			"recording-active",
			"this session is recording; stop the recording before filling a credential, so it is never written to a video",
			409,
		);
	// Resolving first means a missing variable fills nothing at all.
	const secret = credential(input, input.field);
	const value = input.field === "totp" ? totpCode(secret) : secret;
	await session.fillCredential(
		{ selector: session.selectorFor(input.target) },
		value,
		input.timeoutMs,
	);
}

// ---------------------------------------------------------------------------
// http-basic
// ---------------------------------------------------------------------------

async function runHttpBasic(
	input: StageLoginInput,
	recipe: StageLoginRecipe,
	timeoutMs: number,
): Promise<StageLoginResult> {
	const { session } = input;
	const credentials: DriverHttpCredentials = {
		username: credential(input, "username"),
		password: credential(input, "password"),
	};
	if (input.installHttpCredentials)
		await input.installHttpCredentials(credentials);
	else await session.context.setHttpCredentials(credentials);
	session.httpCredentials = credentials;
	// The credentials apply to the *next* request, so the current page is
	// re-opened: a browser does exactly this after a 401.
	const url = session.url;
	const status = url ? await session.goto(url, timeoutMs) : null;
	if (typeof status === "number" && status >= 400)
		throw new BrowserSessionError(
			"login-failed",
			`the application answered ${status} with the configured HTTP credentials`,
			401,
		);
	// The credentials *are* the login: the page answered below the error range with
	// them installed. Only a condition the recipe itself declares can hold the call
	// open any longer, and a condition that never holds is named rather than
	// silently ignored — which is why the wait follows `success` alone. A recipe's
	// `origin` is not a success condition here: for `http-basic` it only says which
	// origin the stage answers on (the catalog documents that), and waiting on it
	// would hold every basic-auth login open until its timeout.
	if (recipe.success !== undefined) {
		if (!(await waitForSuccess(input, recipe, timeoutMs, url)))
			throw new BrowserSessionError(
				"login-timeout",
				`the login did not reach its success condition within ${timeoutMs} ms`,
				408,
			);
	}
	return { url: sanitizeStageUrl(session.url), steps: 0, skipped: [] };
}

// ---------------------------------------------------------------------------
// form
// ---------------------------------------------------------------------------

async function runFormLogin(
	input: StageLoginInput,
	recipe: StageLoginRecipe,
	timeoutMs: number,
): Promise<StageLoginResult> {
	const steps = recipe.steps ?? [];
	const now = input.now ?? (() => Date.now());
	const deadline = now() + timeoutMs;
	// The page the recipe starts on: what "the login is done" falls back to when
	// the recipe declares no success condition of its own.
	const startedUrl = input.session.url;
	const skipped: number[] = [];
	let ran = 0;
	// Every credential the recipe needs is resolved *before* anything is typed, so
	// a missing variable leaves the form untouched instead of half-filled.
	const values = new Map<string, string>();
	for (const step of steps) {
		for (const field of step.fields) {
			const key = `${field.credential}`;
			if (values.has(key)) continue;
			const value = credential(input, field.credential);
			// A `totp` reference holds the shared secret, never a code: the code is
			// derived now, so the same secret can be used for the next login too.
			values.set(key, field.credential === "totp" ? totpCode(value) : value);
		}
	}
	const remaining = () => Math.max(1, deadline - now());
	for (const [index, step] of steps.entries()) {
		const present = await stepControlPresent(
			input,
			step,
			Math.min(STEP_CONTROL_TIMEOUT_MS, remaining()),
		);
		if (!present) {
			if (step.optional === true) {
				skipped.push(index);
				continue;
			}
			throw new BrowserSessionError(
				"login-step-not-found",
				`login step ${index} could not be filled: its control did not appear within ${STEP_CONTROL_TIMEOUT_MS} ms`,
				408,
			);
		}
		ran += 1;
		for (const field of step.fields) {
			const value = values.get(`${field.credential}`);
			if (value === undefined) continue;
			await input.session.fillCredential(
				locatorOf(field),
				value,
				Math.min(STEP_CONTROL_TIMEOUT_MS, remaining()),
			);
		}
		if (step.submit)
			await input.session.clickControl(
				locatorOf(step.submit),
				Math.min(STEP_CONTROL_TIMEOUT_MS, remaining()),
			);
	}
	if (await waitForSuccess(input, recipe, remaining(), startedUrl)) {
		return { url: sanitizeStageUrl(input.session.url), steps: ran, skipped };
	}
	// The success condition never held. If the page is now asking for a second
	// factor the recipe does not provide, that is the honest answer; otherwise the
	// login simply did not finish.
	for (const probe of MFA_PROBES) {
		if (await input.session.locatorCount(probe).catch(() => 0))
			throw new BrowserSessionError(
				"login-mfa-required",
				`the login page asks for a second factor the recipe does not provide; the stage needs a TOTP-capable method or a conditional-access exception`,
				403,
			);
	}
	throw new BrowserSessionError(
		"login-timeout",
		`the login did not reach its success condition within ${timeoutMs} ms`,
		408,
	);
}

/** Whether one step's control (its submit, or its first field) is on the page. */
async function stepControlPresent(
	input: StageLoginInput,
	step: StageLoginStep,
	timeoutMs: number,
): Promise<boolean> {
	const control = step.submit ?? step.fields[0];
	if (!control) return true;
	try {
		await input.session.waitForControl(locatorOf(control), timeoutMs);
		return true;
	} catch {
		return false;
	}
}

/** One locator descriptor from a recipe field or submit control. */
function locatorOf(control: {
	readonly label?: string;
	readonly role?: string;
	readonly name?: string;
	readonly selector?: string;
}): DriverLocator {
	return {
		...(control.selector === undefined ? {} : { selector: control.selector }),
		...(control.label === undefined ? {} : { label: control.label }),
		...(control.role === undefined ? {} : { role: control.role }),
		...(control.name === undefined ? {} : { name: control.name }),
	};
}

/**
 * Poll the recipe's success condition until it holds or the bound runs out.
 *
 * A declared `success` is used as declared. Without one, the login is complete
 * when the page is no longer the page the recipe started on — the identity
 * provider redirected back to the application. That fallback is a real
 * condition, not an immediate yes: a page that never moves answers
 * `login-timeout`, which is the honest answer for a recipe whose credentials were
 * rejected.
 */
async function waitForSuccess(
	input: StageLoginInput,
	recipe: StageLoginRecipe,
	timeoutMs: number,
	startedUrl: string,
): Promise<boolean> {
	const now = input.now ?? (() => Date.now());
	const deadline = now() + Math.max(1, timeoutMs);
	for (;;) {
		if (await successHolds(input, recipe, startedUrl)) return true;
		if (now() >= deadline) return false;
		await sleep(Math.min(POLL_INTERVAL_MS, Math.max(1, deadline - now())));
	}
}

async function successHolds(
	input: StageLoginInput,
	recipe: StageLoginRecipe,
	startedUrl: string,
): Promise<boolean> {
	// A declared condition is used as declared, exactly as the hand-off detector
	// reads it.
	if (recipe.success !== undefined)
		return await declaredSuccessHolds({ session: input.session, recipe });
	const url = input.session.url;
	if (recipe.origin !== undefined)
		return originOf(url) !== originOf(recipe.origin);
	// Nothing declared and no recipe origin: the login is done when the page has
	// left the page the recipe started on, which the recipe's own submits are the
	// only way to reach.
	return url !== startedUrl || originOf(url) !== originOf(startedUrl);
}

/**
 * Whether the role's *declared* success condition holds right now.
 *
 * The automated recipe wraps this with its started-URL fallback; the login
 * hand-off (`add-stage-interactive-login`) uses it alone, because a hand-off
 * with no declared condition has no automatic ending at all — only the
 * developer saying Done ends it. It answers a boolean and nothing else: no page
 * text, no URL, no credential.
 */
export async function declaredSuccessHolds(input: {
	readonly session: BrowserSession;
	readonly recipe: StageLoginRecipe;
}): Promise<boolean> {
	const success = input.recipe.success;
	if (success?.text !== undefined)
		return await input.session
			.wait({ text: success.text, timeoutMs: 1 })
			.then(() => true)
			.catch(() => false);
	const url = input.session.url;
	if (success?.url !== undefined) return url.includes(success.url);
	if (success?.notOrigin !== undefined)
		return originOf(url) !== originOf(success.notOrigin);
	return false;
}

/**
 * The silent SSO check (`add-stage-interactive-login`, D2 step 2): a session
 * that already lives in the interactive browser may hold a login another app on
 * the same identity provider can use. The server opens the application and
 * waits up to `timeoutMs` for the recipe's declared condition; it answers a
 * boolean, and the caller reports `ok` with `via: "existing-session"`.
 *
 * Nothing is copied from one session to another: the check only looks at the
 * session's own context.
 */
export async function silentLoginCheck(input: {
	readonly session: BrowserSession;
	readonly recipe: StageLoginRecipe;
	readonly url: string;
	readonly timeoutMs: number;
	readonly now?: () => number;
}): Promise<boolean> {
	if (input.recipe.success === undefined) return false;
	const now = input.now ?? (() => Date.now());
	const deadline = now() + Math.max(1, input.timeoutMs);
	await input.session
		.goto(input.url, Math.max(1, input.timeoutMs))
		.catch(() => null);
	for (;;) {
		if (
			await declaredSuccessHolds({
				session: input.session,
				recipe: input.recipe,
			}).catch(() => false)
		)
			return true;
		if (now() >= deadline) return false;
		await sleep(Math.min(POLL_INTERVAL_MS, Math.max(1, deadline - now())));
	}
}

function originOf(value: string): string | undefined {
	try {
		return new URL(value).origin;
	} catch {
		return undefined;
	}
}

function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

/** The names one credential lookup needs, without a value. */
interface CredentialContext {
	readonly entry: StageEntry;
	readonly appKey: string;
	readonly role: string;
	readonly configDir: string;
}

/** Resolve one credential of the role, or refuse naming the variable. */
function credential(
	input: CredentialContext,
	field: StageCredentialField,
): string {
	try {
		return resolveStageCredential(
			input.entry.stage,
			input.appKey,
			input.role,
			field,
			input.configDir,
		);
	} catch (error) {
		if (error instanceof StageCredentialError)
			throw new BrowserSessionError("credential-missing", error.message, 409);
		throw error;
	}
}

// ---------------------------------------------------------------------------
// TOTP (RFC 6238)
// ---------------------------------------------------------------------------

/** One RFC 6238 code: HMAC-SHA1, 6 digits, 30-second step. A value that is an
 * `otpauth://` URI contributes its `secret` parameter. */
export function totpCode(secret: string, at: number = Date.now()): string {
	const key = base32Decode(secretOf(secret));
	const counter = Math.floor(at / 1000 / 30);
	const buffer = Buffer.alloc(8);
	buffer.writeBigUInt64BE(BigInt(counter), 0);
	const digest = createHmac("sha1", key).update(buffer).digest();
	// RFC 4226 dynamic truncation: the low nibble of the last digest byte is the
	// offset into the digest. Masking it is the whole rule — an unmasked byte is an
	// out-of-range index as often as not.
	const offset = (digest[digest.length - 1] ?? 0) & 0x0f;
	const binary =
		((digest[offset] ?? 0) & 0x7f) * 0x1000000 +
		((digest[offset + 1] ?? 0) << 16) +
		((digest[offset + 2] ?? 0) << 8) +
		(digest[offset + 3] ?? 0);
	return String(binary % 1_000_000).padStart(6, "0");
}

/** The shared secret inside an `otpauth://` URI, or the value itself. */
function secretOf(value: string): string {
	if (!value.startsWith("otpauth://")) return value.trim();
	try {
		const secret = new URL(value).searchParams.get("secret");
		return (secret ?? "").trim();
	} catch {
		return "";
	}
}

const BASE32_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";

function base32Decode(value: string): Buffer {
	const normalized = value.replace(/[\s=]/g, "").toUpperCase();
	let bits = 0;
	let accumulator = 0;
	const bytes: number[] = [];
	for (const character of normalized) {
		const index = BASE32_ALPHABET.indexOf(character);
		if (index < 0) continue;
		accumulator = (accumulator << 5) | index;
		bits += 5;
		if (bits >= 8) {
			bits -= 8;
			bytes.push((accumulator >> bits) & 0xff);
		}
	}
	return Buffer.from(bytes);
}
