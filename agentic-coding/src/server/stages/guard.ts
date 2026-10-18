// The stage request guard (`add-stage-testing-foundation`, tasks 2.1–2.2).
//
// Every stage-bound browser context installs one guard, and the guard is the
// only thing that decides whether a request may leave the browser: a main-frame
// document navigation outside the stage's origin allow-list is refused with
// `origin-not-allowed`, and on a `read-only` stage a request whose method is not
// `GET` or `HEAD` is refused with `stage-read-only` (that rule holds for every
// request, subresources included). Both refusals are recorded for the driving
// tool call, so a hidden background upload is reported rather than silently
// dropped, and no refusal ever carries a credential — a refused URL is reduced
// to origin plus pathname before it is recorded.
//
// The guard is pure domain code: the Playwright adapter only asks it and aborts
// when it says no.
import type { EffectiveStageLimits } from "./catalog.ts";
import type { StageReadOnlyException } from "./schema.ts";

/** What a stage-bound session is allowed to reach. Also the policy the pool
 * re-installs when a recording swaps the context. */
export interface StageSessionPolicy {
	readonly ident: string;
	readonly access: "read-only" | "writable";
	readonly origins: readonly string[];
	readonly readOnlyExceptions: readonly StageReadOnlyException[];
	readonly limits: EffectiveStageLimits;
}

/** One request the browser is about to make. */
export interface StageRequestInfo {
	readonly url: string;
	readonly method: string;
	readonly resourceType: string;
	/** True for a main-frame document navigation. The origin allow-list applies
	 * to those alone: a page may still load its own fonts, styles, scripts and
	 * (read-only) API calls from wherever it likes, and aborting those would break
	 * the very application the stage is for. The driver computes exactly this flag
	 * (`DriverRequestInfo`, `types.ts`). */
	readonly isMainFrameNavigation: boolean;
}

/** One refused request, as the driving tool call reports it. */
export interface StageRefusal {
	readonly code: "origin-not-allowed" | "stage-read-only";
	/** Origin plus pathname: never the query, never the fragment, both of which
	 * can carry a token. */
	readonly url: string;
	readonly method: string;
}

/** Methods that cannot change state. `OPTIONS` is a CORS preflight, which
 * changes nothing and whose refusal would break the UI it protects. */
const SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);

/** Scheme-relative and inline requests that never leave the process. */
const LOCAL_SCHEMES = new Set(["about:", "blob:", "data:", "javascript:"]);

/** What the driver adapter is handed: a predicate that aborts when it answers
 * `false` (the guard records the refusal itself). */
export type StageRequestGuard = (request: StageRequestInfo) => boolean;

/**
 * Build the guard of one stage-bound context. `record` is called once per
 * refused request, so the caller can attach the refusals to the response of the
 * tool call that triggered them.
 */
export function createStageGuard(
	policy: StageSessionPolicy,
	record: (refusal: StageRefusal) => void,
): StageRequestGuard {
	const origins = new Set(policy.origins);
	return (request) => {
		let url: URL;
		try {
			url = new URL(request.url);
		} catch {
			// An unparseable target cannot be checked, so it is refused.
			record({
				code: "origin-not-allowed",
				url: sanitizeStageUrl(request.url),
				method: request.method,
			});
			return false;
		}
		if (LOCAL_SCHEMES.has(url.protocol)) return true;
		if (url.protocol !== "http:" && url.protocol !== "https:") return true;
		const method = request.method.toUpperCase();
		// The allow-list scopes *navigations*, not the page's own requests: a
		// subresource off the list is not this guard's business, and the read-only
		// method rule below still applies to it.
		if (request.isMainFrameNavigation && !origins.has(url.origin)) {
			record({
				code: "origin-not-allowed",
				url: sanitizeStageUrl(request.url),
				method,
			});
			return false;
		}
		if (policy.access === "writable") return true;
		if (SAFE_METHODS.has(method)) return true;
		if (hasReadOnlyException(policy, url, method)) return true;
		record({
			code: "stage-read-only",
			url: sanitizeStageUrl(request.url),
			method,
		});
		return false;
	};
}

/**
 * A read-only exception: the same origin, a pathname under its prefix, and a
 * method it lists (an omitted list means `POST`, the plain-form case of a
 * search endpoint that only *looks* like a write).
 */
function hasReadOnlyException(
	policy: StageSessionPolicy,
	url: URL,
	method: string,
): boolean {
	return policy.readOnlyExceptions.some((exception) => {
		if (originOf(exception.origin) !== url.origin) return false;
		if (!url.pathname.startsWith(exception.pathPrefix)) return false;
		return (exception.methods ?? ["POST"]).some(
			(candidate) => candidate.toUpperCase() === method,
		);
	});
}

function originOf(value: string): string | undefined {
	try {
		return new URL(value).origin;
	} catch {
		return undefined;
	}
}

/**
 * Reduce a URL to what a refusal may report: origin and pathname. A query
 * string is where an OAuth `code`, an access token or a session id lives, so it
 * is dropped rather than redacted — nothing downstream then has to remember to.
 */
export function sanitizeStageUrl(value: string): string {
	try {
		const url = new URL(value);
		return `${url.origin}${url.pathname}`;
	} catch {
		// Not a URL at all: keep the value out of the report entirely.
		return "(unparseable url)";
	}
}
