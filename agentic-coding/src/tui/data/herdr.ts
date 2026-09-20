// Herdr observation selectors (establish-opencode-boundaries, task 4.3).
//
// Pane and agent observations for the dashboard's focus/status surfaces. In
// attached mode the server owns the Herdr socket and publishes
// `workflow.updated`; only a transport-less run observes the socket here. The
// selectors expose data and callbacks — never a workflow transition.
import { cache } from "./index.ts";

export interface HerdrReadOptions {
	readonly signal?: AbortSignal;
	readonly refresh?: boolean;
}

export function panesKey(workflowId: string): string {
	return `herdr:panes:${workflowId}`;
}

/** Cache the pane map for a workflow. Callers supply the read (the shell owns
 * the socket subscription), the data layer owns freshness. */
export function setPanes(
	workflowId: string,
	panes: Record<string, string>,
): void {
	cache.load(panesKey(workflowId), async () => panes).catch(() => undefined);
}

/** The cached pane map, if one was published for this workflow. */
export function panes(workflowId: string): Record<string, string> | undefined {
	return cache.read<Record<string, string>>(panesKey(workflowId))?.value;
}

/** A pane/tab event for a workspace invalidates that workspace's observations
 * without touching workflow state. */
export function invalidateWorkspace(workspace: string): void {
	cache.invalidate(`herdr:${workspace}`);
}

/** A run's pane identity changed: the workflow's reads are stale. */
export function invalidateWorkflowPanes(workflowId: string): void {
	cache.invalidate(panesKey(workflowId));
}
