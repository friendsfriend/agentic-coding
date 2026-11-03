import type { EnvironmentRun } from "./state.ts";
export type LogOptions = { grep?: string; tail?: number };
type LogRun = Pick<
	EnvironmentRun,
	"id" | "owner" | "state" | "exitCode" | "signal" | "output" | "plan"
>;
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
		grep.length > 512
	)
		throw new Error(
			"Logs require tail 1–1000 and a literal grep of at most 512 characters",
		);
	const outputBudgetBytes = 12288;
	let remaining = outputBudgetBytes;
	return {
		app,
		grep,
		tail,
		source: "retained-redacted-runtime-buffer",
		outputBudgetBytes,
		runWindow: "up-to-20-recent-runs-live-first",
		runs: runs.slice(0, 20).map((run) => {
			const lines = run.output.split("\n");
			if (lines.at(-1) === "") lines.pop();
			// The capture window may start halfway through an old line. Do not invent a
			// complete first line when the runtime's 64k-character buffer reaches its cap.
			const boundaryLineWithheld = run.output.length >= 64000;
			if (boundaryLineWithheld) lines.shift();
			const matches = lines.filter((line) => line.includes(grep)),
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
				runtime: run.plan.runtime,
				action: run.plan.action,
				state: run.state,
				exitCode: run.exitCode,
				signal: run.signal,
				framing:
					run.plan.runtime === "compose"
						? "aggregate-service-buffers-not-chronological"
						: run.plan.runtime === "kubernetes"
							? "client-diagnostics-only-not-pod-logs"
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
