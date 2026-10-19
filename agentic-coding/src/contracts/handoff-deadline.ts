// The one human rendering of a login hand-off's deadline
// (`add-stage-interactive-login`, USAB-101/USAB-103).
//
// A hand-off ends at a fixed instant, and the developer is the one who has to
// act before it: the banner in the window, the dashboard's question modal and
// the record's own words all say how long is left. They are rendered from this
// one function so the two surfaces cannot drift, and it is a *local wall-clock
// time with a relative remainder* rather than an ISO instant — the reader is a
// person looking at their own clock, and a misjudged deadline costs the login.
//
// The machine-readable form stays where a machine reads it: a tool result's
// `deadlineAt` and the coordination log line are ISO instants. Nothing here
// reads a page, a credential or a URL.

/** One minute, in milliseconds. */
const MINUTE_MS = 60_000;

/** `15:04 local (in about 14 minutes)`: the deadline as a developer reads it.
 * An instant that cannot be parsed reports so instead of guessing, and an
 * already-passed deadline says that rather than a negative remainder. `now` is
 * the caller's clock: this module is pure, so it reads no ambient time. */
export function formatHandoffDeadline(
	at: number | string,
	now: number,
): string {
	const deadline = typeof at === "number" ? at : Date.parse(at);
	if (!Number.isFinite(deadline)) return "an unknown time";
	const local = new Date(deadline);
	const clock = `${pad(local.getHours())}:${pad(local.getMinutes())} local`;
	const remaining = deadline - now;
	if (remaining <= 0) return `${clock} (already due)`;
	const minutes = Math.round(remaining / MINUTE_MS);
	if (minutes < 1) return `${clock} (in less than a minute)`;
	if (minutes === 1) return `${clock} (in about a minute)`;
	// A long bound (a question's own day-long expiry) reads better in hours than
	// as a four-digit number of minutes.
	if (minutes >= 90) {
		const hours = Math.round(minutes / 60);
		return `${clock} (in about ${hours} hours)`;
	}
	return `${clock} (in about ${minutes} minutes)`;
}

function pad(value: number): string {
	return String(value).padStart(2, "0");
}
