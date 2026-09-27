/** Characterization for the deterministic dashboard projection layer
 * (`src/tui/dash/projections.ts`): projections are pure data-in/display-out
 * helpers with explicit time inputs (design: dashboard-module-boundaries) —
 * no filesystem, Git, Herdr, database, network, timer, or ambient-clock
 * access, and no imports of the observation engine. */

import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import type { ClassifierDecisionRecord } from "../../src/contracts/workflow.ts";
import {
	approvalFor,
	classifierDecisionDetail,
	classifierDecisionRows,
	phaseAgeHours,
	phaseStatus,
} from "../../src/tui/dash/projections.ts";

test("projections module performs no external I/O", () => {
	const source = readFileSync(
		new URL("../../src/tui/dash/projections.ts", import.meta.url),
		"utf8",
	);
	const banned = [
		"node:fs",
		"herdr-client",
		"Bun.spawn",
		"Bun.which",
		"Date.now",
		"new Date(",
		"AbortController",
		"setTimeout",
		"setInterval",
		"process.",
		"import.meta",
	];
	// Ambient-clock and environment reads are not allowed in projections.
	for (const token of banned) expect(source).not.toContain(token);
	// Projections must not reach into the observation or engine modules.
	expect(source).not.toMatch(/from "\.\/(observations|engine|demo)"/);
});

test("classifier decision projections show rows, options, result, and verbatim input", () => {
	const decision: ClassifierDecisionRecord = {
		id: "decision-1",
		at: "2026-01-01T00:00:00Z",
		integration: "routing",
		phase: "apply",
		questionId: "core.implementation",
		model: "opencode/jev-1.13-free",
		input: "task input\n```embedded fence```",
		inputTruncated: true,
		options: [
			{ label: "quick", profile: "cheap", criteria: { size: "small" } },
			{ label: "deep", profile: "smart" },
		],
		answer: {
			type: "choice",
			choice: "quick",
			confidence: 0.2,
			probabilities: { quick: 0.6, deep: 0.4 },
		},
		result: {
			applied: false,
			profiles: ["smart"],
			attention: "confidence below floor",
		},
	};
	expect(classifierDecisionRows([decision])).toEqual([
		"routing · core.implementation · kept smart",
	]);
	const detail = classifierDecisionDetail(decision);
	expect(detail.title).toContain("core.implementation");
	expect(detail.content).toContain("| quick | cheap | yes | 0.6 |");
	expect(detail.content).toContain("**Applied:** no");
	expect(detail.content).toContain("confidence below floor");
	expect(detail.content).toContain("input was truncated");
	expect(detail.content).toContain(decision.input);
});

test("projections compute from their explicit inputs", () => {
	// The explicit `now` input replaces the ambient clock the source-token guard
	// above forbids.
	const now = Date.parse("2026-01-01T12:00:00Z");
	expect(
		phaseAgeHours(
			{ phase: "verify", phaseStartedAt: "2026-01-01T08:00:00Z" },
			now,
		),
	).toBe(4);
});

test("phase status and approval prompts are pure display projections", () => {
	expect(
		phaseStatus({
			phase: "core.implementation",
			stepId: "core.implementation",
			stepLabel: "Implementation",
			status: "active",
			runs: [],
		}),
	).toEqual({ text: "Implementation", working: true, blocked: false });
	expect(phaseStatus({ phase: "verify", status: "active", runs: [] })).toEqual({
		text: "verify",
		working: true,
		blocked: false,
	});
	expect(approvalFor("proposed")).toEqual({
		prompt: "Press Enter to approve plan",
		action: "approve-plan",
	});
	expect(approvalFor("fix")).toEqual({
		prompt: "Press Enter to retry verification",
		action: "verify",
	});
});
