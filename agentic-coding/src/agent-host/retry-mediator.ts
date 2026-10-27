import type {
	AgentTaskRetryRequest,
	AgentTaskRetryResult,
} from "../contracts/actions.ts";
import { HostClient } from "./client.ts";
import { hostIdentityPaths, readHostCertificate } from "./host-identity.ts";
import { safeFailureMessage } from "./protocol.ts";
import { hostRetryTargetFor } from "./retry-authority.ts";

/** Operator-side mediator for the host's private retry capability. The caller
 * must already have crossed the server's operator authorization boundary. */
export async function retryAgentTaskAsOperator(
	request: AgentTaskRetryRequest,
): Promise<AgentTaskRetryResult> {
	const target = hostRetryTargetFor(request.runId, request.conversationId);
	if (!target)
		return {
			taskId: safeFailureMessage(request.taskId, 128),
			status: "refused",
			reason: "host recovery authority is unavailable",
		};
	try {
		const endpoint = async () => ({
			socket: hostIdentityPaths(target.socketPath).socket,
			fingerprint: readHostCertificate(target.socketPath),
		});
		const answer = await new HostClient(
			endpoint,
			30_000,
			target.capability,
		).retryTask(
			request.runId,
			request.conversationId,
			request.taskId,
			request.generation,
		);
		return {
			taskId: answer.taskId,
			status: answer.status,
			...(answer.reason
				? { reason: answer.reason }
				: answer.status === "retried"
					? {
							reason:
								"external effects may repeat; exactly-once execution is not guaranteed",
						}
					: {}),
		};
	} catch {
		return {
			taskId: safeFailureMessage(request.taskId, 128),
			status: "refused",
			reason: "host retry request failed",
		};
	}
}
