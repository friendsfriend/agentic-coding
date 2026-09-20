/** @jsxImportSource @opentui/solid */
import { expect, test } from "bun:test";
import { testRender } from "@opentui/solid";
import {
	PhaseStatus,
	type PhaseStatusState,
	phaseStatus,
} from "../../src/tui/dash/App.tsx";

function state(overrides: Partial<PhaseStatusState> = {}): PhaseStatusState {
	return {
		phase: "core.implementation",
		stepId: "core.implementation",
		stepLabel: "Implementation",
		status: "active",
		runs: [],
		...overrides,
	};
}

test("blocked current phase keeps the phase label and renders a separate indicator", async () => {
	const t = await testRender(
		() => (
			<PhaseStatus
				state={state({
					status: "attention-required",
					runs: [{ stepId: "core.implementation", status: "blocked" }],
				})}
			/>
		),
		{ width: 80, height: 3 },
	);
	// A single renderOnce() can capture a frame before the renderer composites it
	// under the test pool (observed: 1 intermittent failure in 179 files), so wait
	// for the content the assertions below need — same contract, no weakened check.
	const frame = await t.waitForFrame((value) => value.includes("BLOCKED"));
	expect(frame).toContain("Implementation");
	expect(frame).toContain("BLOCKED");
	t.renderer.destroy();
});

test("only a blocked run for the current step marks the phase blocked", () => {
	expect(
		phaseStatus(
			state({
				status: "attention-required",
				runs: [
					{ stepId: "core.plan", status: "blocked" },
					{ stepId: "core.implementation", status: "working" },
				],
			}),
		),
	).toMatchObject({ text: "Implementation", working: true, blocked: false });
	expect(
		phaseStatus(
			state({
				status: "attention-required",
				runs: [{ stepId: "core.implementation", status: "blocked" }],
			}),
		),
	).toMatchObject({ blocked: true });
});

test("agent activity and unrelated attention do not alter phase status", () => {
	const working = phaseStatus(
		state({
			runs: [
				{ stepId: "core.implementation", status: "working" },
				{ stepId: "core.implementation", status: "working" },
			],
		}),
	);
	const attention = phaseStatus(state({ status: "attention-required" }));
	expect(working).toMatchObject({
		text: "Implementation",
		working: true,
		blocked: false,
	});
	expect(attention.blocked).toBe(false);
});

test("terminality controls phase animation independently of blocked state", () => {
	expect(
		phaseStatus(
			state({
				status: "completed",
				runs: [{ stepId: "core.implementation", status: "blocked" }],
			}),
		),
	).toMatchObject({ working: false, blocked: false });
});
