/** @jsxImportSource @opentui/solid */
/** The classification panel shows EVERY classification the engine recorded —
 * model-pool routing, verifier-role triage, stage gates, and the per-file
 * judgment sweep — from the two histories the workflow keeps. A gate decision
 * that no routing record exists for must still be visible here, which is what
 * makes the panel the one place a reader looks. */
import { expect, test } from "bun:test";
import { testRender } from "@opentui/solid";
import type {
	ClassifierDecisionRecord,
	GateDecisionRecord,
} from "../../src/contracts/workflow.ts";
import { ClassifierPanel } from "../../src/tui/dash/panels/ClassifierPanel.tsx";
import { classificationEntries } from "../../src/tui/dash/projections.ts";

const routing: ClassifierDecisionRecord = {
	id: "routing-1",
	at: "2026-01-01T00:00:01Z",
	integration: "routing",
	phase: "plan",
	questionId: "core.plan",
	model: "opencode/jev-1.13-free",
	input: "state",
	inputTruncated: false,
	options: [{ label: "quick", profile: "base" }],
	answer: { type: "choice", choice: "quick" },
	result: { applied: true, profiles: ["base"] },
};

const triage: ClassifierDecisionRecord = {
	id: "triage-1",
	at: "2026-01-01T00:00:02Z",
	integration: "triage",
	questionId: "needs_security_verifier",
	model: "opencode/jev-1.13-free",
	input: "state",
	inputTruncated: false,
	options: [],
	answer: { type: "noul", noul: 0.81 },
	result: { applied: true, profiles: ["security-verifier"] },
};

const gate: GateDecisionRecord = {
	id: "gate-1",
	at: "2026-01-01T00:00:03Z",
	stepId: "core.wiki-gate",
	stage: "wiki",
	policy: "auto",
	decision: "skip",
	forced: false,
	noul: 0.12,
};

test("the panel lists routing, triage, and gate decisions together", async () => {
	const entries = classificationEntries({
		classifierDecisions: [routing, triage],
		gateDecisions: [gate],
	});
	const t = await testRender(
		() => (
			<ClassifierPanel entries={entries} active={false} selectedIndex={0} />
		),
		{ width: 90, height: 20 },
	);
	const frame = await t.waitForFrame((value) =>
		value.includes("verifier roles"),
	);
	expect(frame).toContain("Classifications");
	expect(frame).toContain("routing · core.plan · applied base");
	expect(frame).toContain(
		"verifier roles · needs_security_verifier · selected security-verifier",
	);
	// The gate verdict has no routing record of its own, so it is the row that
	// proves the two histories really are merged.
	expect(frame).toContain("stage gate · wiki · skipped");
	t.renderer.destroy();
});

test("a workflow with no classification renders the panel with an empty state", async () => {
	// A newly started workflow has no decisions yet; the panel must still exist
	// and say so, not disappear from the grid.
	const t = await testRender(
		() => <ClassifierPanel entries={[]} active={false} selectedIndex={0} />,
		{ width: 90, height: 20 },
	);
	const frame = await t.waitForFrame((value) =>
		value.includes("No classifications recorded yet"),
	);
	expect(frame).toContain("Classifications");
	expect(frame).not.toContain("stage gate");
	t.renderer.destroy();
});
