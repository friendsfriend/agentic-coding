/** @jsxImportSource @opentui/solid */
/** A skipped stage must never be silent in the dashboard: the Change panel
 * renders the latest gate decision per stage next to the phase status. */
import { expect, test } from "bun:test";
import { testRender } from "@opentui/solid";
import type { GateDecisionRecord } from "../../src/contracts/workflow.ts";
import { ChangePanel } from "../../src/tui/dash/panels/ChangePanel.tsx";
import { skippedGateStages } from "../../src/tui/dash/panels/gates.ts";

const decision = (
	stage: string,
	overrides: Partial<GateDecisionRecord> = {},
): GateDecisionRecord => ({
	id: `${stage}-${overrides.decision ?? "run"}`,
	at: "2026-01-01T00:00:00Z",
	stepId: `core.${stage}-gate`,
	stage,
	policy: "auto",
	decision: "run",
	forced: false,
	...overrides,
});

test("the latest decision per stage decides whether it is reported as skipped", () => {
	expect(skippedGateStages([])).toEqual([]);
	expect(skippedGateStages([decision("wiki", { decision: "run" })])).toEqual(
		[],
	);
	// An earlier skip that a later run superseded is not a skipped stage.
	expect(
		skippedGateStages([
			decision("wiki", { decision: "skip", noul: 0.1 }),
			decision("wiki", { decision: "run", noul: 0.9 }),
		]),
	).toEqual([]);
	expect(
		skippedGateStages([
			decision("wiki", { decision: "skip", noul: 0.1 }),
			decision("developerReview", { decision: "skip" }),
		]),
	).toEqual([
		{ stage: "wiki", policy: "auto", noul: 0.1 },
		{ stage: "developerReview", policy: "auto" },
	]);
});

const data = (gateDecisions: readonly GateDecisionRecord[]) =>
	({
		age: "1s",
		request: "do the thing",
		gitStatus: { available: false },
		state: {
			phase: "core.implementation",
			stepId: "core.implementation",
			stepLabel: "Implementation",
			status: "active",
			runs: [],
			gateDecisions,
			health: { valid: true, attention: [] },
		},
	}) as never;

test("a skipped stage renders its stage, policy, and answer value", async () => {
	const t = await testRender(
		() => (
			<ChangePanel
				data={data([
					decision("developerReview", { decision: "skip", noul: 0.12 }),
				])}
				active={false}
			/>
		),
		{ width: 80, height: 24 },
	);
	const frame = await t.waitForFrame((value) => value.includes("GATES"));
	expect(frame).toContain("developerReview");
	expect(frame).toContain("skipped (policy auto, necessity 0.12)");
	t.renderer.destroy();
});

test("a workflow with no skipped stage renders nothing extra", async () => {
	const t = await testRender(
		() => (
			<ChangePanel
				data={data([
					decision("wiki", { decision: "run", forced: true, policy: "always" }),
				])}
				active={false}
			/>
		),
		{ width: 80, height: 24 },
	);
	const frame = await t.waitForFrame((value) => value.includes("STATUS"));
	expect(frame).not.toContain("GATES");
	expect(frame).not.toContain("skipped by the classifier");
	t.renderer.destroy();
});
