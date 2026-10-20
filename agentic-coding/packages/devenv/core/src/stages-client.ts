// The stage catalog read (`open-stage-from-environments`).
//
// The environment TUI needs one read of the configured stages so the table
// pages can offer "open this stage in the browser". The catalog is the server's
// own allow-listed view (`GET /api/v1/stages`, `src/server/stages/routes.ts`):
// an excluded file is not in `stages` at all, and a stage carries application
// keys, labels and URLs — never a credential value and never a login recipe.
//
// The answer is the standard `{ ok, value }` envelope every instance route
// writes, so this module unwraps it and nothing else. A failed read throws with
// the server's message, which is what a picker shows when its own host is
// unreachable.
import type {
	StageAppStatus,
	StageStatus,
	StagesStatusResponse,
} from "../../../../src/contracts/stages.ts";
import type { ClientDeps } from "./client-types.ts";
import { handleFetchError } from "./error-handler.ts";

export type { StageAppStatus, StageStatus, StagesStatusResponse };

/** How long one catalog read may take. A picker is an interactive surface: a
 * request that never answers has to end in a message, not in a spinner. */
export const STAGE_CATALOG_TIMEOUT_MS = 15_000;

interface StageCatalogEnvelope {
	ok?: boolean;
	value?: StagesStatusResponse;
	error?: { message?: string };
}

export async function getStages(
	deps: ClientDeps,
	signal?: AbortSignal,
): Promise<StagesStatusResponse> {
	const response = await deps.fetchFn(`${deps.baseUrl}/api/v1/stages`, {
		method: "GET",
		...(signal ? { signal } : {}),
	});
	if (!response.ok) await handleFetchError(response, deps.onError);
	const parsed = (await response.json().catch(() => undefined)) as
		| StageCatalogEnvelope
		| undefined;
	if (!parsed || parsed.error || !parsed.value)
		throw new Error(
			parsed?.error?.message ?? `stages unavailable (${response.status})`,
		);
	return parsed.value;
}
