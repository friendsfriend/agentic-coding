// Agent-configuration data (establish-opencode-boundaries, task 5.6).
//
// The settings surface reads and writes the agents section through the gateway;
// the pure mutation/format helpers it also needs are re-exported here so a
// feature component never imports the server module that owns them.
import type { AgentsMutationRequest } from "../../contracts/actions.ts";
import type { AgentsListResponse } from "../../contracts/gateway.ts";
import { cache, gateway } from "./index.ts";

export {
	type AgentsMutation,
	applyAgentsMutation,
} from "../../server/config.ts";
export {
	type AgentsConfig,
	BUILTIN_PRESET_NAME,
} from "../../workflow/profiles.ts";

/** The models a `pi-durable` profile can select: every model of every provider
 * the user has configured, resolved in process from the live global-pi
 * credentials. The bundled durable runtime has no model CLI and this needs
 * none — it spawns nothing and never reads the `pi` executable. Resolved
 * asynchronously because availability is pi-ai's: the provider catalog is
 * dynamically imported, so it loads only when a durable profile is actually
 * edited. Rejects when the provider catalog cannot be opened; callers keep
 * their own fallback rather than learning about the failure here. */
export async function durableModels(): Promise<readonly string[]> {
	const { configuredModelList } = await import(
		"../../agent-host/configured-models.ts"
	);
	return await configuredModelList();
}

export function agentsKey(repository?: string): string {
	return `agents:${repository ?? "*"}`;
}

/** The configured agents section (profiles, provenance, conflicts). */
export async function loadAgentConfig(
	repository?: string,
): Promise<AgentsListResponse | undefined> {
	return cache.load(agentsKey(repository), () =>
		gateway().loadAgents(repository),
	);
}

/** Apply one agents mutation; a stale revision is refused by the server. */
export async function saveAgentConfig(
	request: AgentsMutationRequest,
): Promise<void> {
	await gateway().saveAgents(request);
	cache.invalidate(agentsKey(request.repository));
	cache.invalidate("agents:*");
}

export {
	type CredentialPrompt,
	maskingFor,
} from "../../workflow/credentials.ts";
export { VERIFIER_ROLES } from "../../workflow/steps/verification.ts";
