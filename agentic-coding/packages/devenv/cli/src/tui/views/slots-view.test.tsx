/** @jsxImportSource @opentui/solid */
import { expect, test } from "bun:test";
import { testRender } from "@opentui/solid";
import { SlotsView } from "./slots-view.tsx";

// The Slots section (show-environment-instances, task 2.1): rendered with the
// OpenTUI test renderer, one row per agent-held/queued app.

test("renders holder, endpoints, idle/TTL and the waiting workflows", async () => {
	const t = await testRender(
		() => (
			<SlotsView
				rows={[
					{
						app: "customer-mw",
						holder: "workflow:a",
						status: "running",
						endpoints: { api: "http://127.0.0.1:8080" },
						holderSince: "2026-01-01T00:00:00.000Z",
						idleMs: 5_000,
						idleTtlMs: 65_000,
						waiting: [
							{
								owner: "workflow:b",
								since: "2026-01-01T00:03:20.000Z",
								position: 1,
							},
						],
					},
				]}
				selectedIndex={0}
				nowMs={Date.parse("2026-01-01T00:04:00.000Z")}
				height={10}
				loading={false}
				error={null}
			/>
		),
		{ width: 100, height: 12 },
	);
	await t.flush();
	const frame = t.captureCharFrame();
	expect(frame).toContain("customer-mw");
	expect(frame).toContain("api=http://127.0.0.1:8080");
	expect(frame).toContain("idle 5s");
	expect(frame).toContain("ttl 1m 0s");
	expect(frame).toContain("b (40s)");
	t.renderer.destroy();
});

test("renders the empty state when nothing is held or waiting", async () => {
	const t = await testRender(
		() => (
			<SlotsView
				rows={[]}
				selectedIndex={0}
				nowMs={0}
				height={10}
				loading={false}
				error={null}
			/>
		),
		{ width: 100, height: 12 },
	);
	await t.flush();
	expect(t.captureCharFrame()).toContain(
		"No app is agent-held and no workflow is waiting.",
	);
	t.renderer.destroy();
});
