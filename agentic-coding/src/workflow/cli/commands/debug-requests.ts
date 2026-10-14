// Delegated debug request commands (add-debug-subagent-requests): the four
// `agentic-coding workflow` subcommands the agent tools call.
//
// They run in the caller process, exactly like `drain`/`repair`: the request
// command resolves the calling run's identity and capability through
// `resolveHandoffIdentity` (so a request can only be made by the run whose own
// environment it carries), then writes the request, its side run and the
// lifecycle effect in one engine transaction. The result and wait commands are
// observation-only store reads; the cancel command marks the request cancelled
// and asks the durable host to stop the delegated conversation.
import fs from "node:fs";
import type { WorkflowApplication } from "../../application.ts";
import {
	DEBUG_REQUEST_MAX_CONTEXT_CHARS,
	DEBUG_REQUEST_MAX_GOAL_CHARS,
	type DebugRequest,
	debugRequestDurationSeconds,
	normalizeDebugApps,
	resolveDebugReportPath,
	validateDebugRequestText,
} from "../../runtime/debug-requests.ts";
import type { WorkflowEngine } from "../../runtime.ts";
import { flag, requireFlag } from "../args.ts";
import { managedWorkflowTarget } from "../caller-environment.ts";
import { scheduleDrain } from "../drain.ts";
import { resolveHandoffIdentity } from "../identity.ts";

type App = WorkflowApplication;

/** How long `debug-wait` may block, and the poll interval it promises: a
 * request is polled through read-only store reads, never through a held write
 * lock. */
export const DEBUG_WAIT_MAX_SECONDS = 1800;
export const DEBUG_WAIT_DEFAULT_SECONDS = 300;
const DEBUG_WAIT_POLL_MS = 2000;
/** The report text one result prints. The report on disk is never truncated;
 * this is the bound on one tool answer. */
const REPORT_OUTPUT_MAX_CHARS = 32 * 1024;

/** One request as the caller sees it: the durable row plus the report text,
 * bounded for a tool answer. */
export interface DebugRequestView {
	readonly id: string;
	readonly status: DebugRequest["status"];
	readonly goal: string;
	readonly callerRole: string;
	readonly callerRunId: string;
	readonly durationSeconds?: number;
	readonly reportPath?: string;
	readonly changedFiles: readonly string[];
	/** Whether the changed-file list could measure tracked changes at all; when
	 * it could not, the list is only the untracked delta. */
	readonly baseline: "usable" | "unavailable";
	readonly delivered: boolean;
	readonly createdAt: string;
	readonly finishedAt?: string;
	readonly report?: string;
	/** True while no terminal status has been reached. */
	readonly open: boolean;
	/** What the caller should do next, in one line. */
	readonly next: string;
}

export function debugRequestView(request: DebugRequest): DebugRequestView {
	const durationSeconds = debugRequestDurationSeconds(request);
	const open = request.status === "queued" || request.status === "running";
	const report = readReport(request);
	return {
		id: request.id,
		status: request.status,
		goal: request.goal,
		callerRole: request.callerRole,
		callerRunId: request.callerRunId,
		...(durationSeconds === undefined ? {} : { durationSeconds }),
		...(request.reportPath ? { reportPath: request.reportPath } : {}),
		changedFiles: request.changedFiles,
		baseline: request.baselineUsable ? "usable" : "unavailable",
		delivered: request.deliveredAt !== undefined,
		createdAt: request.createdAt,
		...(request.finishedAt ? { finishedAt: request.finishedAt } : {}),
		...(report === undefined ? {} : { report }),
		open,
		next: open
			? "debug_wait with this request id blocks until it finishes; the report is also injected into this conversation when it lands."
			: "The full report stays available with debug_result and in the dashboard's debug requests view.",
	};
}

/** The stored report, or `undefined` when the request produced none (still
 * running, failed, or its file is gone). Never throws: an answer that cannot
 * read the file still reports the request's status. */
function readReport(report: DebugRequest): string | undefined {
	// The row's own `report_path` and `debug_run_id` locate the bytes, and a
	// staged rename an interrupted handoff left behind is completed here.
	const reportPath = resolveDebugReportPath(report);
	if (!reportPath) return undefined;
	try {
		if (!fs.statSync(reportPath).isFile()) return undefined;
		const text = fs.readFileSync(reportPath, "utf8");
		return text.length > REPORT_OUTPUT_MAX_CHARS
			? `${text.slice(0, REPORT_OUTPUT_MAX_CHARS)}\n… [report truncated at ${REPORT_OUTPUT_MAX_CHARS} characters; read ${reportPath}]`
			: text;
	} catch {
		return undefined;
	}
}

function requireRequest(
	workflowEngine: WorkflowEngine,
	target: string,
	requestId: string,
): DebugRequest {
	const request = workflowEngine.debugRequest(target, requestId);
	if (!request) throw new Error(`unknown debug request: ${requestId}`);
	return request;
}

export function runDebugRequest(
	rest: string[],
	workflowEngine: WorkflowEngine,
	_repo?: string,
	application?: App,
): void {
	const target = managedWorkflowTarget();
	const goal = requireFlag(rest, "goal");
	const context = flag(rest, "context");
	const apps = normalizeDebugApps(
		(flag(rest, "apps") ?? "")
			.split(",")
			.map((entry) => entry.trim())
			.filter(Boolean),
	);
	const refusal = validateDebugRequestText({
		goal,
		...(context === undefined ? {} : { context }),
	});
	if (refusal) throw new Error(`debug-request: ${refusal}`);
	// The capability of the calling run is authenticated here: a request can
	// only be made by the run whose environment carries it, never by another
	// run's role name.
	const identity = resolveHandoffIdentity(workflowEngine, target, application);
	const created = workflowEngine.requestDebugRun(target, {
		workflowId: identity.workflowId,
		callerRunId: identity.runId,
		callerRole: identity.role,
		goal,
		...(context === undefined ? {} : { context }),
		apps,
	});
	// The lifecycle effect is durable; scheduling only shortens the wait before
	// the delegated run starts.
	scheduleDrain(target);
	console.log(
		JSON.stringify(
			{
				...debugRequestView(created.request),
				runId: created.runId,
				goalLimit: DEBUG_REQUEST_MAX_GOAL_CHARS,
				contextLimit: DEBUG_REQUEST_MAX_CONTEXT_CHARS,
			},
			null,
			2,
		),
	);
}

export function runDebugResult(
	rest: string[],
	workflowEngine: WorkflowEngine,
): void {
	const target = managedWorkflowTarget();
	console.log(
		JSON.stringify(
			debugRequestView(
				requireRequest(workflowEngine, target, requireFlag(rest, "request-id")),
			),
			null,
			2,
		),
	);
}

export async function runDebugWait(
	rest: string[],
	workflowEngine: WorkflowEngine,
): Promise<void> {
	const target = managedWorkflowTarget();
	const requestId = requireFlag(rest, "request-id");
	const requested = flag(rest, "timeout-sec");
	const timeoutSec =
		requested === undefined ? DEBUG_WAIT_DEFAULT_SECONDS : Number(requested);
	if (
		!Number.isInteger(timeoutSec) ||
		timeoutSec < 1 ||
		timeoutSec > DEBUG_WAIT_MAX_SECONDS
	)
		throw new Error(
			`debug-wait: --timeout-sec must be an integer from 1 to ${DEBUG_WAIT_MAX_SECONDS}`,
		);
	const startedAt = Date.now();
	const deadline = startedAt + timeoutSec * 1000;
	for (;;) {
		const request = requireRequest(workflowEngine, target, requestId);
		const open = request.status === "queued" || request.status === "running";
		if (!open || Date.now() >= deadline) {
			console.log(
				JSON.stringify(
					{
						...debugRequestView(request),
						timedOut: open,
						waitedSec: Math.round((Date.now() - startedAt) / 1000),
					},
					null,
					2,
				),
			);
			return;
		}
		await Bun.sleep(DEBUG_WAIT_POLL_MS);
	}
}

export async function runDebugCancel(
	rest: string[],
	workflowEngine: WorkflowEngine,
	application?: App,
): Promise<void> {
	const target = managedWorkflowTarget();
	const requestId = requireFlag(rest, "request-id");
	// Only the run that asked for the request may cancel it: the capability is
	// authenticated here and re-checked inside the engine's write transaction, so
	// a sibling run (a delegated debug run in particular, which is denied the
	// request tools) cannot cancel work that is not its own.
	const identity = resolveHandoffIdentity(workflowEngine, target, application);
	const before = requireRequest(workflowEngine, target, requestId);
	if (before.callerRunId !== identity.runId)
		throw new Error(
			`debug-cancel: request ${requestId} belongs to another run`,
		);
	const cancelled = workflowEngine.cancelDebugRequest(
		target,
		requestId,
		identity.runId,
	);
	// Stop the delegated conversation. Best effort: a run that never launched, or
	// a host that is already gone, leaves the cancelled row as the answer.
	const runId = before.debugRunId;
	if (runId) {
		try {
			const run = workflowEngine.getRun(target, runId);
			const socket = run.handle?.hostSocket;
			const session = run.handle?.sessionId;
			if (socket && session) {
				const { HostClient } = await import("../../../agent-host/client.ts");
				await new HostClient(socket).abort(session);
			}
		} catch {
			// The request is cancelled whether or not the conversation could be
			// reached: the row is the durable answer.
		}
	}
	console.log(JSON.stringify(debugRequestView(cancelled), null, 2));
}
