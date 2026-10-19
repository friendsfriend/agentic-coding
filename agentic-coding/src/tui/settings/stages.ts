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
import type {
	StageIdentitiesResponse,
	StagesStatusResponse,
} from "../../contracts/stages.ts";
import { backendClient } from "../../server/client.ts";
import {
	forgetStageIdentityValue as inProcessForgetStageIdentity,
	setStageCredentialValue as inProcessSetStageCredential,
	stageIdentities as inProcessStageIdentities,
	stagesStatus as inProcessStagesStatus,
} from "../../server/stages/operations.ts";

/** Last catalog read; undefined before the first refresh. */
let cached: StagesStatusResponse | undefined;
/** Last identity-cache read (`add-stage-identity-cache`). */
let identities: StageIdentitiesResponse | undefined;
/** Message from the most recent failed call, consumed by the view's toast. */
let lastError: string | undefined;

/** How long one stage request may take. The section is a read of a local
 * server, and a request that never answers must not leave the section loading
 * for ever: an aborted one is a failure with a message, not a hang. */
const STAGE_REQUEST_TIMEOUT_MS = 15_000;

export function stageSnapshot(): StagesStatusResponse | undefined {
	return cached;
}

/** The live identity cache, or `undefined` before the first read. It carries
 * `(stage, role, captured, expires)` and nothing else. */
export function stageIdentities(): StageIdentitiesResponse | undefined {
	return identities;
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
	identities = undefined;
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
			// The identity cache rides the same read: it is derived from the same
			// catalog, so one round trip per section refresh is the bound.
			identities = (await readJson(
				await createCustomFetch()(`${baseUrl}/api/v1/stages/identity`, {
					signal: AbortSignal.timeout(STAGE_REQUEST_TIMEOUT_MS),
				}),
			)) as StageIdentitiesResponse;
		} else {
			// A transport-less shell reads its own configuration root.
			cached = inProcessStagesStatus();
			identities = inProcessStageIdentities();
		}
		lastError = undefined;
	} catch (error) {
		// An unread or unauthorized server is a section error, not a stale value.
		lastError = message(error);
		cached = undefined;
		identities = undefined;
	}
	return cached;
}

/**
 * Forget the cached sign-in of one `(stage, role)`. The next session of that role
 * starts empty and logs in the normal way; a session that lives right now keeps
 * the state it already has. Answers whether the call went through, leaving the
 * failure in `lastStageError`.
 */
export async function forgetStageIdentity(
	stage: string,
	role: string,
): Promise<boolean> {
	const baseUrl = serverUrl();
	try {
		if (baseUrl) {
			await readJson(
				await createCustomFetch()(`${baseUrl}/api/v1/stages/identity/forget`, {
					method: "POST",
					headers: { "content-type": "application/json" },
					body: JSON.stringify({ stage, role }),
					signal: AbortSignal.timeout(STAGE_REQUEST_TIMEOUT_MS),
				}),
			);
		} else {
			inProcessForgetStageIdentity(stage, role);
		}
		lastError = undefined;
		return true;
	} catch (error) {
		lastError = message(error);
		return false;
	}
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
