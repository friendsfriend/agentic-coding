import path from "node:path";
import type { OrchestratorSession } from "../../agent-host/orchestrator-session.ts";
import { ordinaryClarification } from "../../contracts/clarification.ts";
import type { DashboardGateway } from "../../contracts/gateway.ts";
import type { DeveloperDialogueRecord } from "../../contracts/workflow.ts";

export function pendingClarifications(
	questions: readonly DeveloperDialogueRecord[] = [],
): DeveloperDialogueRecord[] {
	return questions.filter(
		(item) => item.status === "pending" && ordinaryClarification(item),
	);
}
export function clarificationStatus(
	questions: readonly DeveloperDialogueRecord[],
): string {
	const pending = pendingClarifications(questions);
	const unassigned = pending.filter((item) => !item.clarification).length;
	return `${pending.length} clarification${pending.length === 1 ? "" : "s"} pending · ${unassigned ? `${unassigned} awaiting explicit Home attachment` : pending.some((item) => item.clarification?.delivery.status === "pending") ? "Home delivery pending · open the attached Home or reattach" : "discuss in the attached Home transcript"}`;
}

/** An explicit operator gesture only. Bootstrap does not navigate/focus Home;
 * the server resolves custody from its fixed host socket, never these IDs alone. */
export async function selectWorkflowHome(
	repo: string,
	dependencies: {
		open?: () => Promise<OrchestratorSession>;
		hostIdentity?: (session: OrchestratorSession) => Promise<string>;
	} = {},
) {
	const session = await (
		dependencies.open ??
		(async () => {
			const { openOrchestratorSession } = await import("./session.ts");
			return openOrchestratorSession({ opencodeCwd: repo });
		})
	)();
	if (!session.conversationId)
		throw new Error("Home has no durable conversation identity");
	const hostId = await (
		dependencies.hostIdentity ??
		(async (selected) => {
			const { HostClient } = await import("../../agent-host/client.ts");
			return new HostClient(selected.hostSocket).scheduledIdentity();
		})
	)(session);
	return { session, hostId };
}

// A deliberate developer slash command, never passive natural-language matching.
// Capture the selected Home before the workflow read can yield to navigation.
export async function attachWorkflowHomeFromTranscript(
	gateway: Pick<DashboardGateway, "view" | "action">,
	argument: string | undefined,
	currentRepo: string,
	dependencies: Parameters<typeof selectWorkflowHome>[1] = {},
) {
	const match = argument
		?.trim()
		.match(/^([a-zA-Z0-9][a-zA-Z0-9_-]*)(?:\s+([\s\S]+))?$/);
	if (!match?.[1])
		throw new Error("An explicit workflow id is required for Home attachment");
	const repo = path.resolve(match[2] ?? currentRepo);
	const workflowId = match[1];
	const selected = await selectWorkflowHome(repo, dependencies);
	const view = await gateway.view(repo, workflowId);
	return attachWorkflowHome(
		gateway,
		{ repo, workflowId, revision: view.revision },
		{
			open: async () => selected.session,
			hostIdentity: async () => selected.hostId,
		},
	);
}

export async function attachWorkflowHome(
	gateway: Pick<DashboardGateway, "action">,
	request: { repo: string; workflowId: string; revision: number },
	dependencies: Parameters<typeof selectWorkflowHome>[1] = {},
) {
	const { session, hostId } = await selectWorkflowHome(
		request.repo,
		dependencies,
	);
	return gateway.action({
		...request,
		actionId: "clarification.attach",
		input: {
			hostId,
			conversationId: session.conversationId,
			homeRunId: session.runId,
		},
	});
}
