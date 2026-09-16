/** Characterization for the deterministic dashboard projection layer
 * (`src/tui/dash/projections.ts`): projections are pure data-in/display-out
 * helpers with explicit time inputs (design: dashboard-module-boundaries) —
 * no filesystem, Git, Herdr, database, network, timer, or ambient-clock
 * access, and no imports of the observation engine. */

import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import {
	approvalFor,
	phaseAgeHours,
	phaseStatus,
} from "../../src/tui/dash/projections";

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
