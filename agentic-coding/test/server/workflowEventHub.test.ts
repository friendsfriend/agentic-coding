/**
 * Workflow refresh hub. The server turns multiplexer events into
 * `workflow.updated` envelopes that every dashboard refreshes on, so the one
 * thing it must never republish is pane output: a live session streams
 * `terminal.output_ready` at ~50 events/s, nothing renders it, and a consumer
 * reads each republished envelope as "the workflow changed".
 */
import { expect, test } from "bun:test";
import { EventBroker, type PublishInput } from "../../src/server/events.ts";
import {
	isRefreshWorthyEvent,
	startWorkflowEventHub,
} from "../../src/server/subscriptions.ts";

test("pane output is not a refresh trigger", () => {
	expect(isRefreshWorthyEvent("terminal.output_ready")).toBe(false);
	// Runtimes speak their own vocabulary (Luvus: tab.*, terminal.closed; Herdr:
	// the dashboard contract names) and none of those may be filtered out.
	for (const name of [
		"pane.created",
		"pane.closed",
		"pane.exited",
		"pane.updated",
		"pane.agent_detected",
		"workspace.closed",
		"layout.updated",
		"tab.created",
		"tab.closed",
		"terminal.closed",
	])
		expect(isRefreshWorthyEvent(name)).toBe(true);
});

test("the hub republishes lifecycle events and drops pane output", () => {
	const broker = new EventBroker("test-instance");
	const published: Array<{ kind: string; payload?: unknown }> = [];
	let handler:
		| ((event: { event: string; data: Record<string, unknown> }) => void)
		| undefined;
	const hub = startWorkflowEventHub(
		{
			publish: (input: PublishInput) => {
				published.push({ kind: input.kind, payload: input.payload });
				return broker.publish(input);
			},
		} as unknown as EventBroker,
		(_port, onEvent) => {
			handler = onEvent;
			return () => {};
		},
	);
	expect(handler).toBeDefined();

	// 50/s pane output: none of it may reach a dashboard.
	for (let i = 0; i < 50; i += 1)
		handler?.({ event: "terminal.output_ready", data: { pane_id: "7" } });
	expect(published).toEqual([]);

	// A structural event still reaches the dashboard whatever its vocabulary.
	handler?.({ event: "tab.created", data: { tab_id: "9" } });
	handler?.({ event: "pane.agent_detected", data: { pane_id: "7" } });
	expect(published).toEqual([
		{ kind: "workflow.updated", payload: { tab_id: "9" } },
		{ kind: "workflow.updated", payload: { pane_id: "7" } },
	]);
	hub.stop();
});
