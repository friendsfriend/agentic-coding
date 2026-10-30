import { deliverClarifications } from "../agent-host/clarification-delivery.ts";
import { HostClient } from "../agent-host/client.ts";
import { hostLayout } from "../agent-host/layout.ts";
import { orchestratorRuntimeDir } from "../agent-host/orchestrator-session.ts";
import type { WorkflowView } from "../contracts/workflow.ts";
import { orchestratorMonitorMode } from "../workflow/profiles.ts";
import { loadAgentConfig } from "./config.ts";
import type { ServerOperations } from "./handlers.ts";

/** Server-owned receipt reconciliation. No recovery/spawn or active-session
 * lookup: a missing pinned Home remains pending. Call on question creation,
 * attachment, read/reconnect and explicit retry; native request IDs deduplicate
 * acceptance even when the process dies before the workflow commit. */
export function createClarificationReconciler(
	operations: Pick<ServerOperations, "view" | "action">,
	configDir?: string,
	monitorMode = () => orchestratorMonitorMode(loadAgentConfig().agents),
) {
	const flights = new Map<string, Promise<void>>();
	const client = new HostClient(
		hostLayout(orchestratorRuntimeDir(configDir)).socketPath,
		2000,
	);
	return async (
		repo: string,
		workflowId: string,
		explicit = false,
	): Promise<void> => {
		if (!explicit && monitorMode() !== "wake") return;
		const key = JSON.stringify([repo, workflowId]);
		const previous = flights.get(key);
		if (previous) return previous;
		const flight = (async () => {
			const view = operations.view(repo, workflowId);
			await deliverClarifications(
				view,
				(request) => client.deliverClarification(request),
				async (receipt, questionId, askingRunId) => {
					const latest: WorkflowView = operations.view(repo, workflowId);
					const question = latest.developerDialogue?.find(
						(item) => item.id === questionId,
					);
					const attachment = question?.clarification?.attachment;
					if (
						!attachment ||
						question.clarification?.delivery.status === "accepted"
					)
						return;
					operations.action(
						{
							repo,
							workflowId,
							revision: latest.revision,
							actionId: "clarification.ack",
							input: {
								questionId,
								askingRunId,
								homeRunId: receipt.runId,
								epoch: attachment.epoch,
								receipt: receipt.deliveryId,
							},
						},
						{
							principal: "orchestrator",
							clarificationAuthority: {
								attachment: {
									hostId: receipt.hostId,
									conversationId: receipt.conversationId,
									epoch: attachment.epoch,
								},
								messages: [],
								sources: [],
							},
						},
					);
				},
			);
		})();
		flights.set(key, flight);
		try {
			await flight;
		} finally {
			if (flights.get(key) === flight) flights.delete(key);
		}
	};
}
