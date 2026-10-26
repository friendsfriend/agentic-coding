import { expect, test } from "bun:test";
import { dispatchAgentSessionRetry } from "../../src/tui/dash/agent-session-retry.ts";

test("dashboard retry dispatches the displayed identity after session recovery", async () => {
	const events: string[] = [];
	let received: unknown;
	const result = await dispatchAgentSessionRetry(
		{
			session: { runId: "run-9", conversationId: "17" },
			connected: true,
			taskId: "task-7",
			generation: 4,
		},
		{
			recover: async (runId) => {
				events.push(`recover:${runId}`);
			},
			retry: async (request) => {
				events.push("retry");
				received = request;
				return { taskId: request.taskId, status: "retried" };
			},
			isCurrent: () => true,
		},
	);

	expect(events).toEqual(["recover:run-9", "retry"]);
	expect(received).toEqual({
		runId: "run-9",
		conversationId: "17",
		taskId: "task-7",
		generation: 4,
	});
	expect(result).toEqual({ taskId: "task-7", status: "retried" });
});

test("dashboard retry does not send stale or disconnected session metadata", async () => {
	let calls = 0;
	const dependencies = {
		recover: async () => {},
		retry: async () => {
			calls++;
			return { taskId: "task-7", status: "retried" as const };
		},
		isCurrent: () => true,
	};

	await expect(
		dispatchAgentSessionRetry(
			{
				session: { runId: "run-9", conversationId: "17" },
				connected: false,
				taskId: "task-7",
				generation: 4,
			},
			dependencies,
		),
	).resolves.toBeUndefined();
	await expect(
		dispatchAgentSessionRetry(
			{
				session: { runId: "run-9", conversationId: "17" },
				connected: true,
				taskId: "task-7",
				generation: undefined,
			},
			dependencies,
		),
	).resolves.toBeUndefined();
	expect(calls).toBe(0);
});
