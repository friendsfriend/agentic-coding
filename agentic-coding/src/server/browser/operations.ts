// Server-owned browser operations (`add-agent-browser-sessions`, task 2.1).
//
// The Settings section never downloads anything itself: it reads status, and it
// asks the server to install or cancel. This module is that surface, and it is
// the in-process twin of `/api/v1/browser/*`, exactly like `server/classifier.ts`
// is for the classifier's install routes.

import { resolveConfigRoot } from "../../config-root.ts";
import type { BrowserStatusResponse } from "../../contracts/browser.ts";
import { browserStatusValue } from "./routes.ts";
import { browserRuntime } from "./runtime.ts";

function runtime() {
	return browserRuntime(resolveConfigRoot());
}

/** Current install state and the effective browser bounds. */
export async function browserStatus(): Promise<BrowserStatusResponse> {
	const server = runtime();
	return browserStatusValue(server.installer, server.settings());
}

/** Start the opt-in Chromium download. Idempotent while one runs, non-blocking:
 * the caller polls `browserStatus` for the phase. */
export async function installBrowser(): Promise<BrowserStatusResponse> {
	const server = runtime();
	void server.installer.install();
	return browserStatusValue(server.installer, server.settings());
}

/** Stop an in-flight download; its partial directory is left for Playwright to
 * replace on the next attempt. */
export async function cancelBrowserInstall(): Promise<BrowserStatusResponse> {
	const server = runtime();
	await server.installer.cancel();
	return browserStatusValue(server.installer, server.settings());
}
