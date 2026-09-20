// Post-acceptance Herdr handoff reporting
// (launch-workflows-from-project-and-wiki-pages, task 3.3).
//
// A workflow that was durably accepted and then failed its workspace handoff
// must be reported once, by identity, through the existing execution-error
// surface — never by starting a second workflow. The coordinator is mocked so
// the listener contract itself is asserted; `launch` is imported dynamically
// because `mock.module` must be installed before the module graph loads.
import { expect, mock, test } from "bun:test";
import * as realCoordinator from "../../src/workflow/execution-coordinator.ts";

test("the in-process watch reports only the accepted workflow, once", async () => {
	let listener: ((workflowId: string) => void) | undefined;
	let disposed = false;
	mock.module("../../src/workflow/execution-coordinator", () => ({
		...realCoordinator,
		onWorkflowExecutionError: (
			_repo: string,
			next: (workflowId: string) => void,
		) => {
			listener = next;
			return () => {
				disposed = true;
				listener = undefined;
			};
		},
		workflowExecutionError: () => "handoff refused",
	}));
	const { watchAcceptedHandoff } = await import("../../src/tui/dash/launch");
	const failures: string[] = [];
	const dispose = watchAcceptedHandoff("/repo", "wf-1", (message) =>
		failures.push(message),
	);

	// Another workflow's failure is not this launch's report.
	listener?.("other-workflow");
	expect(failures).toEqual([]);

	listener?.("wf-1");
	expect(failures).toEqual(["handoff refused"]);

	dispose();
	expect(disposed).toBe(true);
	expect(listener).toBeUndefined();
});
