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
	/** `phase` tells the dashboard whether this is a live effect commit (apply a
	 * view update) or a drain boundary (read the full observation). Other
	 * consumers only read the domain/kind. */
	const publish = (
		repo: string,
		workflowId: string | undefined,
		phase: "progress" | "settled" | "error",
	): void => {
		events.publish({
			domain: "workflow",
			kind: "workflow.updated",
			resource: repo,
			...(workflowId ? { runId: workflowId } : {}),
			payload: { phase },
		});
	};
	return {
		watchRepo(repo) {
			// A late registration after stop() must not re-arm process-global
			// coordinator listeners that nothing will dispose.
			if (stopped || watched.has(repo)) return;
			watched.add(repo);
			disposers.push(
				onWorkflowExecutionProgress(repo, (workflowId) =>
					publish(repo, workflowId, "progress"),
				),
				onWorkflowExecutionSettled(repo, (workflowId) =>
					publish(repo, workflowId, "settled"),
				),
				onWorkflowExecutionError(repo, (workflowId) =>
					publish(repo, workflowId, "error"),
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
