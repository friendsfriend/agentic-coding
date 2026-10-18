// Stage catalog status for the Settings **Stages** section
// (`add-stage-testing-foundation`, task 5.1).
//
// The section is a read of the connected server (`GET /api/v1/stages`) plus the
// one write the credential flow needs (`POST /api/v1/stages/credential`, which
// resolves the variable against the catalog server-side). A transport-less run
// falls back to the in-process server module, exactly like the browser section's
// status read.
//
// A credential value is passed *in* and never kept: the module holds the catalog
// snapshot only, and the snapshot carries names and presence, never values.
import { createCustomFetch } from "@devenv/core/src/custom-fetch.ts";
import type { StagesStatusResponse } from "../../contracts/stages.ts";
import { backendClient } from "../../server/client.ts";
import {
	setStageCredentialValue as inProcessSetStageCredential,
	stagesStatus as inProcessStagesStatus,
} from "../../server/stages/operations.ts";

/** Last catalog read; undefined before the first refresh. */
let cached: StagesStatusResponse | undefined;
/** Message from the most recent failed call, consumed by the view's toast. */
let lastError: string | undefined;

/** How long one stage request may take. The section is a read of a local
 * server, and a request that never answers must not leave the section loading
 * for ever: an aborted one is a failure with a message, not a hang. */
const STAGE_REQUEST_TIMEOUT_MS = 15_000;

export function stageSnapshot(): StagesStatusResponse | undefined {
	return cached;
}

export function lastStageError(): string | undefined {
	return lastError;
}

export function clearStageError(): void {
	lastError = undefined;
}

/** Drop the cached snapshot (tests, and a configuration-root switch). */
export function clearStageSnapshot(): void {
	cached = undefined;
	lastError = undefined;
}

function message(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

/** The server URL of the connected environment, when the shell has one. */
function serverUrl(): string | undefined {
	return backendClient()?.baseUrl;
}

async function readJson(response: Response): Promise<unknown> {
	const parsed = (await response.json().catch(() => undefined)) as
		| { ok?: boolean; value?: unknown; error?: { message?: string } }
		| undefined;
	if (!response.ok || !parsed || parsed.error)
		throw new Error(
			parsed?.error?.message ?? `stages unavailable (${response.status})`,
		);
	return parsed.value;
}

/** Read the whole catalog: allow-listed stages and the refused files. */
export async function refreshStageStatus(): Promise<
	StagesStatusResponse | undefined
> {
	const baseUrl = serverUrl();
	try {
		if (baseUrl) {
			const value = await readJson(
				await createCustomFetch()(`${baseUrl}/api/v1/stages`, {
					signal: AbortSignal.timeout(STAGE_REQUEST_TIMEOUT_MS),
				}),
			);
			cached = value as StagesStatusResponse;
		} else {
			// A transport-less shell reads its own configuration root.
			cached = inProcessStagesStatus();
		}
		lastError = undefined;
	} catch (error) {
		// An unread or unauthorized server is a section error, not a stale value.
		lastError = message(error);
		cached = undefined;
	}
	return cached;
}

/**
 * Set one credential the catalog references. The value travels one way only:
 * it is the request body, and the answer is the new status. An unknown variable
 * is refused server-side (`credential-unknown`).
 */
export async function setStageCredential(
	variable: string,
	value: string,
): Promise<boolean> {
	const baseUrl = serverUrl();
	try {
		if (baseUrl) {
			const response = await createCustomFetch()(
				`${baseUrl}/api/v1/stages/credential`,
				{
					method: "POST",
					headers: { "content-type": "application/json" },
					body: JSON.stringify({ variable, value }),
					signal: AbortSignal.timeout(STAGE_REQUEST_TIMEOUT_MS),
				},
			);
			await readJson(response);
		} else {
			await inProcessSetStageCredential(variable, value);
		}
		lastError = undefined;
		return true;
	} catch (error) {
		lastError = message(error);
		return false;
	}
}
