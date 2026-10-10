// The agent environment capability's run-environment keys and the in-process
// server endpoint that mints it (`add-agent-environment-tools`).
//
// The durable run never holds the instance token: it receives the base URL of
// the unified server plus the capability `environmentTokenFor` derives for its
// own owner, and calls `/api/v1/agent-env/*` with both. The engine and the
// server are one process (single-Bun-application), so the endpoint is a
// module-level publication from the composition root rather than another
// configuration surface; the capability itself is derived in `server/auth.ts`,
// and only the owner string it is bound to is composed here.
import {
	ENVIRONMENT_OWNER_HEADER,
	environmentTokenFor,
} from "../server/auth.ts";

/** Base URL of the unified server the environment tools call. */
export const ENVIRONMENT_URL_ENV = "AGENTIC_ENV_URL";
/** The owner-scoped environment capability (`environmentTokenFor`). */
export const ENVIRONMENT_TOKEN_ENV = "AGENTIC_ENV_TOKEN";
/** Header naming the owner the capability was minted for. Re-exported from
 * the authorization module, so the header the tools send and the header the
 * server verifies can never drift apart. */
export { ENVIRONMENT_OWNER_HEADER };

/** The owner every run of one workflow acts as, so a workflow's implementation,
 * verifier and debug runs share its apps. */
export function environmentOwnerFor(workflowId: string): string {
	return `workflow:${workflowId}`;
}

export interface EnvironmentServerEndpoint {
	readonly url: string;
	readonly token: string;
}

let endpoint: EnvironmentServerEndpoint | undefined;

/** Publish the server the environment tools call, from the one place that knows
 * the listener's address and the instance token. */
export function publishEnvironmentServer(
	next: EnvironmentServerEndpoint,
): void {
	endpoint = { url: next.url, token: next.token };
}

export function environmentServer(): EnvironmentServerEndpoint | undefined {
	return endpoint;
}

/** Drop the endpoint on shutdown, but only the one this server published. */
export function clearEnvironmentServer(token: string): void {
	if (endpoint?.token === token) endpoint = undefined;
}

/** The run-environment entries that give one workflow's runs their own
 * owner-scoped environment capability. Empty when no server is published (a
 * workflow run outside the server process) or when the run has no workflow id,
 * so a run is never handed a capability for an owner it does not have. */
export function environmentRunEnv(workflowId: string): Record<string, string> {
	const published = endpoint;
	if (!published || workflowId.trim() === "") return {};
	return {
		[ENVIRONMENT_URL_ENV]: published.url,
		[ENVIRONMENT_TOKEN_ENV]: environmentTokenFor(
			published.token,
			environmentOwnerFor(workflowId),
		),
	};
}
