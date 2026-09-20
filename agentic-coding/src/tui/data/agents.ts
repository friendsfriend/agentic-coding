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
	clearModelCache,
	runtimeModels,
} from "../../workflow/profiles.ts";

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
