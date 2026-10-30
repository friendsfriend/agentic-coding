import { execFile } from "node:child_process";
import {
	SchedulingDestinationUnavailable,
	SchedulingInfrastructureError,
} from "./adapters.ts";

/** No shell, hooks or fsmonitor. Deadline/abort uses SIGKILL and settles only
 * after close (including stream disposal), never leaves a child behind. */
export function validateSessionBase(
	cwd: string,
	base: string,
	options: {
		timeoutMs?: number;
		signal?: AbortSignal;
		gitExecutable?: string;
	} = {},
): Promise<void> {
	return new Promise((resolve, reject) => {
		let failure: (Error & { killed?: boolean; code?: string | number }) | null =
			null;
		const child = execFile(
			options.gitExecutable ?? "git",
			[
				"-c",
				"core.hooksPath=/dev/null",
				"-c",
				"core.fsmonitor=false",
				"-C",
				cwd,
				"rev-parse",
				"--verify",
				"--end-of-options",
				`${base}^{commit}`,
			],
			{
				timeout: options.timeoutMs ?? 5000,
				killSignal: "SIGKILL",
				maxBuffer: 65536,
				signal: options.signal,
			},
			(error) => {
				failure = error;
			},
		);
		child.once("error", (error) => {
			failure = error;
		});
		child.once("close", () => {
			if (!failure) {
				resolve();
				return;
			}
			reject(
				failure.killed ||
					failure.code === "ABORT_ERR" ||
					options.signal?.aborted
					? new SchedulingInfrastructureError(
							"Collection repository/baseBranch validation timed out or was cancelled; retry is safe.",
						)
					: new SchedulingDestinationUnavailable(
							"Collection repository/baseBranch is unavailable.",
						),
			);
		});
	});
}
