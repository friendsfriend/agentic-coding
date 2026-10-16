// Event-subscription reads for the Orchestrator page
// (add-orchestrator-event-subscriptions, task 5.1). The view never performs the
// I/O itself: it reads through this module, which reads through the gateway port
// and the shared cache.
import type { WorkflowEventSubscription } from "../../contracts/workflow-events.ts";
import { cache, gateway } from "./index.ts";

/** One key holds the whole listing: it is small and always read together. */
export const EVENT_SUBSCRIPTIONS_KEY = "orchestrator:event-subscriptions";

/** The active subscriptions, the implicit default included. */
export async function loadEventSubscriptions(options?: {
	refresh?: boolean;
}): Promise<WorkflowEventSubscription[] | undefined> {
	return cache.load(
		EVENT_SUBSCRIPTIONS_KEY,
		() => gateway().eventSubscriptions(),
		options,
	);
}

/** Remove one subscription and drop the cached listing. */
export async function removeEventSubscription(id: string): Promise<boolean> {
	const removed = await gateway().removeEventSubscription(id);
	cache.invalidate(EVENT_SUBSCRIPTIONS_KEY);
	return removed;
}

/** The command the developer types to remove one stored subscription. The
 * implicit default carries none: it is the monitor's built-in behaviour and is
 * replaced by any explicit subscription, not removed. */
export function removalCommand(
	subscription: WorkflowEventSubscription,
): string | undefined {
	return subscription.implicit
		? undefined
		: `/subscriptions remove ${subscription.id}`;
}

/** One compact line per subscription, for the listing notice. The implicit
 * default is described as what it is (built-in, replaced by any subscription,
 * never expired) instead of as a removable, expiring record. */
export function describeSubscription(
	subscription: WorkflowEventSubscription,
): string {
	if (subscription.implicit)
		return `${subscription.label} (the monitor's built-in default: the events it always delivered, replaced by any subscription you create; not removable here)`;
	const filter = subscription.filter;
	const parts = [
		`scope=${filter.scope ?? "mine"}`,
		filter.workflowIds?.length
			? `workflows=${filter.workflowIds.join("|")}`
			: "",
		filter.repositories?.length ? `repos=${filter.repositories.join("|")}` : "",
		filter.eventIds?.length ? `events=${filter.eventIds.join("|")}` : "",
		filter.categories?.length
			? `categories=${filter.categories.join("|")}`
			: "",
		filter.reasons?.length ? `reasons=${filter.reasons.join("|")}` : "",
		filter.roles?.length ? `roles=${filter.roles.join("|")}` : "",
		filter.minSeverity ? `minSeverity=${filter.minSeverity}` : "",
	].filter(Boolean);
	const until = subscription.untilWorkflowClosed
		? ` until ${subscription.untilWorkflowClosed} closes`
		: "";
	const budget =
		subscription.remainingEvents !== undefined
			? ` · ${subscription.remainingEvents} events left`
			: "";
	const delivered = subscription.lastDeliveredAt
		? ` · last delivered ${subscription.lastDeliveredAt}`
		: "";
	return `${subscription.label} [${subscription.id}] ${subscription.mode} ${parts.join(" ")}${until} · expires ${subscription.expiresAt}${budget}${delivered}`;
}
