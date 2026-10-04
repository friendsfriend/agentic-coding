/**
 * Workflow refresh hub. The server turns execution-coordinator progress into
 * `workflow.updated` envelopes that every dashboard refreshes on, per watched
 * repository, and stops publishing after `stop()`.
 */
import { expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { EventBroker, type PublishInput } from "../../src/server/events.ts";
import { startWorkflowEventHub } from "../../src/server/subscriptions.ts";
import {
	disposeExecutionCoordinator,
	requestWorkflowExecution,
} from "../../src/workflow/execution-coordinator.ts";

test("a watched repository publishes workflow.updated and stop() releases it", async () => {
	const repo = fs.mkdtempSync(path.join(os.tmpdir(), "workflow-event-hub-"));
	const broker = new EventBroker("test-instance");
	const published: Array<{ kind: string; resource?: string }> = [];
	const hub = startWorkflowEventHub({
		publish: (input: PublishInput) => {
			published.push({ kind: input.kind, resource: input.resource });
			return broker.publish(input);
		},
	} as unknown as EventBroker);
	try {
		hub.watchRepo(repo);
		// A drain with no pending effects still settles, and the hub publishes the
		// settle as one refresh envelope for the watched repository.
		requestWorkflowExecution(repo);
		for (let i = 0; i < 100 && published.length === 0; i += 1)
			await new Promise((resolve) => setTimeout(resolve, 20));
		expect(published[0]).toEqual({
			kind: "workflow.updated",
			resource: repo,
		});
		hub.stop();
		published.length = 0;
		// A late registration after stop() must not re-arm process-global listeners.
		hub.watchRepo(repo);
		requestWorkflowExecution(repo);
		await new Promise((resolve) => setTimeout(resolve, 50));
		expect(published).toEqual([]);
	} finally {
		hub.stop();
		disposeExecutionCoordinator(repo);
		fs.rmSync(repo, { recursive: true, force: true });
	}
});
