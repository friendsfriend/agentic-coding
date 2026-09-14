// Which routes own an environment backend. Pure policy, so the shell and the
// tests share one answer and an attach/dashboard route can never accidentally
// claim (or stop) a server it does not own.
export interface EnvironmentOwnership {
	/** Attached to a backend this process must not stop. */
	attachUrl?: string;
	/** Explicit backend URL (--devenv-url / AGENTIC_DEVENV_URL / DEVENV_URL). */
	explicitUrl?: string;
	/** home/manager/unified route (the long-lived shell). */
	home: boolean;
	/** Interactive dummy-data route. */
	isTest: boolean;
	/** Headless `--json` read: no renderer, no ownership. */
	json: boolean;
}

/**
 * Ownership rule (design decision 1/2): only the managed unified/home route
 * spawns a backend, and any explicit URL means "attach to what is already
 * running". Dash, test and JSON reads never own a server stack.
 */
export function ownsEnvironmentBackend(route: EnvironmentOwnership): boolean {
	if (route.attachUrl || route.explicitUrl) return false;
	if (route.isTest || route.json) return false;
	return route.home;
}
