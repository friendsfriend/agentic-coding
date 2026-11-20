import type { EnvironmentRun } from "../state.ts";

type Observation = Pick<
	EnvironmentRun,
	"state" | "exitCode" | "signal" | "cleanupRetention"
> & { plan: Pick<EnvironmentRun["plan"], "action"> };

/** Attempts and bounded acquisition receipts are not proof that any app started. */
export function executionResult(
	dispatched: unknown,
	runs: readonly Observation[],
	threw: boolean,
	aborted: boolean,
) {
	const failed =
		threw ||
		aborted ||
		!Array.isArray(dispatched) ||
		!dispatched.length ||
		!runs.length ||
		runs.some(
			(run) =>
				(run.plan.action !== "run" && run.state !== "exited") ||
				(run.state === "exited" && (run.exitCode !== 0 || run.signal !== null)),
		);
	const inspectionRequired = runs.some(
		(run) =>
			run.state === "interrupted" ||
			run.cleanupRetention ||
			run.state === "reserved" ||
			run.state === "stopping" ||
			(failed && run.state !== "exited"),
	);
	return {
		inspectionRequired,
		status: inspectionRequired
			? "unknown"
			: failed
				? "failed"
				: runs.some(
							(run) => run.plan.action === "run" && run.state === "running",
						)
					? "running"
					: "completed",
	};
}
