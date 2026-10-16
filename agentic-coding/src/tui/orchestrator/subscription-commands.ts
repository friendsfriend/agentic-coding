// The Orchestrator page's `/subscriptions` command surface
// (add-orchestrator-event-subscriptions, task 5.2). Pure: it builds the command
// list, the listing notice and the removal notice, so the listing form and the
// `remove <id>` form can be checked without a render harness. The view owns the
// I/O and the transcript.
import type { WorkflowEventSubscription } from "../../contracts/workflow-events.ts";
import {
	describeSubscription,
	removalCommand,
} from "../data/orchestrator-events.ts";

/** The listing command. One removal command is derived per stored record. */
export const SUBSCRIPTIONS_COMMAND = "/subscriptions";

/** The implicit default is not removable, so the derived command count is the
 * stored record count; the list is still bounded by the store's own cap. */
export interface SubscriptionCommand {
	readonly name: string;
	readonly description: string;
	readonly run: () => void;
}

/** What the developer reads in the transcript after `/subscriptions`. When the
 * master switch is not `wake`, the first line says so: a listed `wake` mode must
 * never imply delivery the switch forbids. */
export function subscriptionsNotice(
	subscriptions: readonly WorkflowEventSubscription[],
	masterSwitch?: "wake" | "notify" | "off",
): string {
	const header =
		masterSwitch === undefined || masterSwitch === "wake"
			? []
			: [
					masterSwitch === "off"
						? "[agents.orchestrator] monitor = off — nothing is observed and no subscription delivers; set it to `wake` for notes"
						: "[agents.orchestrator] monitor = notify — developer notifications only; no subscription will deliver a note",
				];
	if (subscriptions.length === 0)
		return [
			...header,
			"No event subscription is active; the workflow monitor delivers its default events only",
		].join("\n");
	const lines = subscriptions.map((subscription) => {
		const line = describeSubscription(subscription);
		const removal = removalCommand(subscription);
		return removal === undefined
			? line
			: `${line}\n    remove with: ${removal}`;
	});
	return [...header, ...lines].join("\n");
}

/** The notice a removal reports: whether a record was actually there. */
export function removalNotice(
	subscriptionId: string,
	removed: boolean,
): string {
	return removed
		? `Removed event subscription ${subscriptionId}`
		: `Event subscription ${subscriptionId} was already gone`;
}

/** The `/subscriptions` command plus one `remove <id>` command per stored
 * subscription (the implicit default carries none: it cannot be removed). The
 * listing prints each exact removal command, so it stays usable whatever the
 * palette shows. */
export function orchestratorSubscriptionCommands(input: {
	readonly subscriptions: readonly WorkflowEventSubscription[];
	readonly onList: () => void;
	readonly onRemove: (subscriptionId: string) => void;
}): SubscriptionCommand[] {
	return [
		{
			name: SUBSCRIPTIONS_COMMAND,
			description:
				"List this session's workflow event subscriptions in the transcript",
			run: input.onList,
		},
		...input.subscriptions
			.filter((subscription) => removalCommand(subscription) !== undefined)
			.map((subscription) => ({
				name: removalCommand(subscription) as string,
				description: `Remove the ${subscription.label} subscription`,
				run: () => input.onRemove(subscription.id),
			})),
	];
}
