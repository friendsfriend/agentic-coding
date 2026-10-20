/** Characterization for the deterministic dashboard projection layer
 * (`src/tui/dash/projections.ts`): projections are pure data-in/display-out
 * helpers with explicit time inputs (design: dashboard-module-boundaries) —
 * no filesystem, Git, Herdr, database, network, timer, or ambient-clock
 * access, and no imports of the observation engine. */

import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import type {
	ClassifierDecisionRecord,
	GateDecisionRecord,
} from "../../src/contracts/workflow.ts";
import {
	approvalFor,
	classificationDetail,
	classificationEntries,
	classificationRows,
	classifierDecisionDetail,
	classifierDecisionRows,
	gateDecisionDetail,
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
			choice: "missing",
			confidence: 0.2,
			probabilities: { ghost: 0.9 },
		},
		result: {
			applied: false,
			profiles: ["smart"],
			attention:
				"classifier returned no usable choice; kept the pool default routing",
		},
	};
	expect(classifierDecisionRows([decision])).toEqual([
		"routing · core.implementation · kept smart",
	]);
	const detail = classifierDecisionDetail(decision);
	expect(detail.title).toContain("core.implementation");
	expect(detail.content).toContain("| quick | cheap |  | — |");
	expect(detail.content).toContain("**Applied:** no");
	expect(detail.content).toContain("no usable choice");
	expect(detail.content).toContain("input was truncated");
	expect(detail.content).toContain(decision.input);
});

/** One recorded classification of each kind, deliberately out of order, so the
 * merge has to sort rather than concatenate. */
function classificationFixture() {
	const routing: ClassifierDecisionRecord = {
		id: "b-routing",
		at: "2026-01-01T00:00:02Z",
		integration: "routing",
		questionId: "core.implementation",
		model: "opencode/jev-1.13-free",
		input: "state",
		inputTruncated: false,
		options: [{ label: "quick", profile: "base" }],
		answer: { type: "choice", choice: "quick" },
		result: { applied: true, profiles: ["base"] },
	};
	const triage: ClassifierDecisionRecord = {
		id: "c-triage",
		at: "2026-01-01T00:00:03Z",
		integration: "triage",
		questionId: "needs_security_verifier",
		model: "opencode/jev-1.13-free",
		input: "state",
		inputTruncated: false,
		options: [],
		answer: { type: "noul", noul: 0.81 },
		result: { applied: true, profiles: ["security-verifier"] },
	};
	const sweep: ClassifierDecisionRecord = {
		id: "d-sweep",
		at: "2026-01-01T00:00:04Z",
		integration: "file-judgment",
		questionId: "leak",
		model: "opencode/jev-1.13-free",
		input: "## File signals",
		inputTruncated: false,
		options: [{ label: "src/a.ts", profile: "flag", criteria: 0.91 }],
		answer: { type: "noul" },
		result: {
			applied: false,
			profiles: [],
			attention: "judged 3, cleared 2, flagged 1, unsure 0, not judged 0",
		},
	};
	const gate: GateDecisionRecord = {
		id: "a-gate",
		at: "2026-01-01T00:00:01Z",
		stepId: "core.wiki-gate",
		stage: "wiki",
		policy: "auto",
		decision: "skip",
		forced: false,
		noul: 0.12,
	};
	return { routing, triage, sweep, gate };
}

test("the classification history is every recorded classification, oldest first", () => {
	const { routing, triage, sweep, gate } = classificationFixture();
	const entries = classificationEntries({
		classifierDecisions: [routing, triage, sweep],
		gateDecisions: [gate],
	});
	expect(entries.map((entry) => entry.record.id)).toEqual([
		"a-gate",
		"b-routing",
		"c-triage",
		"d-sweep",
	]);
	// A workflow that classified nothing renders no panel, not an empty heading.
	expect(classificationEntries({})).toEqual([]);
	expect(
		classificationEntries({ classifierDecisions: [], gateDecisions: [] }),
	).toEqual([]);
});

test("each classification kind renders a row that names what it decided", () => {
	const { routing, triage, sweep, gate } = classificationFixture();
	expect(
		classificationRows(
			classificationEntries({
				classifierDecisions: [routing, triage, sweep],
				gateDecisions: [gate],
			}),
		),
	).toEqual([
		"stage gate · wiki · skipped · policy auto · necessity 0.12",
		"routing · core.implementation · applied base",
		"verifier roles · needs_security_verifier · selected security-verifier",
		"file sweep · leak · judged 3, cleared 2, flagged 1, unsure 0, not judged 0",
	]);
});

test("a necessity answer is shown as a value, never defaulted to zero", () => {
	const { triage } = classificationFixture();
	const detail = classifierDecisionDetail({
		...triage,
		answer: { type: "noul" },
		result: { applied: false, profiles: [] },
	});
	expect(detail.content).toContain("Necessity: not answered");
	expect(detail.content).not.toContain("Necessity: 0");
	// A role question resolves no pool, so it must not render an option table
	// claiming every role was an unchosen option.
	expect(detail.content).not.toContain("| Option | Profile |");
	expect(detail.content).toContain("asks one question");
});

test("the sweep detail bands paths instead of pretending to be a pool choice", () => {
	const { sweep } = classificationFixture();
	const detail = classificationDetail({ kind: "classifier", record: sweep });
	expect(detail.title).toContain("File sweep");
	expect(detail.content).toContain("judged 3, cleared 2, flagged 1");
	expect(detail.content).toContain("| src/a.ts | flag | 0.91 |");
	expect(detail.content).toContain("A verdict is not evidence");
});

test("a gate verdict reads as its stage, policy, and decision", () => {
	const { gate } = classificationFixture();
	const detail = classificationDetail({ kind: "gate", record: gate });
	expect(detail).toEqual(gateDecisionDetail(gate));
	expect(detail.title).toBe("Stage gate · wiki");
	expect(detail.content).toContain("- **Decision:** skipped");
	expect(detail.content).toContain("- **Necessity:** 0.12");
	expect(detail.content).toContain("- **Forced:** no");
	expect(detail.content).toContain("policy was always");
});

test("a forced gate with no answer says so instead of inventing a necessity", () => {
	const { gate } = classificationFixture();
	const detail = gateDecisionDetail({
		...gate,
		policy: "always",
		decision: "run",
		forced: true,
		noul: undefined,
	});
	expect(detail.content).toContain("- **Decision:** runs");
	expect(detail.content).toContain("- **Necessity:** not answered");
	expect(detail.content).toContain("- **Forced:** yes");
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
	// The shimmer is an aurora timeline, and a playing timeline keeps the
	// renderer live: a badge that animated while nothing ran held a dashboard at
	// ~28 fps (~4-5% CPU) indefinitely. Only an active workflow shimmers.
	expect(
		phaseStatus({
			phase: "core.archive",
			stepId: "core.archive",
			stepLabel: "OpenSpec archive",
			status: "attention-required",
			runs: [{ stepId: "core.archive", status: "blocked" }],
		}),
	).toEqual({ text: "OpenSpec archive", working: false, blocked: true });
	expect(phaseStatus({ phase: "verify", status: "paused", runs: [] })).toEqual({
		text: "verify",
		working: false,
		blocked: false,
	});
	expect(
		phaseStatus({ phase: "verify", status: "completed", runs: [] }),
	).toEqual({ text: "verify", working: false, blocked: false });
	expect(approvalFor("proposed")).toEqual({
		prompt: "Press Enter to approve plan",
		action: "approve-plan",
	});
	expect(approvalFor("fix")).toEqual({
		prompt: "Press Enter to retry verification",
		action: "verify",
	});
});
