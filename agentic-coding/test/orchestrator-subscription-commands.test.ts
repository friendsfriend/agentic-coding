// `/subscriptions` on the Orchestrator page: the listing form, the per
// subscription removal form, and the notices each produces
// (add-orchestrator-event-subscriptions, task 5.2). Pure, so both forms are
// checked without a render harness.
import { describe, expect, test } from "bun:test";
import type { WorkflowEventSubscription } from "../src/contracts/workflow-events.ts";
import {
	orchestratorSubscriptionCommands,
	removalNotice,
	SUBSCRIPTIONS_COMMAND,
	subscriptionsNotice,
} from "../src/tui/orchestrator/subscription-commands.ts";

function subscription(
	label: string,
	overrides: Partial<WorkflowEventSubscription> = {},
): WorkflowEventSubscription {
	return {
		id: `sub-${label}`,
		label,
		reason: "watching",
		session: "orchestrator",
		createdAt: "2026-01-01T00:00:00.000Z",
		expiresAt: "2026-01-02T00:00:00.000Z",
		mode: "wake",
		filter: { scope: "mine", eventIds: ["attention.raised"] },
		...overrides,
	};
}

/** The one implicit record the server synthesises when nothing is stored. */
function implicitDefault(): WorkflowEventSubscription {
	return subscription("default", {
		id: "default",
		implicit: true,
		filter: { scope: "mine", eventIds: ["review.waiting"] },
	});
}

describe("orchestrator subscription commands", () => {
	test("the listing form lists each subscription with its exact removal command", () => {
		expect(subscriptionsNotice([])).toContain("No event subscription");
		const notice = subscriptionsNotice([
			subscription("attention", {
				lastDeliveredAt: "2026-01-01T01:00:00.000Z",
				untilWorkflowClosed: "wf-1",
			}),
			subscription("quiet", { mode: "silent" }),
		]);
		const lines = notice.split("\n");
		expect(lines).toHaveLength(4);
		expect(lines[0]).toContain("attention [sub-attention] wake");
		expect(lines[0]).toContain("scope=mine");
		expect(lines[0]).toContain("until wf-1 closes");
		expect(lines[0]).toContain("last delivered 2026-01-01T01:00:00.000Z");
		expect(lines[1]).toBe(
			"    remove with: /subscriptions remove sub-attention",
		);
		expect(lines[2]).toContain("quiet [sub-quiet] silent");
		expect(lines[2]).not.toContain("last delivered");
		expect(lines[3]).toBe("    remove with: /subscriptions remove sub-quiet");
	});

	test("the implicit default is described as built-in and carries no removal command", () => {
		const notice = subscriptionsNotice([implicitDefault()]);
		expect(notice).toContain("built-in default");
		expect(notice).toContain("not removable here");
		expect(notice).not.toContain("remove with:");
		expect(notice).not.toContain("expires");
	});

	test("the master switch is named when it forbids delivery", () => {
		expect(subscriptionsNotice([], "off")).toContain("monitor = off");
		expect(subscriptionsNotice([], "notify")).toContain("monitor = notify");
		expect(subscriptionsNotice([], "wake")).not.toContain("monitor =");
		expect(subscriptionsNotice([subscription("attention")], "off")).toContain(
			"monitor = off",
		);
	});

	test("the command list carries one remove form per stored subscription, each pruning its own id", () => {
		const removed: string[] = [];
		let listed = 0;
		const commands = orchestratorSubscriptionCommands({
			subscriptions: [
				implicitDefault(),
				subscription("attention"),
				subscription("quiet"),
			],
			onList: () => {
				listed += 1;
			},
			onRemove: (id) => removed.push(id),
		});
		expect(commands.map((command) => command.name)).toEqual([
			SUBSCRIPTIONS_COMMAND,
			`${SUBSCRIPTIONS_COMMAND} remove sub-attention`,
			`${SUBSCRIPTIONS_COMMAND} remove sub-quiet`,
		]);
		expect(commands[1]?.description).toContain("attention");
		commands[0]?.run();
		expect(listed).toBe(1);
		commands[2]?.run();
		expect(removed).toEqual(["sub-quiet"]);
	});

	test("the command list with no subscription is the listing form alone", () => {
		const commands = orchestratorSubscriptionCommands({
			subscriptions: [],
			onList: () => {},
			onRemove: () => {},
		});
		expect(commands).toHaveLength(1);
		expect(commands[0]?.name).toBe(SUBSCRIPTIONS_COMMAND);
	});

	test("the removal notice distinguishes a removal from an id already gone", () => {
		expect(removalNotice("sub-x", true)).toBe(
			"Removed event subscription sub-x",
		);
		expect(removalNotice("sub-x", false)).toBe(
			"Event subscription sub-x was already gone",
		);
	});
});
