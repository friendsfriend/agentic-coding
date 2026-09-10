import type { RunStatus } from "../../workflow/contracts.ts";
import { agentMetrics } from "./projections";
import type { DashboardData, FindingCounts } from "./types";

/** Demo dashboard fixture for `--profile test` renders and characterizations.
 * Kept out of the live observation/projection modules so the "dashboard"
 * observation path never imports fixture code (design: demo ownership). */
export function testDashboard(phase = "proposed"): DashboardData {
	const applying = [
		"apply",
		"verify",
		"developer-review",
		"archive",
		"committing",
		"completed",
		"closed",
	].includes(phase);
	const verified = [
		"developer-review",
		"archive",
		"committing",
		"completed",
		"closed",
	].includes(phase);
	const archived = ["completed", "closed"].includes(phase);
	const verifierStatus: RunStatus =
		phase === "verify" ? "working" : verified ? "completed" : "pending";
	const testVerifierStatus: RunStatus = verified ? "completed" : "pending";
	const archiveAgents: DashboardData["agents"] =
		phase === "archive" || archived
			? [{ role: "archive", status: archived ? "completed" : "working" }]
			: [];
	// Demo telemetry mirrors what the pi bridge emits: runtime lifecycle plus
	// per-message usage rows carrying cache/duration/tok-s fields. Metrics are
	// derived through the real aggregation so fixtures cannot drift from it.
	const demoTelemetry: Array<Record<string, unknown>> = [
		{ event: "runtime.started", role: "planner", at: "2026-01-01T10:35:00Z" },
		{
			event: "runtime.usage",
			role: "planner",
			at: "2026-01-01T10:41:55Z",
			inputTokens: 2100,
			outputTokens: 400,
			cacheReadTokens: 1680,
			cacheWriteTokens: 0,
			cost: 0.08,
			durationMs: 52000,
		},
		{ event: "runtime.settled", role: "planner", at: "2026-01-01T10:41:58Z" },
		{ event: "runtime.started", role: "worker", at: "2026-01-01T10:42:00Z" },
		{
			event: "runtime.usage",
			role: "worker",
			at: "2026-01-01T10:44:12Z",
			inputTokens: 5200,
			outputTokens: 1400,
			cacheReadTokens: 4200,
			cacheWriteTokens: 100,
			cost: 0.21,
			durationMs: 61000,
		},
		{
			event: "runtime.usage",
			role: "worker",
			at: "2026-01-01T10:48:03Z",
			inputTokens: 4800,
			outputTokens: 1100,
			cacheReadTokens: 3900,
			cacheWriteTokens: 200,
			cost: 0.21,
			durationMs: 55000,
		},
		{
			event: "runtime.started",
			role: "security-verifier",
			at: "2026-01-01T10:49:30Z",
		},
		{
			event: "runtime.usage",
			role: "security-verifier",
			at: "2026-01-01T10:50:20Z",
			inputTokens: 3200,
			outputTokens: 600,
			cacheReadTokens: 2600,
			cacheWriteTokens: 0,
			cost: 0.05,
			durationMs: 30000,
		},
		// Partial coverage: lifecycle events only, so duration renders without
		// inventing token or cost values.
		{
			event: "runtime.started",
			role: "agents-verifier",
			at: "2026-01-01T10:50:40Z",
		},
		{
			event: "runtime.settled",
			role: "agents-verifier",
			at: "2026-01-01T10:51:30Z",
		},
		{
			event: "runtime.started",
			role: "quality-verifier",
			at: "2026-01-01T10:50:00Z",
		},
		{
			event: "runtime.usage",
			role: "quality-verifier",
			at: "2026-01-01T10:51:07Z",
			inputTokens: 4100,
			outputTokens: 900,
			cacheReadTokens: 12300,
			cacheWriteTokens: 0,
			cost: 0.07,
			durationMs: 45000,
		},
	];
	const demoMetrics = agentMetrics(demoTelemetry);
	const demoFindingCounts: Record<string, FindingCounts | undefined> = {
		"security-verifier": { critical: 2, warning: 1, info: 0 },
		"quality-verifier": { critical: 0, warning: 3, info: 2 },
	};
	return {
		state: {
			workflowId: "demo-optional-realisation-date",
			changeId: "demo-optional-realisation-date",
			phase,
			revision: 0,
			status:
				phase === "closed"
					? "closed"
					: phase === "completed"
						? "completed"
						: "active",
			health: { valid: true, attention: [] },
			developerDialogue: [],
			pendingQuestions: [],
			runs: [],
			repository: "/demo/customer-mw",
			worktree: "/demo/worktrees/demo-optional-realisation-date",
			branch: "feature/demo-optional-realisation-date",
			workspace: "demo",
			verificationRound: verified ? 2 : phase === "verify" ? 1 : 0,
			ticketNumber: "12345",
			panes: {
				dashboard: "demo:p1",
				planner: "demo:p2",
				worker: "demo:p3",
				"security-verifier": "demo:p4",
				"agents-verifier": "demo:p5",
				"test-verifier": "demo:p6",
				"quality-verifier": "demo:p7",
				"usability-verifier": "demo:p8",
				"performance-verifier": "demo:p9",
				"openspec-verifier": "demo:p10",
				git: "demo:p11",
			},
		},
		request:
			"Make preferredLatestRealisationDate optional and default it to null.",
		proposal:
			"Update API contract, persistence mapping, form defaults, and regression coverage while preserving existing supplied values.",
		review: verified
			? "round-2.md: PASS"
			: phase === "verify"
				? "round-1.md: FAIL"
				: "Not run",
		reviewHistory: verified
			? ["round-1-consolidated.md: CLEAR", "round-2-consolidated.md: CLEAR"]
			: [],
		agents: [
			{
				role: "planner",
				status: applying ? "completed" : "working",
				runtime: "pi",
				model: "provider/planner",
				cost: 0.08,
				metrics: demoMetrics.get("planner"),
			},
			{
				role: "worker",
				status:
					phase === "apply" ? "working" : applying ? "completed" : "pending",
				runtime: "opencode",
				model: "provider/worker",
				cost: 0.42,
				metrics: demoMetrics.get("worker"),
			},
			...[
				"security-verifier",
				"agents-verifier",
				"quality-verifier",
				"usability-verifier",
				"performance-verifier",
				"openspec-verifier",
			].map((role) => ({
				role,
				runtime: role === "security-verifier" ? "opencode-v2" : undefined,
				model: role === "security-verifier" ? "provider/security" : undefined,
				status: verifierStatus,
				metrics: demoMetrics.get(role),
				findingCounts: demoFindingCounts[role],
			})),
			{
				role: "test-verifier",
				status: testVerifierStatus,
			},
			...archiveAgents,
		],
		updated: new Date().toLocaleTimeString(),
		health: {
			dirty: false,
			ahead: 0,
			behind: 0,
			branch: "feature/demo-optional-realisation-date",
		},
		gitStatus: {
			available: true,
			branch: "feature/demo-optional-realisation-date",
			changedFiles: 0,
			addedFiles: 0,
			deletedFiles: 0,
			ahead: 0,
			behind: 0,
			noUpstream: false,
		},
		age: "2h",
		events: [
			...demoTelemetry.map((event) => ({
				at: String(event.at).slice(11, 19),
				event: String(event.event),
				role: event.role as string | undefined,
				cost: Number(event.cost ?? 0) || undefined,
				inputTokens: event.inputTokens as number | undefined,
				outputTokens: event.outputTokens as number | undefined,
			})),
			{
				at: "10:42:00",
				event: "verification_started",
				tier: "openspec-full",
				roles: ["security-verifier", "quality-verifier"],
			},
		],
		verifierTimeline:
			phase === "verify"
				? [
						{
							role: "security-verifier",
							status: "PASS",
							durationSeconds: 42,
							model: "claude-sonnet",
							providerErrors: 0,
							fallback: false,
						},
						{
							role: "quality-verifier",
							status: "PASS",
							durationSeconds: 78,
							model: "claude-sonnet",
							providerErrors: 0,
							fallback: false,
						},
						{
							role: "test-verifier",
							status: "RUN",
							durationSeconds: 184,
							model: "claude-sonnet",
							providerErrors: 0,
							fallback: false,
						},
					]
				: [],
		costBreakdown: [
			{
				role: "worker",
				inputTokens: 10000,
				outputTokens: 2500,
				totalTokens: 12500,
				cost: 0.42,
				messages: [
					{
						at: "10:44:12",
						inputTokens: 5200,
						outputTokens: 1400,
						totalTokens: 6600,
						cost: 0.21,
					},
					{
						at: "10:48:03",
						inputTokens: 4800,
						outputTokens: 1100,
						totalTokens: 5900,
						cost: 0.21,
					},
				],
			},
			{
				role: "planner",
				inputTokens: 2100,
				outputTokens: 400,
				totalTokens: 2500,
				cost: 0.08,
				messages: [
					{
						at: "10:41:55",
						inputTokens: 2100,
						outputTokens: 400,
						totalTokens: 2500,
						cost: 0.08,
					},
				],
			},
			{
				role: "quality-verifier",
				inputTokens: 4100,
				outputTokens: 900,
				totalTokens: 5000,
				cost: 0.07,
				messages: [
					{
						at: "10:51:07",
						inputTokens: 4100,
						outputTokens: 900,
						totalTokens: 5000,
						cost: 0.07,
					},
				],
			},
			{
				role: "security-verifier",
				inputTokens: 3200,
				outputTokens: 600,
				totalTokens: 3800,
				cost: 0.05,
				messages: [
					{
						at: "10:50:20",
						inputTokens: 3200,
						outputTokens: 600,
						totalTokens: 3800,
						cost: 0.05,
					},
				],
			},
		],
	};
}
