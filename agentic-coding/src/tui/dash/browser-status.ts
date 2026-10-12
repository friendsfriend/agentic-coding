// Browser install status for the Settings section (`add-agent-browser-sessions`,
// task 2.1). Reads go through the typed backend client when a transport is
// configured and fall back to the in-process server module for a transport-less
// run, exactly like the classifier status read. The view never downloads
// anything itself: it asks the server and renders the state it reads back.
//
// Unlike the classifier's read, a failed *status* read clears the snapshot: the
// browser section's retry row is what tells the developer the server is
// unreachable, and a stale `installing…` would hide that behind a download
// progress bar that is not moving.
import type { BrowserStatusResponse } from "../../contracts/browser.ts";
import {
	browserStatus as inProcessBrowserStatus,
	cancelBrowserInstall as inProcessCancelBrowserInstall,
	installBrowser as inProcessInstallBrowser,
} from "../../server/browser/operations.ts";
import { backendClient } from "../../server/client.ts";

/** Last status read; undefined before the first refresh. */
let cached: BrowserStatusResponse | undefined;
/** Message from the most recent failed call, consumed by the view's toast. */
let lastError: string | undefined;

export function browserSnapshot(): BrowserStatusResponse | undefined {
	return cached;
}

export function lastBrowserError(): string | undefined {
	return lastError;
}

export function clearBrowserError(): void {
	lastError = undefined;
}

/** Drop the cached snapshot (tests, and a scope switch). */
export function clearBrowserSnapshot(): void {
	cached = undefined;
	lastError = undefined;
}

function message(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

/** Read the current install state and effective bounds. */
export async function refreshBrowserStatus(): Promise<
	BrowserStatusResponse | undefined
> {
	const client = backendClient();
	try {
		cached = client
			? await client.browserStatus()
			: await inProcessBrowserStatus();
		lastError = undefined;
	} catch (error) {
		// An unread or unauthorized server is a section error, not a stale value:
		// the snapshot is dropped so the section renders its unavailable/retry
		// row instead of continuing to show what was true before it went away.
		lastError = message(error);
		cached = undefined;
	}
	return cached;
}

/** Ask the server to download Chromium. Idempotent while one runs. */
export async function startBrowserInstall(): Promise<
	BrowserStatusResponse | undefined
> {
	const client = backendClient();
	try {
		cached = client
			? await client.browserInstall()
			: await inProcessInstallBrowser();
		lastError = undefined;
	} catch (error) {
		lastError = message(error);
	}
	return cached;
}

/** Stop an in-flight download. */
export async function cancelBrowserInstallJob(): Promise<
	BrowserStatusResponse | undefined
> {
	const client = backendClient();
	try {
		cached = client
			? await client.browserInstallCancel()
			: await inProcessCancelBrowserInstall();
		lastError = undefined;
	} catch (error) {
		lastError = message(error);
	}
	return cached;
}
