import type { AgentGroup } from "@devenv/types";
import type { ClientDeps } from "./client-types";
import { handleFetchError } from "./error-handler";

export async function getPiSessions(deps: ClientDeps): Promise<AgentGroup[]> {
	const response = await deps.fetchFn(`${deps.baseUrl}/api/pi-sessions`);
	if (!response.ok) {
		await handleFetchError(response, deps.onError);
	}
	const data = (await response.json()) as { agents: AgentGroup[] };
	return data.agents;
}
