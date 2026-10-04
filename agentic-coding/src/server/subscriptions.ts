// Server-owned workflow refresh subscriptions (expose-unified-bun-backend,
// task 3.3). The server registers each repository's execution-coordinator
// listeners and publishes `workflow.updated` on the event stream, so
// dashboards refresh from that stream instead of watching store files. The
// former multiplexer lifecycle subscription is gone with the multiplexer: the
// engine owns run state, and the coordinator is its only publisher.

import {
	onWorkflowExecutionError,
	onWorkflowExecutionProgress,
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
	let stopped = false;
	const publish = (repo: string, workflowId?: string): void => {
		events.publish({
			domain: "workflow",
			kind: "workflow.updated",
			resource: repo,
			...(workflowId ? { runId: workflowId } : {}),
		});
	};
	return {
		watchRepo(repo) {
			// A late registration after stop() must not re-arm process-global
			// coordinator listeners that nothing will dispose.
			if (stopped || watched.has(repo)) return;
			watched.add(repo);
			disposers.push(
				onWorkflowExecutionProgress(repo, () => publish(repo)),
				onWorkflowExecutionSettled(repo, (workflowId) =>
					publish(repo, workflowId),
				),
				onWorkflowExecutionError(repo, (workflowId) =>
					publish(repo, workflowId),
				),
			);
		},
		stop() {
			stopped = true;
			for (const dispose of disposers) dispose();
			disposers.length = 0;
			watched.clear();
		},
	};
}
