import type {
	AgentUsageMetrics,
	CostMessage,
	CostRow,
	FindingCounts,
	VerifierFinding,
} from "../contracts/workflow.ts";

// Shared run projections over workflow views (establish-opencode-boundaries,
// task 2.4): the dashboard, the server operations and the in-process gateway
// all need to agree on which run represents a role, so the selector lives in
// the pure workflow layer instead of either presentation/transport side.
/** Latest run per role, selected by attempt. The one per-role run projection
 * shared by the dashboard pane map (`viewToDashboardState`) and the agent list
 * (`loadDashboard`), so every per-role lookup (status, runtime, focus pane)
 * agrees on which run represents a role. */
export function latestRunsByRole<T extends { role: string; attempt: number }>(
	runs: Iterable<T>,
): Map<string, T> {
	const latest = new Map<string, T>();
	for (const run of runs) {
		const existing = latest.get(run.role);
		if (!existing || existing.attempt <= run.attempt) latest.set(run.role, run);
	}
	return latest;
}

/** Aggregate per-role agent metrics from a workflow's telemetry events:
 * summed cost/tokens/cache-read from usage events, active runtime from the
 * role's lifecycle turns (idle gaps between turns excluded), and output tokens
 * per second preferring summed per-message generation time over the wall-clock
 * span. Roles without any metric are omitted from the result. */
export function agentMetrics(
	events: Array<Record<string, unknown>>,
): Map<string, AgentUsageMetrics> {
	const byRole = new Map<string, MetricAccumulator>();
	for (const event of events) {
		const role = event.role;
		if (typeof role !== "string") continue;
		const row = byRole.get(role) ?? {};
		byRole.set(role, row);
		const at = Date.parse(String(event.at ?? ""));
		if (Number.isFinite(at)) {
			row.firstAt = row.firstAt === undefined ? at : Math.min(row.firstAt, at);
			row.lastAt = row.lastAt === undefined ? at : Math.max(row.lastAt, at);
			const name = String(event.event ?? "");
			if (
				ACTIVE_START_EVENT_NAMES.has(name) ||
				ACTIVE_END_EVENT_NAMES.has(name)
			) {
				if (!row.activeBoundaries) row.activeBoundaries = [];
				row.activeBoundaries.push({
					at,
					start: ACTIVE_START_EVENT_NAMES.has(name),
				});
			}
		}
		if (!isUsageEvent(event)) continue;
		const cacheInputsComplete = [
			"inputTokens",
			"cacheReadTokens",
			"cacheWriteTokens",
		].every((field) => {
			const value = event[field];
			return typeof value === "number" && Number.isFinite(value) && value >= 0;
		});
		row.cacheInputsComplete =
			(row.cacheInputsComplete ?? true) && cacheInputsComplete;
		for (const field of [
			"cost",
			"inputTokens",
			"outputTokens",
			"cacheReadTokens",
			"cacheWriteTokens",
		] as const) {
			const value = event[field];
			if (typeof value !== "number" || !Number.isFinite(value) || value < 0)
				continue;
			row[field] = (row[field] ?? 0) + value;
			row.hasUsage = true;
		}
		const durationMs = event.durationMs;
		if (
			typeof durationMs === "number" &&
			Number.isFinite(durationMs) &&
			durationMs > 0
		)
			row.generationMs = (row.generationMs ?? 0) + durationMs;
	}
	const result = new Map<string, AgentUsageMetrics>();
	for (const [role, row] of byRole) {
		const wallClockSeconds =
			row.firstAt !== undefined &&
			row.lastAt !== undefined &&
			row.lastAt > row.firstAt
				? Math.max(0, Math.round((row.lastAt - row.firstAt) / 1000))
				: undefined;
		const durationSeconds = activeDurationSeconds(
			row.activeBoundaries ?? [],
			wallClockSeconds,
			row.lastAt,
		);
		const outputTokens = row.outputTokens ?? 0;
		const generationSeconds = (row.generationMs ?? 0) / 1000;
		const tokensPerSecond =
			outputTokens > 0 && generationSeconds > 0
				? Math.round((outputTokens / generationSeconds) * 10) / 10
				: undefined;
		if (!row.hasUsage && durationSeconds === undefined) continue;
		result.set(role, {
			...(row.cost !== undefined ? { cost: row.cost } : {}),
			...(row.inputTokens !== undefined
				? { inputTokens: row.inputTokens }
				: {}),
			...(row.outputTokens !== undefined
				? { outputTokens: row.outputTokens }
				: {}),
			...(row.cacheInputsComplete && row.cacheReadTokens !== undefined
				? { cacheReadTokens: row.cacheReadTokens }
				: {}),
			...(row.cacheInputsComplete && row.cacheWriteTokens !== undefined
				? { cacheWriteTokens: row.cacheWriteTokens }
				: {}),
			...(durationSeconds !== undefined ? { durationSeconds } : {}),
			...(tokensPerSecond !== undefined ? { tokensPerSecond } : {}),
		});
	}
	return result;
}

/** Per-role lifetime cost from model_usage rows (one per assistant message).
 * Accepts both `runtime.usage` and legacy `model_usage` event names. */
export function costSummary(events: Array<Record<string, unknown>>): CostRow[] {
	const byRole = new Map<string, CostRow>();
	for (const event of events) {
		const role = event.role;
		if (!isUsageEvent(event) || typeof role !== "string") continue;
		const row = byRole.get(role) ?? {
			role,
			messages: 0,
			inputTokens: 0,
			outputTokens: 0,
			totalTokens: 0,
			cost: 0,
		};
		row.messages += 1;
		row.inputTokens += Number(event.inputTokens ?? 0);
		row.outputTokens += Number(event.outputTokens ?? 0);
		row.totalTokens += Number(event.totalTokens ?? 0);
		row.cost += Number(event.cost ?? 0);
		byRole.set(role, row);
	}
	return [...byRole.values()].sort((a, b) => b.cost - a.cost);
}

/** Per-message cost rows for one role, oldest first. */
export function costMessages(
	events: Array<Record<string, unknown>>,
	role: string,
): CostMessage[] {
	return events
		.filter((event) => isUsageEvent(event) && event.role === role)
		.sort((a, b) => String(a.at).localeCompare(String(b.at)))
		.map((event) => ({
			at: String(event.at ?? ""),
			inputTokens: Number(event.inputTokens ?? 0),
			outputTokens: Number(event.outputTokens ?? 0),
			totalTokens: Number(event.totalTokens ?? 0),
			cost: Number(event.cost ?? 0),
		}));
}

export function countVerifierFindings(
	findings: Array<Pick<VerifierFinding, "severity">>,
): FindingCounts {
	const counts: FindingCounts = { critical: 0, warning: 0, info: 0 };
	for (const finding of findings) counts[finding.severity]++;
	return counts;
}

export const USAGE_EVENT_NAMES = new Set(["runtime.usage", "model_usage"]);

/** Telemetry events that open/close an agent's active turn. `runtime.*` is the
 * current pi bridge naming; `pi_agent_*` is kept for older telemetry files. */
export const ACTIVE_START_EVENT_NAMES = new Set([
	"runtime.started",
	"pi_agent_start",
]);
export const ACTIVE_END_EVENT_NAMES = new Set([
	"runtime.settled",
	"pi_agent_end",
	"pi_agent_settled",
]);

function isUsageEvent(event: Record<string, unknown>): boolean {
	return USAGE_EVENT_NAMES.has(String(event.event));
}

interface MetricAccumulator extends AgentUsageMetrics {
	generationMs?: number;
	firstAt?: number;
	lastAt?: number;
	hasUsage?: boolean;
	cacheInputsComplete?: boolean;
	activeBoundaries?: Array<{ at: number; start: boolean }>;
}

/** Sum the agent's active turn intervals, excluding the idle gaps between them.
 * A turn opens on `runtime.started`/`pi_agent_start` and closes on the next
 * `runtime.settled`/`pi_agent_end`/`pi_agent_settled`; a turn still in flight
 * closes at the role's last observed event. Falls back to the wall-clock
 * first→last span when the role recorded no lifecycle boundaries at all. */
function activeDurationSeconds(
	boundaries: Array<{ at: number; start: boolean }>,
	fallbackSeconds: number | undefined,
	lastAt: number | undefined,
): number | undefined {
	if (boundaries.length === 0) return fallbackSeconds;
	let openAt: number | undefined;
	let totalMs = 0;
	for (const boundary of [...boundaries].sort((a, b) => a.at - b.at)) {
		if (boundary.start) {
			if (openAt === undefined) openAt = boundary.at;
			continue;
		}
		if (openAt === undefined) continue;
		totalMs += Math.max(0, boundary.at - openAt);
		openAt = undefined;
	}
	if (openAt !== undefined) totalMs += Math.max(0, (lastAt ?? openAt) - openAt);
	return Math.max(0, Math.round(totalMs / 1000));
}
