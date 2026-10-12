// Browser refusals (`add-agent-browser-sessions`).
//
// One error type for the whole browser surface, with the code the spec names
// (`browser-unavailable`, `browser-crashed`, `app-not-held`, `script-timeout`)
// carried as data. The routes translate the code and status straight into the
// tool's error envelope, so a tool can branch on a code without parsing prose.

export class BrowserPoolError extends Error {
	constructor(
		readonly code: string,
		message: string,
		readonly status = 400,
	) {
		super(message);
		this.name = "BrowserPoolError";
	}
}

/** The refusal a run at the session cap gets when every slot is already its
 * own: waiting would wait for itself. */
export function tooManySessionsMessage(maxSessions: number): string {
	return `this run already holds all ${maxSessions} browser sessions (browser.max_sessions); close one with browser_close or reuse a session you already opened`;
}
