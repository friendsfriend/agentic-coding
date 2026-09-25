// Herdr notification/focus boundary tests
// (workflow-developer-notifications, tasks 2.1-2.3): exact argv, bounded
// transport errors, dashboard-tab resolution, and delivery outcomes treated as
// raised rather than retried.
import { describe, expect, test } from "bun:test";
import type { HerdrPort } from "../src/workflow/adapters.ts";
import {
	focusWorkflowDashboard,
	notificationDelivery,
	raiseDeveloperNotification,
	showDeveloperNotification,
} from "../src/workflow/notification-sync.ts";

function fakeHerdr(
	handlers: Record<string, (args: string[]) => unknown> = {},
	options: { fail?: string } = {},
): { herdr: HerdrPort; calls: string[][] } {
	const calls: string[][] = [];
	const herdr: HerdrPort = {
		call(...args: string[]) {
			calls.push(args);
			if (options.fail && args.join(" ").includes(options.fail))
				throw new Error("herdr unavailable");
			for (const [prefix, handler] of Object.entries(handlers))
				if (args.slice(0, prefix.split(" ").length).join(" ") === prefix)
					return handler(args);
			return {};
		},
	};
	return { herdr, calls };
}

const notification = { title: "agentic-coding · wf", body: "Implementation" };

describe("notification delivery boundary (task 2.1)", () => {
	test("issues the documented notification argv", async () => {
		const { herdr, calls } = fakeHerdr();
		await expect(showDeveloperNotification(herdr, notification)).resolves.toBe(
			"shown",
		);
		expect(calls).toEqual([
			[
				"notification",
				"show",
				"agentic-coding · wf",
				"--body",
				"Implementation",
				"--sound",
				"request",
			],
		]);
	});

	test("narrows every bounded delivery outcome", async () => {
		for (const outcome of [
			"shown",
			"disabled",
			"rate_limited",
			"busy",
			"no_foreground_client",
			"unknown",
		] as const) {
			const { herdr } = fakeHerdr({
				notification: () => ({ delivery: outcome }),
			});
			expect(await showDeveloperNotification(herdr, notification)).toBe(
				outcome,
			);
		}
		expect(notificationDelivery({ status: "busy" })).toBe("busy");
		expect(notificationDelivery({ outcome: "no_foreground_client" })).toBe(
			"no_foreground_client",
		);
		expect(notificationDelivery({ shown: true })).toBe("shown");
		expect(notificationDelivery({ delivery: "totally_new" })).toBe("unknown");
		expect(notificationDelivery(undefined)).toBe("shown");
	});

	test("a rejected port call throws without a partial side effect", async () => {
		const { herdr, calls } = fakeHerdr({}, { fail: "notification" });
		await expect(
			showDeveloperNotification(herdr, notification),
		).rejects.toThrow("herdr unavailable");
		expect(calls).toHaveLength(1);
	});
});

describe("dashboard focus boundary (task 2.2)", () => {
	test("focuses the workspace and the glyph-prefixed dashboard tab", async () => {
		const { herdr, calls } = fakeHerdr({
			"tab list": () => ({
				tabs: [
					{ tab_id: "w1:t0", label: "worker" },
					{ tab_id: "w1:t1", label: "✓ dashboard" },
				],
			}),
		});
		await expect(focusWorkflowDashboard(herdr, "w1")).resolves.toBe(true);
		expect(calls).toEqual([
			["tab", "list", "--workspace", "w1"],
			["workspace", "focus", "w1"],
			["tab", "focus", "w1:t1"],
		]);
	});

	test("a missing dashboard tab is a skipped focus", async () => {
		const { herdr, calls } = fakeHerdr({
			"tab list": () => ({ tabs: [{ tab_id: "w1:t0", label: "worker" }] }),
		});
		await expect(focusWorkflowDashboard(herdr, "w1")).resolves.toBe(false);
		expect(
			calls.map((args) => args[0] === "tab" && args[1] === "list"),
		).toEqual([true]);
		expect(calls.some((args) => args[1] === "focus")).toBe(false);
	});

	test("a missing tab id is a skipped focus", async () => {
		const { herdr } = fakeHerdr({
			"tab list": () => ({ tabs: [{ label: "dashboard" }] }),
		});
		await expect(focusWorkflowDashboard(herdr, "w1")).resolves.toBe(false);
	});

	test("a missing workspace never throws out of the notifier", async () => {
		const { herdr } = fakeHerdr({}, { fail: "tab list" });
		await expect(focusWorkflowDashboard(herdr, "gone")).resolves.toBe(false);
	});

	test("an empty, control-bearing, or over-long workspace is a skipped focus", async () => {
		const { herdr, calls } = fakeHerdr({
			"tab list": () => ({ tabs: [{ tab_id: "w1:t1", label: "dashboard" }] }),
		});
		await expect(focusWorkflowDashboard(herdr, "")).resolves.toBe(false);
		await expect(focusWorkflowDashboard(herdr, "bad\u001b[2J")).resolves.toBe(
			false,
		);
		await expect(focusWorkflowDashboard(herdr, "x".repeat(257))).resolves.toBe(
			false,
		);
		expect(calls).toHaveLength(0);
	});
});

describe("notification raise sequence (task 2.3)", () => {
	test("the focus calls are issued before the notification", async () => {
		const { herdr, calls } = fakeHerdr({
			"tab list": () => ({ tabs: [{ tab_id: "w1:t1", label: "dashboard" }] }),
		});
		const result = await raiseDeveloperNotification(herdr, notification, "w1");
		expect(result).toEqual({ delivery: "shown", focused: true });
		expect(calls).toEqual([
			["tab", "list", "--workspace", "w1"],
			["workspace", "focus", "w1"],
			["tab", "focus", "w1:t1"],
			[
				"notification",
				"show",
				"agentic-coding · wf",
				"--body",
				"Implementation",
				"--sound",
				"request",
			],
		]);
	});

	test("a focus failure still reports the notification as raised", async () => {
		const { herdr } = fakeHerdr({
			"tab list": () => ({ tabs: [{ tab_id: "w1:t0", label: "worker" }] }),
		});
		const result = await raiseDeveloperNotification(herdr, notification, "w1");
		expect(result.delivery).toBe("shown");
		expect(result.focused).toBe(false);
	});

	test("a missing workspace skips focus without failing the delivery", async () => {
		const { herdr, calls } = fakeHerdr();
		const result = await raiseDeveloperNotification(
			herdr,
			notification,
			undefined,
		);
		expect(result).toEqual({ delivery: "shown", focused: false });
		expect(calls).toHaveLength(1);
	});

	test("an invalid workspace skips focus but still raises the notification", async () => {
		const { herdr, calls } = fakeHerdr({
			"tab list": () => ({ tabs: [{ tab_id: "w1:t1", label: "dashboard" }] }),
		});
		const result = await raiseDeveloperNotification(
			herdr,
			notification,
			"bad\u001b[2J",
		);
		expect(result).toEqual({ delivery: "shown", focused: false });
		expect(calls).toEqual([
			[
				"notification",
				"show",
				"agentic-coding · wf",
				"--body",
				"Implementation",
				"--sound",
				"request",
			],
		]);
	});

	test("refused delivery outcomes count as raised and are never retried", async () => {
		for (const outcome of [
			"disabled",
			"rate_limited",
			"busy",
			"no_foreground_client",
		] as const) {
			const { herdr, calls } = fakeHerdr({
				notification: () => ({ delivery: outcome }),
				"tab list": () => ({
					tabs: [{ tab_id: "w1:t1", label: "dashboard" }],
				}),
			});
			const result = await raiseDeveloperNotification(
				herdr,
				notification,
				"w1",
			);
			expect(result.delivery).toBe(outcome);
			expect(result.focused).toBe(true);
			expect(
				calls.filter(
					(args) => args[0] === "notification" && args[1] === "show",
				),
			).toHaveLength(1);
		}
	});
});
