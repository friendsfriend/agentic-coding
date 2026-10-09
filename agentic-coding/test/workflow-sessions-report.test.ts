// Unit coverage for the deterministic session-efficiency analyzer
// (self-improvement loop, stage 1). Pure in/out: synthetic telemetry events →
// report, asserting windowing, abandoned-run exclusion, the batching/fail/turn
// findings, and the prompt-vs-config attribution rule.
import { describe, expect, test } from "bun:test";
import {
	buildSessionsReport,
	parseSinceToMs,
	type SessionFileInput,
} from "../src/workflow/sessions-report.ts";

const NOW = Date.parse("2026-10-09T12:00:00.000Z");
const DAY = 86_400_000;

function iso(offsetMs: number): string {
	return new Date(NOW + offsetMs).toISOString();
}

interface RunSpec {
	runId: string;
	role: string;
	profile: string;
	startOffsetMs?: number;
	/** tool calls per turn, one entry per turn. */
	turns: number[];
	failures?: number;
	handoff?: string;
	repeatedInput?: string; // same tool_input across its calls → repeats
	cost?: number;
}

function fileFor(
	workflowId: string,
	family: string,
	runs: RunSpec[],
): SessionFileInput {
	const events: Array<Record<string, unknown>> = [
		{
			event: "workflow.started",
			at: iso(runs[0]?.startOffsetMs ?? 0),
			"herdr.definition.id": family,
			workflowId,
		},
	];
	for (const run of runs) {
		const base = {
			runId: run.runId,
			role: run.role,
			profile: run.profile,
		};
		const start = run.startOffsetMs ?? 0;
		events.push({
			...base,
			event: "agent.launch",
			at: iso(start),
			"herdr.run.attempt": 1,
		});
		let t = start + 1000;
		for (const toolCount of run.turns) {
			events.push({ ...base, event: "runtime.turn_started", at: iso(t) });
			for (let i = 0; i < toolCount; i++) {
				t += 100;
				events.push({
					...base,
					event: "runtime.tool_start",
					at: iso(t),
					"pi.tool.name": "bash",
					...(run.repeatedInput
						? { "herdr.content.tool_input": run.repeatedInput }
						: {}),
				});
				events.push({
					...base,
					event: "runtime.tool",
					at: iso(t + 10),
					"pi.tool.name": "bash",
					"pi.tool.outcome": "ok",
				});
			}
			events.push({
				...base,
				event: "runtime.usage",
				at: iso(t + 20),
				cost: (run.cost ?? 0) / Math.max(1, run.turns.length),
			});
		}
		for (let f = 0; f < (run.failures ?? 0); f++) {
			t += 100;
			events.push({
				...base,
				event: "runtime.tool",
				at: iso(t),
				"pi.tool.name": "bash",
				"pi.tool.outcome": "error",
			});
		}
		if (run.handoff)
			events.push({
				...base,
				event: "agent.handoff",
				at: iso(t + 50),
				"herdr.handoff.outcome": run.handoff,
			});
	}
	return { target: "/repo", workflowId, events };
}

const opts = { nowMs: NOW, windowMs: DAY, sinceLabel: "1d" };

describe("sessions-report analyzer", () => {
	test("aggregates a run and flags one-tool-per-turn", () => {
		const file = fileFor("wf1", "openspec-apply", [
			{
				runId: "r1",
				role: "openspec-verifier",
				profile: "deepseek-flash",
				startOffsetMs: -3600_000,
				turns: Array(40).fill(1), // 40 single-tool turns
				handoff: "complete",
			},
		]);
		const report = buildSessionsReport([file], opts);
		expect(report.roles).toHaveLength(1);
		const stat = report.roles[0];
		expect(stat.role).toBe("openspec-verifier");
		expect(stat.runs).toBe(1);
		expect(stat.turns).toBe(40);
		expect(stat.tools).toBe(40);
		expect(stat.toolsPerTurn).toBe(1);
		expect(stat.singleToolTurns).toBe(40);
		const batching = report.findings.find((f) => f.metric === "toolsPerTurn");
		expect(batching).toBeDefined();
		expect(batching?.severity).toBe("high");
	});

	test("windowing excludes runs that started before the window", () => {
		const file = fileFor("wf-old", "solo", [
			{
				runId: "old",
				role: "worker",
				profile: "deepseek-flash",
				startOffsetMs: -2 * DAY, // outside a 1-day window
				turns: Array(30).fill(1),
				handoff: "complete",
			},
		]);
		const report = buildSessionsReport([file], opts);
		expect(report.roles).toHaveLength(0);
		expect(report.totals.runs).toBe(0);
	});

	test("abandoned runs are counted but excluded from averages", () => {
		const file = fileFor("wf2", "openspec-apply", [
			{
				runId: "ghost",
				role: "worker",
				profile: "deepseek-flash",
				startOffsetMs: -600_000,
				turns: [], // launched, never produced a turn
			},
			{
				runId: "real",
				role: "worker",
				profile: "deepseek-flash",
				startOffsetMs: -500_000,
				turns: [2, 3, 2], // healthy batching
				handoff: "complete",
			},
		]);
		const report = buildSessionsReport([file], opts);
		const stat = report.roles.find((r) => r.role === "worker");
		expect(stat?.runs).toBe(1); // ghost excluded
		expect(stat?.abandonedRuns).toBe(1);
		expect(report.totals.abandonedRuns).toBe(1);
		expect(
			report.findings.some((f) => f.metric === "abandonedRuns"),
		).toBeTrue();
	});

	test("attribution: prompt when poor across two profiles, config when one", () => {
		// quality-verifier poor on BOTH profiles → prompt.
		// performance-verifier poor on ONE profile only → config.
		const poor = (role: string, profile: string, wf: string) =>
			fileFor(wf, "openspec-apply", [
				{
					runId: `${role}-${profile}`,
					role,
					profile,
					startOffsetMs: -300_000,
					turns: Array(30).fill(1),
					handoff: "complete",
				},
			]);
		const report = buildSessionsReport(
			[
				poor("quality-verifier", "deepseek-flash", "a"),
				poor("quality-verifier", "gpt-strong", "b"),
				poor("performance-verifier", "deepseek-flash", "c"),
			],
			opts,
		);
		const quality = report.findings.find(
			(f) => f.scope.role === "quality-verifier" && f.metric === "toolsPerTurn",
		);
		const perf = report.findings.find(
			(f) =>
				f.scope.role === "performance-verifier" && f.metric === "toolsPerTurn",
		);
		expect(quality?.recommendationKind).toBe("prompt");
		expect(perf?.recommendationKind).toBe("config");
	});

	test("high tool-failure rate is flagged as prompt", () => {
		const file = fileFor("wf3", "no-openspec", [
			{
				runId: "wiki1",
				role: "wiki",
				profile: "deepseek-flash",
				startOffsetMs: -200_000,
				turns: Array(30).fill(2), // good batching, so only the fail finding
				failures: 20,
				handoff: "complete",
			},
		]);
		const report = buildSessionsReport([file], opts);
		const fail = report.findings.find((f) => f.metric === "toolFailureRate");
		expect(fail).toBeDefined();
		expect(fail?.recommendationKind).toBe("prompt");
	});

	test("blocked handoff and repeated calls surface", () => {
		const file = fileFor("wf4", "openspec-apply", [
			{
				runId: "arch",
				role: "archive",
				profile: "deepseek-flash",
				startOffsetMs: -100_000,
				turns: Array(10).fill(1),
				repeatedInput: '{"command":"openspec archive"}',
				handoff: "blocked",
			},
		]);
		const report = buildSessionsReport([file], opts);
		expect(
			report.findings.some((f) => f.metric === "blockedHandoffs"),
		).toBeTrue();
		const stat = report.roles.find((r) => r.role === "archive");
		// 10 identical calls in a row → 9 repeats.
		expect(stat?.repeatedCalls).toBe(9);
		expect(
			report.findings.some((f) => f.metric === "repeatedCalls"),
		).toBeTrue();
	});

	test("parseSinceToMs handles units and defaults to a week", () => {
		expect(parseSinceToMs("7d")).toBe(7 * DAY);
		expect(parseSinceToMs("6h")).toBe(6 * 3_600_000);
		expect(parseSinceToMs("30m")).toBe(30 * 60_000);
		expect(parseSinceToMs("90s")).toBe(90_000);
		expect(parseSinceToMs(undefined)).toBe(7 * DAY);
		expect(parseSinceToMs("garbage")).toBe(7 * DAY);
	});
});
