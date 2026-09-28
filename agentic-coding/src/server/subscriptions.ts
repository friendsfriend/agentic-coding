// Server-owned workflow refresh subscriptions (expose-unified-bun-backend,
// task 3.3). The server subscribes once to Herdr lifecycle events and to each
// repository's execution coordinator, and publishes `workflow.updated` on the
// event stream. Dashboards refresh from that stream instead of opening a local
// Herdr socket or watching store files.

import { multiplexerPort } from "../multiplexer/factory.ts";
import {
	onWorkflowExecutionError,
	onWorkflowExecutionProgress,
	onWorkflowExecutionSettled,
} from "../workflow/execution-coordinator.ts";
import type { EventBroker } from "./events.ts";
import { subscribeMultiplexerEvents } from "./herdr-events";

/** Pane output is a firehose, not a state change: a live Luvus session emitted
 * `terminal.output_ready` at ~50 events/s in a 10 s window and nothing else, no
 * surface reads it, and each one was republished as `workflow.updated` — which a
 * consumer reads as "the workflow changed", clearing the dashboard cache and
 * waking a full re-read (measured: back-to-back dashboard reads while an agent
 * streamed). Structural events keep publishing for whatever vocabulary the
 * selected runtime speaks, so no lifecycle change is lost. */
const OUTPUT_FIREHOSE_EVENTS = new Set(["terminal.output_ready"]);

export function isRefreshWorthyEvent(name: string): boolean {
	return !OUTPUT_FIREHOSE_EVENTS.has(name);
}

export interface WorkflowEventHub {
	/** Register the execution-coordinator listeners for one repository. */
	watchRepo(repo: string): void;
	stop(): void;
}

export function startWorkflowEventHub(
	events: EventBroker,
	// Seam for tests: the real subscription opens a socket to the selected runtime.
	subscribe: typeof subscribeMultiplexerEvents = subscribeMultiplexerEvents,
): WorkflowEventHub {
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
	disposers.push(
		subscribe(multiplexerPort(), (event) => {
			if (!isRefreshWorthyEvent(event.event)) return;
			events.publish({
				domain: "workflow",
				kind: "workflow.updated",
				payload: event.data,
			});
		}),
	);
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
