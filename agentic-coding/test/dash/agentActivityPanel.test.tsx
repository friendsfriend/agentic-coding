/** @jsxImportSource @opentui/solid */
// The Agents panel badge tracks a durable run's live activity (the running
// tool, the generation in flight, queued input) while the workflow store only
// knows the coarse status, and falls back to that status when nothing is in
// flight.
import { expect, test } from "bun:test";
import { testRender } from "@opentui/solid";
import { createSignal } from "solid-js";
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
	// The badge swaps immediately, so the first settled frame already carries the
	// blocked activity.
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
	// An inactive snapshot must not relabel the badge; the status word stands.
	await t.waitForFrame((frame) => frame.includes("working"));
	const frame = t.captureCharFrame();
	expect(frame).not.toContain("idle");
	expect(frame).toContain("working");
	t.renderer.destroy();
});

test("a provisional status gathers instead of naming the seed's guess", async () => {
	const data = {
		...testDashboard(),
		agents: [{ role: "worker", status: "pending" as const }],
		verifierTimeline: [],
	};
	const t = await testRender(
		() => (
			<AgentsPanel
				data={data}
				active
				selectedIndex={0}
				narrow={false}
				statusPending={() => true}
			/>
		),
		{ width: 120, height: 40 },
	);
	await t.waitForFrame((frame) => frame.includes("loading"));
	const frame = t.captureCharFrame();
	expect(frame).toContain("loading");
	expect(frame).not.toContain("pending");
	t.renderer.destroy();
});

test("the gathering badge swaps to the status when the observation lands", async () => {
	const [loaded, setLoaded] = createSignal(false);
	const data = {
		...testDashboard(),
		agents: [{ role: "worker", status: "working" as const }],
		verifierTimeline: [],
	};
	const t = await testRender(
		() => (
			<AgentsPanel
				data={data}
				active
				selectedIndex={0}
				narrow={false}
				statusPending={() => !loaded()}
			/>
		),
		{ width: 120, height: 40 },
	);
	await t.waitForFrame((frame) => frame.includes("loading"));
	setLoaded(true);
	await t.renderOnce();
	const frame = t.captureCharFrame();
	expect(frame).toContain("working");
	expect(frame).not.toContain("loading");
	t.renderer.destroy();
});

test("a live step outranks the gathering badge", async () => {
	const data = {
		...testDashboard(),
		agents: [{ role: "worker", status: "working" as const }],
		verifierTimeline: [],
	};
	const t = await testRender(
		() => (
			<AgentsPanel
				data={data}
				active
				selectedIndex={0}
				narrow={false}
				statusPending={() => true}
				activity={() => ({ label: "bash", active: true, tone: "working" })}
			/>
		),
		{ width: 120, height: 40 },
	);
	await t.waitForFrame((frame) => frame.includes("bash"));
	const frame = t.captureCharFrame();
	expect(frame).toContain("bash");
	expect(frame).not.toContain("loading");
	t.renderer.destroy();
});

test("the verifier verdict waits for the full observation", async () => {
	const data = testDashboard("verify");
	const pending = await testRender(
		() => (
			<AgentsPanel
				data={data}
				active
				selectedIndex={0}
				narrow={false}
				detailsPending
			/>
		),
		{ width: 120, height: 40 },
	);
	await pending.renderOnce();
	// The seed derives PASS from run completion; until findings are committed
	// that verdict must not be shown as if it were final.
	expect(pending.captureCharFrame()).not.toContain("PASS");
	pending.renderer.destroy();

	const loaded = await testRender(
		() => <AgentsPanel data={data} active selectedIndex={0} narrow={false} />,
		{ width: 120, height: 40 },
	);
	await loaded.waitForFrame((frame) => frame.includes("PASS"));
	expect(loaded.captureCharFrame()).toContain("PASS");
	loaded.renderer.destroy();
});

test("a live activity change swaps in the same frame, without a wipe", async () => {
	const [activity, setActivity] = createSignal<AgentActivity>({
		label: "bash",
		active: true,
		tone: "working",
	});
	const t = await testRender(
		() => (
			<AgentsPanel
				data={testDashboard()}
				active
				selectedIndex={0}
				narrow={false}
				activity={() => activity()}
			/>
		),
		{ width: 120, height: 40 },
	);
	await t.waitForFrame((frame) => frame.includes("bash"));
	setActivity({ label: "read", active: true, tone: "working" });
	// One paint: the new word is already the badge, with no transition frame
	// showing the previous activity.
	await t.renderOnce();
	const frame = t.captureCharFrame();
	expect(frame).toContain("read");
	expect(frame).not.toContain("bash");
	t.renderer.destroy();
});
