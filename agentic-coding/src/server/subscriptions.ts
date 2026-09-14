// Server-owned workflow refresh subscriptions (expose-unified-bun-backend,
// task 3.3). The server subscribes once to Herdr lifecycle events and to each
// repository's execution coordinator, and publishes `workflow.updated` on the
// event stream. Dashboards refresh from that stream instead of opening a local
// Herdr socket or watching store files.
import { subscribeHerdrEvents } from "../tui/dash/herdr-events.ts";
import {
	onWorkflowExecutionError,
	onWorkflowExecutionSettled,
} from "../workflow/execution-coordinator.ts";
import type { EventBroker } from "./events.ts";

export interface WorkflowEventHub {
	/** Register the execution-coordinator listeners for one repository. */
	watchRepo(repo: string): void;
	stop(): void;
}

export function startWorkflowEventHub(events: EventBroker): WorkflowEventHub {
	const watched = new Set<string>();
	const disposers: Array<() => void> = [];
	const publish = (repo: string, workflowId?: string): void => {
		events.publish({
			domain: "workflow",
			kind: "workflow.updated",
			resource: repo,
			...(workflowId ? { runId: workflowId } : {}),
		});
	};
	disposers.push(
		subscribeHerdrEvents((event) => {
			events.publish({
				domain: "workflow",
				kind: "workflow.updated",
				payload: event.data,
			});
		}),
	);
	return {
		watchRepo(repo) {
			if (watched.has(repo)) return;
			watched.add(repo);
			disposers.push(
				onWorkflowExecutionSettled(repo, (workflowId) =>
					publish(repo, workflowId),
				),
				onWorkflowExecutionError(repo, (workflowId) =>
					publish(repo, workflowId),
				),
			);
		},
		stop() {
			for (const dispose of disposers) dispose();
			disposers.length = 0;
			watched.clear();
		},
	};
}
