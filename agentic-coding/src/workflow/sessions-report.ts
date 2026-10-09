// Deterministic session-efficiency analyzer (self-improvement loop, stage 1).
//
// Pure projection over workflow telemetry envelopes — no I/O, no LLM, no clock
// of its own (the caller passes `nowMs`). It groups each telemetry file into
// agent runs, windows them, aggregates per (role × profile × family), and
// derives a ranked, content-free finding list. The I/O that enumerates targets
// and reads the files lives in the application layer (`operations.ts`); this
// module is the trusted, testable core both front doors share.
//
// Attribution rule (the point of the per-profile key): a batching/turn signal
// is `prompt` only when it reproduces across ≥2 model profiles for the role —
// otherwise the model cannot be told apart from the brief, so it is `config`.

import type {
	SessionsFinding,
	SessionsFindingKind,
	SessionsReport,
	SessionsRoleStat,
} from "../contracts/sessions-report.ts";

/** One telemetry file's parsed envelopes, as read from
 * `<target>/.herdr-workflow/<id>/telemetry.jsonl`. */
export interface SessionFileInput {
	readonly target: string;
	readonly workflowId: string;
	readonly events: ReadonlyArray<Record<string, unknown>>;
}

export interface SessionsReportOptions {
	readonly nowMs: number;
	readonly windowMs: number;
	readonly sinceLabel: string;
	/** Cap on the findings list. Defaults to 25. */
	readonly maxFindings?: number;
}

// --- Thresholds (the regression lines). Named so a reader can see the rule. ---
/** Only judge batching for a role that did real work in the window. */
const MIN_TOOLS_FOR_BATCHING = 20;
/** `tools / turns` at or below this is one-tool-per-turn territory. */
const POOR_BATCHING_RATIO = 1.3;
/** Average turns per run above this is a turn sink worth flagging. */
const HIGH_TURNS_PER_RUN = 50;
/** Tool-failure fraction above this is a broken-command signal. */
const HIGH_FAIL_RATE = 0.05;
/** Repeated identical calls above this is wasted work (needs capture on). */
const REPEATED_CALLS_FLOOR = 3;
const DEFAULT_MAX_FINDINGS = 25;

const OK_TOOL_OUTCOMES = new Set(["ok", "success"]);

function str(value: unknown): string | undefined {
	return typeof value === "string" && value !== "" ? value : undefined;
}

function num(value: unknown): number {
	return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

interface RunAccumulator {
	role: string;
	profile: string;
	firstAt?: number;
	lastAt?: number;
	turns: number;
	tools: number;
	zeroToolTurns: number;
	singleToolTurns: number;
	multiToolTurns: number;
	toolFailures: number;
	repeatedCalls: number;
	handoff?: string;
	cost: number;
	// in-pass turn/tool tracking
	curTurnTools: number;
	inTurn: boolean;
	lastCallKey?: string;
}

function newRun(): RunAccumulator {
	return {
		role: "",
		profile: "",
		turns: 0,
		tools: 0,
		zeroToolTurns: 0,
		singleToolTurns: 0,
		multiToolTurns: 0,
		toolFailures: 0,
		repeatedCalls: 0,
		cost: 0,
		curTurnTools: 0,
		inTurn: false,
	};
}

function flushTurn(run: RunAccumulator): void {
	if (!run.inTurn) return;
	if (run.curTurnTools === 0) run.zeroToolTurns += 1;
	else if (run.curTurnTools === 1) run.singleToolTurns += 1;
	else run.multiToolTurns += 1;
	run.curTurnTools = 0;
}

/** The workflow family for a file: the definition id, carried on engine events
 * (`workflow.started`). Falls back to `unknown` when no engine event is
 * present (a truncated file). */
function familyOf(events: ReadonlyArray<Record<string, unknown>>): string {
	for (const event of events) {
		const id = str(event["herdr.definition.id"]);
		if (id) return id;
	}
	return "unknown";
}

function groupRuns(file: SessionFileInput): Map<string, RunAccumulator> {
	const runs = new Map<string, RunAccumulator>();
	for (const event of file.events) {
		const runId = str(event.runId);
		if (!runId) continue;
		let run = runs.get(runId);
		if (!run) {
			run = newRun();
			runs.set(runId, run);
		}
		const role = str(event.role);
		if (role) run.role = role;
		const profile = str(event.profile) ?? str(event.model);
		if (profile) run.profile = profile;
		const at = Date.parse(String(event.at ?? ""));
		if (Number.isFinite(at)) {
			run.firstAt = run.firstAt === undefined ? at : Math.min(run.firstAt, at);
			run.lastAt = run.lastAt === undefined ? at : Math.max(run.lastAt, at);
		}
		switch (str(event.event)) {
			case "runtime.turn_started":
				flushTurn(run);
				run.turns += 1;
				run.inTurn = true;
				// `lastCallKey` is intentionally not reset here: an agent that repeats
				// the same call one-per-turn is the waste this counts, so detection
				// spans turn boundaries.
				break;
			case "runtime.tool_start": {
				run.tools += 1;
				run.curTurnTools += 1;
				// Repeated-call detection: same tool + same arguments back to back.
				// The argument text is hashed to a bounded key and never retained,
				// so no captured content leaves this function.
				const name = str(event["pi.tool.name"]) ?? "?";
				const input = str(event["herdr.content.tool_input"]);
				const key = input ? `${name}:${input}` : undefined;
				if (key && run.lastCallKey === key) run.repeatedCalls += 1;
				run.lastCallKey = key;
				break;
			}
			case "runtime.tool": {
				const outcome = str(event["pi.tool.outcome"]);
				if (outcome && !OK_TOOL_OUTCOMES.has(outcome)) run.toolFailures += 1;
				break;
			}
			case "runtime.usage":
				run.cost += num(event.cost);
				break;
			case "agent.handoff": {
				const outcome = str(event["herdr.handoff.outcome"]);
				if (outcome) run.handoff = outcome;
				break;
			}
		}
	}
	for (const run of runs.values()) flushTurn(run);
	return runs;
}

interface StatAccumulator {
	role: string;
	profile: string;
	family: string;
	runs: number;
	turns: number;
	tools: number;
	zeroToolTurns: number;
	singleToolTurns: number;
	multiToolTurns: number;
	toolFailures: number;
	repeatedCalls: number;
	blockedHandoffs: number;
	abandonedRuns: number;
	cost: number;
}

function statKey(role: string, profile: string, family: string): string {
	return `${role}\u0000${profile}\u0000${family}`;
}

function round(value: number, places = 2): number {
	const factor = 10 ** places;
	return Math.round(value * factor) / factor;
}

export function buildSessionsReport(
	files: ReadonlyArray<SessionFileInput>,
	options: SessionsReportOptions,
): SessionsReport {
	const toMs = options.nowMs;
	const fromMs = options.nowMs - options.windowMs;
	const stats = new Map<string, StatAccumulator>();
	let workflows = 0;
	let totalAbandoned = 0;

	for (const file of files) {
		const family = familyOf(file.events);
		const runs = groupRuns(file);
		let fileHadInWindowRun = false;
		for (const run of runs.values()) {
			if (run.firstAt === undefined) continue;
			if (run.firstAt < fromMs || run.firstAt > toMs) continue;
			fileHadInWindowRun = true;
			const role = run.role || "unknown";
			const profile = run.profile || "unknown";
			const key = statKey(role, profile, family);
			let stat = stats.get(key);
			if (!stat) {
				stat = {
					role,
					profile,
					family,
					runs: 0,
					turns: 0,
					tools: 0,
					zeroToolTurns: 0,
					singleToolTurns: 0,
					multiToolTurns: 0,
					toolFailures: 0,
					repeatedCalls: 0,
					blockedHandoffs: 0,
					abandonedRuns: 0,
					cost: 0,
				};
				stats.set(key, stat);
			}
			// A launched-but-turnless run is a ghost from a restart/repair. Count
			// it, but keep it out of every average so it cannot poison the ratios.
			const abandoned = run.turns === 0 && run.handoff !== "complete";
			if (abandoned) {
				stat.abandonedRuns += 1;
				totalAbandoned += 1;
				continue;
			}
			stat.runs += 1;
			stat.turns += run.turns;
			stat.tools += run.tools;
			stat.zeroToolTurns += run.zeroToolTurns;
			stat.singleToolTurns += run.singleToolTurns;
			stat.multiToolTurns += run.multiToolTurns;
			stat.toolFailures += run.toolFailures;
			stat.repeatedCalls += run.repeatedCalls;
			stat.cost += run.cost;
			if (run.handoff === "blocked") stat.blockedHandoffs += 1;
		}
		if (fileHadInWindowRun) workflows += 1;
	}

	const roles: SessionsRoleStat[] = [...stats.values()]
		.map((stat) => ({
			role: stat.role,
			profile: stat.profile,
			family: stat.family,
			runs: stat.runs,
			turns: stat.turns,
			tools: stat.tools,
			toolsPerTurn: stat.turns > 0 ? round(stat.tools / stat.turns) : 0,
			turnsPerRun: stat.runs > 0 ? round(stat.turns / stat.runs, 1) : 0,
			zeroToolTurns: stat.zeroToolTurns,
			singleToolTurns: stat.singleToolTurns,
			multiToolTurns: stat.multiToolTurns,
			toolFailures: stat.toolFailures,
			repeatedCalls: stat.repeatedCalls,
			blockedHandoffs: stat.blockedHandoffs,
			abandonedRuns: stat.abandonedRuns,
			cost: round(stat.cost, 4),
		}))
		.sort((a, b) => b.turns - a.turns);

	const findings = deriveFindings(roles, totalAbandoned).slice(
		0,
		options.maxFindings ?? DEFAULT_MAX_FINDINGS,
	);

	const totals = roles.reduce(
		(acc, r) => {
			acc.runs += r.runs;
			acc.turns += r.turns;
			acc.tools += r.tools;
			acc.toolFailures += r.toolFailures;
			acc.cost += r.cost;
			return acc;
		},
		{
			workflows,
			runs: 0,
			turns: 0,
			tools: 0,
			toolFailures: 0,
			abandonedRuns: totalAbandoned,
			cost: 0,
		},
	);
	totals.cost = round(totals.cost, 4);

	return {
		window: {
			since: options.sinceLabel,
			fromIso: new Date(fromMs).toISOString(),
			toIso: new Date(toMs).toISOString(),
		},
		totals,
		skippedTargets: [],
		roles,
		findings,
	};
}

/** Severity order for ranking. */
const SEVERITY_RANK: Record<SessionsFinding["severity"], number> = {
	high: 0,
	medium: 1,
	low: 2,
};

function deriveFindings(
	roles: ReadonlyArray<SessionsRoleStat>,
	totalAbandoned: number,
): SessionsFinding[] {
	const findings: SessionsFinding[] = [];

	// Attribution: for each role, the set of profiles seen and the subset with
	// poor batching. `prompt` only when every profile the role ran on
	// underperforms (≥2 profiles); otherwise `config` (model not ruled out).
	const profilesByRole = new Map<string, Set<string>>();
	const poorProfilesByRole = new Map<string, Set<string>>();
	for (const r of roles) {
		(profilesByRole.get(r.role) ?? setInto(profilesByRole, r.role)).add(
			r.profile,
		);
		if (
			r.tools >= MIN_TOOLS_FOR_BATCHING &&
			r.toolsPerTurn <= POOR_BATCHING_RATIO
		)
			(
				poorProfilesByRole.get(r.role) ?? setInto(poorProfilesByRole, r.role)
			).add(r.profile);
	}
	const kindFor = (role: string): SessionsFindingKind => {
		const all = profilesByRole.get(role);
		const poor = poorProfilesByRole.get(role);
		if (all && poor && all.size >= 2 && poor.size === all.size) return "prompt";
		return "config";
	};

	for (const r of roles) {
		const scope = { role: r.role, profile: r.profile, family: r.family };
		if (
			r.tools >= MIN_TOOLS_FOR_BATCHING &&
			r.toolsPerTurn <= POOR_BATCHING_RATIO
		) {
			findings.push({
				title: `${r.role} works one tool per turn`,
				severity: r.toolsPerTurn <= 1.1 ? "high" : "medium",
				scope,
				metric: "toolsPerTurn",
				value: r.toolsPerTurn,
				threshold: POOR_BATCHING_RATIO,
				evidence: {
					runs: r.runs,
					detail: `${r.tools} tools across ${r.turns} turns (${r.singleToolTurns} single-tool, ${r.multiToolTurns} multi-tool)`,
				},
				recommendationKind: kindFor(r.role),
			});
		}
		if (r.runs > 0 && r.turnsPerRun >= HIGH_TURNS_PER_RUN) {
			findings.push({
				title: `${r.role} averages ${r.turnsPerRun} turns per run`,
				severity: r.turnsPerRun >= 2 * HIGH_TURNS_PER_RUN ? "high" : "medium",
				scope,
				metric: "turnsPerRun",
				value: r.turnsPerRun,
				threshold: HIGH_TURNS_PER_RUN,
				evidence: {
					runs: r.runs,
					detail: `${r.turns} turns across ${r.runs} runs`,
				},
				recommendationKind: kindFor(r.role),
			});
		}
		const failRate = r.tools > 0 ? r.toolFailures / r.tools : 0;
		if (r.toolFailures > 0 && failRate >= HIGH_FAIL_RATE) {
			findings.push({
				title: `${r.role} tool calls fail often`,
				severity: failRate >= 2 * HIGH_FAIL_RATE ? "high" : "medium",
				scope,
				metric: "toolFailureRate",
				value: round(failRate, 3),
				threshold: HIGH_FAIL_RATE,
				evidence: {
					runs: r.runs,
					detail: `${r.toolFailures} of ${r.tools} tool calls failed`,
				},
				recommendationKind: "prompt",
			});
		}
		if (r.repeatedCalls > REPEATED_CALLS_FLOOR) {
			findings.push({
				title: `${r.role} repeats identical calls`,
				severity: "low",
				scope,
				metric: "repeatedCalls",
				value: r.repeatedCalls,
				threshold: REPEATED_CALLS_FLOOR,
				evidence: {
					runs: r.runs,
					detail: `${r.repeatedCalls} consecutive identical tool calls`,
				},
				recommendationKind: kindFor(r.role),
			});
		}
		if (r.blockedHandoffs > 0) {
			findings.push({
				title: `${r.role} handed off blocked`,
				severity: "medium",
				scope,
				metric: "blockedHandoffs",
				value: r.blockedHandoffs,
				threshold: 0,
				evidence: {
					runs: r.runs,
					detail: `${r.blockedHandoffs} run(s) ended blocked`,
				},
				recommendationKind: "engine",
			});
		}
	}

	if (totalAbandoned > 0) {
		findings.push({
			title: "abandoned runs from restart/repair",
			severity: totalAbandoned >= 5 ? "high" : "medium",
			scope: {},
			metric: "abandonedRuns",
			value: totalAbandoned,
			threshold: 0,
			evidence: {
				runs: totalAbandoned,
				detail: `${totalAbandoned} launched run(s) produced no turn and were discarded`,
			},
			recommendationKind: "engine",
		});
	}

	return findings.sort((a, b) => {
		const bySeverity = SEVERITY_RANK[a.severity] - SEVERITY_RANK[b.severity];
		if (bySeverity !== 0) return bySeverity;
		return b.evidence.runs - a.evidence.runs;
	});
}

function setInto(map: Map<string, Set<string>>, key: string): Set<string> {
	const created = new Set<string>();
	map.set(key, created);
	return created;
}

/** Parse a `since` label (`7d`, `12h`, `30m`, `90s`) to milliseconds. Defaults
 * to 7 days for an empty or unparseable value, so a caller never has to. */
export function parseSinceToMs(since: string | undefined): number {
	const WEEK = 7 * 24 * 60 * 60 * 1000;
	if (!since) return WEEK;
	const match = /^(\d+)\s*([smhd])$/.exec(since.trim());
	if (!match) return WEEK;
	const value = Number(match[1]);
	if (!Number.isFinite(value) || value <= 0) return WEEK;
	const unit = match[2];
	const scale =
		unit === "s"
			? 1000
			: unit === "m"
				? 60_000
				: unit === "h"
					? 3_600_000
					: 86_400_000;
	return value * scale;
}
