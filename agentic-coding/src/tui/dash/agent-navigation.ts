// Pure, observation-scoped indexes. Route requests and row paint must not scan
// workflow history or search the agents list again for each requested run/row.
import type { DashboardData } from "../../contracts/workflow.ts";

export function indexDashboardAgents(data: DashboardData) {
	const runsById = new Map(data.state.runs.map((run) => [run.id, run]));
	const positionsByRunId = new Map<string, number>();
	const runByRole = new Map<string, string | undefined>();
	const pendingRoles = new Set<string>();
	data.agents.forEach((agent, index) => {
		if (agent.runId) positionsByRunId.set(agent.runId, index);
		runByRole.set(agent.role, agent.runId);
		if (agent.status === "pending" || agent.status === "working")
			pendingRoles.add(agent.role);
	});
	return { runsById, positionsByRunId, runByRole, pendingRoles };
}

export type DashboardAgentIndex = ReturnType<typeof indexDashboardAgents>;

export function focusedAgentPosition(
	index: DashboardAgentIndex,
	runId: string,
): number {
	return (
		index.positionsByRunId.get(runId) ?? (index.runsById.has(runId) ? 0 : -1)
	);
}

/** A superseded run gets one transient exact-run row, alongside (not instead
 * of) the ordinary latest-role rows. It disappears when no longer authoritative.
 * The accepted observation is never changed, and no handle is synthesized. */
export function focusDashboardAgent(
	data: DashboardData,
	index: DashboardAgentIndex,
	runId: string | undefined,
): DashboardData {
	if (!runId || index.positionsByRunId.has(runId)) return data;
	const run = index.runsById.get(runId);
	if (!run) return data;
	return {
		...data,
		agents: [
			{
				role: run.role,
				status: run.status,
				runId: run.id,
				...(run.hostSocket ? { hostSocket: run.hostSocket } : {}),
				...(run.conversationId ? { conversationId: run.conversationId } : {}),
			},
			...data.agents,
		],
	};
}
