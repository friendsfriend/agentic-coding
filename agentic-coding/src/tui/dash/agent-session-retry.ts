import type {
	AgentTaskRetryRequest,
	AgentTaskRetryResult,
} from "../../contracts/actions.ts";

export interface AgentSessionRetryInput {
	readonly session?: {
		readonly runId: string;
		readonly conversationId?: string;
	};
	readonly connected: boolean;
	readonly taskId: string;
	readonly generation?: number;
}

export interface AgentSessionRetryDependencies {
	readonly recover: (runId: string) => Promise<void>;
	readonly retry: (
		request: AgentTaskRetryRequest,
	) => Promise<AgentTaskRetryResult>;
	readonly isCurrent: () => boolean;
}

/** Dispatch exactly the identity shown by the dashboard through its recovery
 * and authenticated retry client. The host still validates ownership, current
 * task state, workflow state and the episode generation. */
export async function dispatchAgentSessionRetry(
	input: AgentSessionRetryInput,
	dependencies: AgentSessionRetryDependencies,
): Promise<AgentTaskRetryResult | undefined> {
	const { session, taskId, generation } = input;
	const conversationId = session?.conversationId;
	if (
		!session ||
		!input.connected ||
		!conversationId ||
		!taskId ||
		typeof generation !== "number" ||
		!Number.isSafeInteger(generation) ||
		generation < 1
	)
		return undefined;
	const request: AgentTaskRetryRequest = {
		runId: session.runId,
		conversationId,
		taskId,
		generation,
	};
	await dependencies.recover(session.runId);
	if (!dependencies.isCurrent()) return undefined;
	const result = await dependencies.retry(request);
	return dependencies.isCurrent() ? result : undefined;
}
