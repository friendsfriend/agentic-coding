// Reconciles Herdr agent-tab labels with persisted run status.
//
// Run status lives in the workflow store; the tab label lives in Herdr. The
// engine cannot rename tabs itself (it owns no Herdr transport), and adding a
// tab-rename outbox effect would change every step's pinned effect contract.
// Instead the drain boundary — the one place that already owns both the
// engine and the Herdr port — calls this after every drain so each status
// transition is reflected on the tab.
import type { HerdrPort } from "./adapters.ts";
import type { WorkflowEngine } from "./runtime.ts";
import {
	agentTabBaseLabel,
	agentTabLabel,
	aggregateAgentTabStatus,
} from "./tab-status.ts";

interface TabListResult {
	tabs?: Array<{ tab_id?: string; label?: string }>;
}

async function call(
	herdr: HerdrPort,
	args: string[],
	signal?: AbortSignal,
): Promise<unknown> {
	if (signal?.aborted) throw new Error("effect ownership was lost");
	return herdr.callAsync ? herdr.callAsync(args, signal) : herdr.call(...args);
}

/**
 * Rename every agent tab for the workflow to `<glyph> <base>` based on the
 * statuses of the runs that share it. Idempotent: tabs already showing the
 * desired label are left untouched. Best-effort and non-throwing so a Herdr
 * hiccup never fails the drain that produced the status change.
 */
export async function syncAgentTabLabels(
	herdr: HerdrPort,
	workflowEngine: WorkflowEngine,
	repo: string,
	workflowId: string,
	signal?: AbortSignal,
): Promise<void> {
	try {
		const view = workflowEngine.status(repo, workflowId);
		if (!view.workspace) return;
		const statusesByTab = new Map<string, string[]>();
		for (const run of view.runs) {
			if (!run.tabId) continue;
			const statuses = statusesByTab.get(run.tabId) ?? [];
			statuses.push(run.status);
			statusesByTab.set(run.tabId, statuses);
		}
		if (!statusesByTab.size) return;
		const listed = (await call(
			herdr,
			["tab", "list", "--workspace", view.workspace],
			signal,
		)) as TabListResult;
		const labels = new Map<string, string>();
		for (const tab of listed.tabs ?? [])
			if (tab.tab_id) labels.set(tab.tab_id, tab.label ?? "");
		for (const [tabId, statuses] of statusesByTab) {
			const current = labels.get(tabId);
			// A closed tab is gone: nothing to rename.
			if (current === undefined) continue;
			const desired = agentTabLabel(
				agentTabBaseLabel(current),
				aggregateAgentTabStatus(statuses),
			);
			if (desired === current) continue;
			await call(herdr, ["tab", "rename", tabId, desired], signal);
		}
	} catch {
		/* tab labels are presentation-only; never fail the drain for them */
	}
}
