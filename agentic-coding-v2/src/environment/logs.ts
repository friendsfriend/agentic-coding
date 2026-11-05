import { logSince, timedLines } from "./log-timing.ts";
import type { LogTiming } from "./process.ts";

/** Docker/Podman line timestamps are the only provider event time exposed here. */
function providerTimed(timing: LogTiming | undefined) {
	return timing?.basis === "provider-event-time-completed-lines";
}

import type { EnvironmentRun } from "./state.ts";
export type LogOptions = {
	grep?: string;
	since?: string;
	tail?: number;
	service?: string;
	kind?: "infrastructure";
};
type LogRun = Pick<
	EnvironmentRun,
	| "id"
	| "owner"
	| "state"
	| "exitCode"
	| "signal"
	| "output"
	| "plan"
	| "serviceLogs"
	| "logTiming"
>;
function logSource(run: LogRun, service?: string) {
	if (!service)
		return {
			output: run.output,
			timing: run.logTiming,
			availability: "available",
			sourceTruncated: false,
		};
	const empty = { output: "", sourceTruncated: false, timing: undefined };
	if (run.plan.runtime !== "compose")
		return { ...empty, availability: "unsupported-runtime" };
	if (!run.plan.composePlan?.services.some((item) => item.id === service))
		return { ...empty, availability: "not-declared" };
	const capture = run.serviceLogs?.[service];
	if (!capture || !Object.hasOwn(run.serviceLogs ?? {}, service))
		return { ...empty, availability: "not-captured" };
	return {
		output: capture.output,
		timing: capture.timing,
		sourceTruncated: capture.truncated,
		availability: "available",
	};
}
/** Select only already-redacted, retained runtime output. Never contacts a runtime
 * or treats buffered output as an unbounded historical/chronological log source. */
export function logView(
	app: string,
	runs: readonly LogRun[],
	options: LogOptions,
) {
	const tail = options.tail ?? 200,
		grep = options.grep ?? "";
	if (
		!Number.isInteger(tail) ||
		tail < 1 ||
		tail > 1000 ||
		typeof grep !== "string" ||
		grep.length > 512 ||
		(options.service !== undefined &&
			(typeof options.service !== "string" ||
				options.service.length < 1 ||
				options.service.length > 64))
	)
		throw new Error(
			"Logs require tail 1–1000, literal grep up to 512 characters, and an optional exact service name of 1–64 characters",
		);
	const since = logSince(options.since);
	const outputBudgetBytes = 12288;
	let remaining = outputBudgetBytes;
	return {
		app,
		...(options.kind ? { projectKind: options.kind } : {}),
		grep,
		tail,
		...(since ? { since: since.toString() } : {}),
		...(options.service ? { service: options.service } : {}),
		source: "retained-redacted-runtime-buffer",
		outputBudgetBytes,
		runWindow: "up-to-20-recent-runs-live-first",
		runs: runs.slice(0, 20).map((run) => {
			const {
				output: source,
				timing,
				availability,
				sourceTruncated,
			} = logSource(run, options.service);
			const lines = source.split("\n");
			if (lines.at(-1) === "") lines.pop();
			// The capture window may start halfway through an old line. Do not invent a
			// complete first line when the runtime's 64k-character buffer reaches its cap.
			const boundaryLineWithheld = source.length >= 64000;
			if (boundaryLineWithheld) lines.shift();
			const filtered = timedLines(
				source,
				lines,
				timing,
				since,
				boundaryLineWithheld,
			);
			const matches = filtered.lines.filter((line) => line.includes(grep)),
				selected = matches.slice(-tail),
				returned: string[] = [];
			for (const line of selected.toReversed()) {
				const cost = Buffer.byteLength(JSON.stringify(line)) + 2;
				if (cost > remaining) break;
				returned.unshift(line);
				remaining -= cost;
			}
			return {
				id: run.id,
				owner: run.owner,
				projectKind: run.plan.projectKind ?? "not-recorded",
				runtime: run.plan.runtime,
				action: run.plan.action,
				state: run.state,
				exitCode: run.exitCode,
				signal: run.signal,
				sourceAvailability: availability,
				sourceTruncated,
				timeSelection: filtered.timeSelection,
				framing: options.service
					? providerTimed(timing)
						? "exact-service-buffer-provider-event-time"
						: "exact-service-buffer-not-event-time"
					: run.plan.runtime === "compose"
						? "aggregate-service-buffers-not-chronological"
						: run.plan.runtime === "kubernetes"
							? providerTimed(timing)
								? "single-pod-buffer-provider-event-time"
								: "client-diagnostics-only-not-pod-logs"
							: providerTimed(timing)
								? "runtime-buffer-order-provider-event-time"
								: "runtime-buffer-order-not-event-time",
				output: returned.length ? `${returned.join("\n")}\n` : "",
				selection: {
					matchedRetainedLines: matches.length,
					selectedLines: selected.length,
					returnedLines: returned.length,
					omittedForBudget: selected.length - returned.length,
					tailLimited: matches.length > tail,
					boundaryLineWithheld,
				},
			};
		}),
	};
}
