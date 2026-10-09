// Wire contract for the session-efficiency report (self-improvement loop,
// stage 1: report-only). A deterministic projection over workflow telemetry,
// read by the orchestrator (`sessions_report` tool → `sessions-report`
// observation) and by `workflow sessions-report`. Content-free by contract:
// every value here is a count, a ratio, or a bounded label — no captured
// session content (`herdr.content.*`), task text, prompt, or command text ever
// appears, so a reader can ingest it without crossing the capture wall.
//
// Pure structural types only. See docs/workflow-architecture.md once the
// feature is documented.

/** The resolved time window the report covers. */
export interface SessionsReportWindow {
	/** The requested label, e.g. `7d`, `6h`. */
	readonly since: string;
	readonly fromIso: string;
	readonly toIso: string;
}

/** One aggregate row, keyed by the triplet that makes attribution possible:
 * the agent role, the resolved model profile it ran on, and the workflow
 * family (definition id). Averages exclude abandoned runs so a restarted
 * attempt's zeros never poison them. */
export interface SessionsRoleStat {
	readonly role: string;
	readonly profile: string;
	readonly family: string;
	/** Completed (non-abandoned) runs the averages are computed over. */
	readonly runs: number;
	readonly turns: number;
	readonly tools: number;
	/** `tools / turns` — the batching ratio. Low means one tool per turn. */
	readonly toolsPerTurn: number;
	readonly turnsPerRun: number;
	readonly zeroToolTurns: number;
	readonly singleToolTurns: number;
	readonly multiToolTurns: number;
	readonly toolFailures: number;
	/** Consecutive identical tool calls (same tool + same arguments), when
	 * content capture was on. A content-free count of wasted repeats; 0 when
	 * capture was off. */
	readonly repeatedCalls: number;
	readonly blockedHandoffs: number;
	/** Runs that launched but produced no turn (ghosts from a restart/repair),
	 * counted here but excluded from `runs` and every average. */
	readonly abandonedRuns: number;
	readonly cost: number;
}

/** What kind of fix a finding points at. The attribution model lives here: a
 * signal is only `prompt` when it holds across ≥2 profiles for the role; a
 * signal seen under a single profile is `config` (the model cannot be
 * exonerated), and orchestration waste is `engine`. */
export type SessionsFindingKind = "prompt" | "config" | "engine" | "task";

export interface SessionsFinding {
	readonly title: string;
	readonly severity: "high" | "medium" | "low";
	readonly scope: {
		readonly role?: string;
		readonly profile?: string;
		readonly family?: string;
	};
	readonly metric: string;
	readonly value: number;
	readonly threshold: number;
	/** Counts and a one-line explanation — never session content. */
	readonly evidence: { readonly runs: number; readonly detail: string };
	readonly recommendationKind: SessionsFindingKind;
}

export interface SessionsReportTotals {
	readonly workflows: number;
	readonly runs: number;
	readonly turns: number;
	readonly tools: number;
	readonly toolFailures: number;
	readonly abandonedRuns: number;
	readonly cost: number;
}

export interface SessionsReport {
	readonly window: SessionsReportWindow;
	readonly totals: SessionsReportTotals;
	/** Targets whose store/telemetry could not be read, named not silently
	 * dropped (mirrors the launch-limit "counted as zero and named" rule). */
	readonly skippedTargets: readonly string[];
	readonly roles: readonly SessionsRoleStat[];
	/** Ranked, bounded list of the findings worth a human's attention. */
	readonly findings: readonly SessionsFinding[];
}
