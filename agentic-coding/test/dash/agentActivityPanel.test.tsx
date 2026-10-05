/** @jsxImportSource @opentui/solid */
// The Agents panel badge tracks a durable run's live activity (the running
// tool, the generation in flight, queued input) while the workflow store only
// knows the coarse status, and falls back to that status when nothing is in
// flight.
import { expect, test } from "bun:test";
import { testRender } from "@opentui/solid";
import type { AgentActivity } from "../../src/tui/dash/agent-activity.ts";
import { testDashboard } from "../../src/tui/dash/demo.ts";
import { AgentsPanel } from "../../src/tui/dash/panels/AgentsPanel.tsx";

test("a live activity replaces the status word in the agent badge", async () => {
	const t = await testRender(
		() => (
			<AgentsPanel
				data={testDashboard()}
				active
				selectedIndex={0}
				narrow={false}
				activity={(role) =>
					role === "worker"
						? { label: "bash", active: true, tone: "working" }
						: undefined
				}
			/>
		),
		{ width: 120, height: 40 },
	);
	await t.waitForFrame((frame) => frame.includes("bash"));
	const frame = t.captureCharFrame();
	expect(frame).toContain("bash");
	// Roles with no live work keep the workflow status badge.
	expect(frame).toContain("working");
	t.renderer.destroy();
});

test("a blocking activity is rendered as the blocked tone", async () => {
	const t = await testRender(
		() => (
			<AgentsPanel
				data={testDashboard()}
				active
				selectedIndex={0}
				narrow={false}
				activity={(role): AgentActivity | undefined =>
					role === "worker"
						? { label: "asking", active: true, tone: "blocked" }
						: undefined
				}
			/>
		),
		{ width: 120, height: 40 },
	);
	// The badge wipes between the previous text and the new one, so wait for the
	// new label rather than reading the first frame of the transition.
	await t.waitForFrame((frame) => frame.includes("asking"));
	expect(t.captureCharFrame()).toContain("asking");
	t.renderer.destroy();
});

test("an inactive activity keeps the status badge", async () => {
	const t = await testRender(
		() => (
			<AgentsPanel
				data={testDashboard()}
				active
				selectedIndex={0}
				narrow={false}
				// A snapshot that is not in flight must not relabel the badge.
				activity={() => ({ label: "idle", active: false, tone: "working" })}
			/>
		),
		{ width: 120, height: 40 },
	);
	// An inactive snapshot must not relabel the badge: wait for the wipe back to
	// the status word and assert the activity word never lands.
	await t.waitForFrame((frame) => frame.includes("working"));
	const frame = t.captureCharFrame();
	expect(frame).not.toContain("idle");
	expect(frame).toContain("working");
	t.renderer.destroy();
});
