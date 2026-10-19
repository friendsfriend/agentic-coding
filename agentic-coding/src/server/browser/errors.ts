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
		/** A value-free machine-readable sub-reason, when the code alone is not
		 * precise enough (`login-handoff-unavailable`: `headless-only-browser`,
		 * `no-display`). It is a fixed vocabulary member, never page content. */
		readonly reason?: string,
		/** Extra value-free fields the error envelope carries (a hand-off's id and
		 * deadline). Never page content and never a credential. */
		readonly details?: Readonly<Record<string, unknown>>,
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
