// Server-owned stage operations (`add-stage-testing-foundation`, task 5.1).
//
// The Settings section renders the stage catalog and sets a referenced
// credential, and it does neither itself: it reads status, and it asks the
// server to write one `.env` key. This module is that surface, and it is the
// in-process twin of `/api/v1/stages*`, exactly like `server/browser/operations.ts`
// is for the browser's install routes.
//
// Nothing here returns a credential value: the catalog's own credential status
// is a name and a presence flag, and the write's answer is a status.

import { resolveConfigRoot } from "../../config-root.ts";
import type {
	StageCredentialResponse,
	StageIdentitiesResponse,
	StageIdentityForgetResponse,
	StagesStatusResponse,
} from "../../contracts/stages.ts";
import {
	forgetStageIdentity,
	setStageCredential,
	stageIdentitiesValue,
	stagesStatusValue,
} from "./routes.ts";

function deps() {
	// The catalog's default app-ident read is the same `apps/definitions`
	// directory of this root, so the in-process read and the route agree.
	return { configDir: resolveConfigRoot() };
}

/** The whole catalog: allow-listed stages and the files that were refused. */
export function stagesStatus(): StagesStatusResponse {
	return stagesStatusValue(deps());
}

/** The live identity cache, as the Settings section lists it: `(stage, role,
 * capturedAt, expiresAt)` and nothing else. */
export function stageIdentities(): StageIdentitiesResponse {
	return stageIdentitiesValue();
}

/** Forget cached sign-ins: one `(stage, role)`, every role of one stage, or the
 * whole cache when neither is named. */
export function forgetStageIdentityValue(
	stage?: string,
	role?: string,
): StageIdentityForgetResponse {
	return forgetStageIdentity({
		...(stage === undefined ? {} : { stage }),
		...(role === undefined ? {} : { role }),
	});
}

/** Set one credential the catalog references, by variable name. */
export async function setStageCredentialValue(
	variable: string,
	value: string,
): Promise<StageCredentialResponse> {
	return await setStageCredential(deps(), { variable, value });
}
