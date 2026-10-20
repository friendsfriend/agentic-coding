/** Some models call a tool through a strict function schema that lists every
 * property as required, so an optional string the model has no value for
 * arrives as `""` instead of being absent. The server's request schemas reject
 * an empty identifier ("expected a string at least 1 character(s) long"), which
 * made `browser_open({ stage, stageApp })` fail whenever `url`, `app` or
 * `endpoint` came padded. A blank optional identifier means "not given", so it
 * is dropped before the request is sent.
 *
 * Only the named identifier-like keys are touched: a free-text argument (a
 * typed value, a selector) can legitimately be empty and is left alone. */
const OPTIONAL_IDENTIFIER_KEYS = new Set([
	"url",
	"app",
	"endpoint",
	"stage",
	"stageApp",
	"stageRole",
	"path",
	"session",
	"role",
	"ref",
]);

export function withoutBlankOptionals(body: unknown): unknown {
	if (!body || typeof body !== "object" || Array.isArray(body)) return body;
	return Object.fromEntries(
		Object.entries(body).filter(
			([key, value]) =>
				!(
					OPTIONAL_IDENTIFIER_KEYS.has(key) &&
					typeof value === "string" &&
					value.trim() === ""
				),
		),
	);
}
