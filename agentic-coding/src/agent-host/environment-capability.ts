// The agent environment capability's run-environment keys and the server
// endpoint that mints it (`add-agent-environment-tools`).
//
// The durable run never holds the instance token: it receives the base URL of
// the unified server plus the capability `environmentTokenFor` derives for its
// own owner, and calls `/api/v1/agent-env/*` with both. The capability itself is
// derived in `server/auth.ts`, and only the owner string it is bound to is
// composed here.
//
// The endpoint comes from one of two places, in this order:
//
// 1. the in-process publication (`publishEnvironmentServer`) the unified
//    server's composition root makes, when this process *is* that server;
// 2. the discovery handoff file a running server publishes under the
//    configuration root (`server/environment-discovery.ts`), resolved once per
//    process by `ensureEnvironmentServer()` before any run environment is built.
//
// Without (2) every process that is not the server — the CLI's `workflow
// start`/`workflow drain`, the per-repository `agent host`, a workflow of a
// repository other than the one the shell serves — launched its runs with no
// capability at all, so the `env_*`, `browser_*` and debug tools answered "no
// agent environment capability" (fix-env-tools-for-all-runs).
import path from "node:path";
import { resolveConfigRoot } from "../config-root.ts";
import {
	ENVIRONMENT_OWNER_HEADER,
	environmentTokenFor,
} from "../server/auth.ts";
import { discoverEnvironmentServer } from "../server/environment-discovery.ts";
import {
	ORCHESTRATOR_TOKEN_ENV,
	ORCHESTRATOR_URL_ENV,
} from "./orchestrator-env.ts";

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

/** A server found through the discovery handoff, with the configuration root it
 * was published under: the capability a run receives is only ever derived for a
 * root this process actually resolved. */
interface DiscoveredEnvironmentServer extends EnvironmentServerEndpoint {
	readonly configDir: string;
}

let discovered: DiscoveredEnvironmentServer | undefined;

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

/**
 * Resolve the server the environment tools call before a run environment is
 * built. The in-process publication wins outright; otherwise the discovery
 * handoff file of `configDir` is probed (file read plus one bounded loopback
 * health request) and cached for the runs of this process. A process with no
 * server anywhere keeps today's behaviour — no capability — and every caller
 * can see that from `environmentRunEnv` before it launches anything.
 */
export async function ensureEnvironmentServer(
	configDir: string = resolveConfigRoot(),
): Promise<EnvironmentServerEndpoint | undefined> {
	if (endpoint) return endpoint;
	const resolved = path.resolve(configDir);
	const found = await discoverEnvironmentServer({ configDir: resolved });
	discovered = found ? { ...found, configDir: resolved } : undefined;
	return discovered;
}

/** Forget a discovered endpoint (tests only): the publication is left alone. */
export function resetEnvironmentServerDiscovery(): void {
	discovered = undefined;
}

/** The server runs of this process may act through: the in-process publication,
 * or a discovered server published under the configuration root this process
 * resolves. Never one derived for another root. */
function runServer(): EnvironmentServerEndpoint | undefined {
	if (endpoint) return endpoint;
	if (discovered && discovered.configDir === path.resolve(resolveConfigRoot()))
		return discovered;
	return undefined;
}

/** Drop the endpoint on shutdown, but only the one this server published. */
export function clearEnvironmentServer(token: string): void {
	if (endpoint?.token === token) endpoint = undefined;
}

/** The run-environment entries that give one workflow's runs their own
 * owner-scoped environment capability. Empty when no server is reachable (a
 * workflow run outside the server process, with no server to discover) or when
 * the run has no workflow id, so a run is never handed a capability for an
 * owner it does not have. */
export function environmentRunEnv(workflowId: string): Record<string, string> {
	const server = runServer();
	if (!server || workflowId.trim() === "") return {};
	return {
		[ENVIRONMENT_URL_ENV]: server.url,
		[ENVIRONMENT_TOKEN_ENV]: environmentTokenFor(
			server.token,
			environmentOwnerFor(workflowId),
		),
	};
}

/** Whether a run of this workflow gets an environment capability at all. The
 * launch path asks before it hands a reduced run its assignment, so a run whose
 * tools cannot act is told so instead of discovering it call by call. */
export function environmentToolsAvailable(workflowId: string): boolean {
	return Object.keys(environmentRunEnv(workflowId)).length > 0;
}

/** Resolve operational tools without pretending the Home Orchestrator is a
 * workflow. Its existing capability acts only on the developer's user
 * environment; workflow capabilities retain their original owner binding. */
export function environmentBindingOf(
	env: Readonly<Record<string, string>>,
):
	| { readonly url: string; readonly token: string; readonly owner: string }
	| undefined {
	const workflowId = env.HERDR_WORKFLOW_ID;
	if (workflowId) {
		const url = env[ENVIRONMENT_URL_ENV];
		const token = env[ENVIRONMENT_TOKEN_ENV];
		return url && token
			? { url, token, owner: environmentOwnerFor(workflowId) }
			: undefined;
	}
	const url = env[ORCHESTRATOR_URL_ENV];
	const token = env[ORCHESTRATOR_TOKEN_ENV];
	return url && token ? { url, token, owner: "user" } : undefined;
}
