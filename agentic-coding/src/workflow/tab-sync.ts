// Reconciles agent-tab labels with persisted run status.
//
// Run status lives in the workflow store; the tab label lives in the selected
// multiplexer. The engine cannot rename tabs itself (it owns no transport),
// and adding a tab-rename outbox effect would change every step's pinned
// effect contract. Instead the drain boundary — the one place that already
// owns both the engine and the multiplexer port — calls this after every drain
// so each status transition is reflected on the tab.
import { Effect } from "effect";
import { runMultiplexer } from "../multiplexer/boundary.ts";
import type { MultiplexerPort } from "../multiplexer/port.ts";
import type { WorkflowEngine } from "./runtime.ts";
import {
	agentTabBaseLabel,
	agentTabLabel,
	aggregateAgentTabStatus,
	latestStatusesByTab,
} from "./tab-status.ts";

/**
 * Rename every agent tab for the workflow to `<glyph> <base>` based on the
 * statuses of the runs that share it. Idempotent: tabs already showing the
 * desired label are left untouched. Best-effort and non-throwing so a runtime
 * hiccup never fails the drain that produced the status change.
 */
export async function syncAgentTabLabels(
	port: MultiplexerPort,
	workflowEngine: WorkflowEngine,
	repo: string,
	workflowId: string,
	signal?: AbortSignal,
): Promise<void> {
	try {
		const view = workflowEngine.status(repo, workflowId);
		if (!view.workspace) return;
		// Latest run per role per tab, so a superseded attempt/generation/round
		// cannot outlive the role's current run and pin the glyph.
		const statusesByTab = latestStatusesByTab(view.runs);
		if (!statusesByTab.size) return;
		const listed = await runMultiplexer(
			port
				.tabList(view.workspace)
				.pipe(Effect.catchAll(() => Effect.succeed([]))),
		);
		const labels = new Map<string, string>();
		for (const tab of listed) labels.set(tab.tabId, tab.label ?? "");
		for (const [tabId, statuses] of statusesByTab) {
			const current = labels.get(tabId);
			// A closed tab is gone: nothing to rename.
			if (current === undefined) continue;
			const desired = agentTabLabel(
				agentTabBaseLabel(current),
				aggregateAgentTabStatus(statuses),
			);
			if (desired === current) continue;
			signal?.throwIfAborted();
			await runMultiplexer(
				port.tabRename(tabId, desired).pipe(
					// Labels are presentation-only: a failed rename never fails the drain.
					Effect.catchAll(() => Effect.void),
				),
			);
		}
	} catch {
		/* tab labels are presentation-only; never fail the drain for them */
	}
}
