// Opening one debug request's report file (add-debug-subagent-requests).
//
// The report path comes from the workflow's own store row, so it is inside the
// workflow's data directory and never a caller-supplied path. The launch is the
// same side app every other "open this file" action uses; the pre-flight check
// refuses a file that is missing, is not a regular file, or was replaced by a
// symlink, and an opener that exits non-zero is reported rather than swallowed.
import fs from "node:fs";
import type { DebugRequestView } from "../../contracts/environment.ts";
import type { WorkflowState } from "../../contracts/workflow.ts";
import { debugRequestReportPathFor } from "../../workflow/runtime/evidence-store.ts";
import {
	runSideApp,
	type SideAppOutcome,
	systemOpenerSideApp,
} from "../shared/side-app.ts";
import { EvidencePathError } from "./evidence-open.ts";

/** The workflow state the report address is derived from, exactly as the
 * evidence panel derives an entry's file. */
export type DebugRequestLocationState = Pick<
	WorkflowState,
	"workflowId" | "worktree" | "repository"
>;

/** The absolute path of one request's report on this machine.
 *
 * The path is recomputed from the workflow's own identity and the request id
 * rather than taken from the row: the store lives inside the workflow's
 * checkout, which its runs write to, so a `report_path` an agent chose must not
 * reach the platform opener. A row that names anything else is refused. */
export function debugRequestReportLocalPath(
	state: DebugRequestLocationState,
	request: Pick<DebugRequestView, "id" | "reportPath">,
): string {
	let expected: string;
	try {
		expected = debugRequestReportPathFor(
			state.repository,
			state.worktree,
			state.workflowId,
			request.id,
		);
	} catch {
		throw new EvidencePathError(
			`${JSON.stringify(request.id)} is not a usable debug request id`,
		);
	}
	if (request.reportPath !== undefined && request.reportPath !== expected)
		throw new EvidencePathError(
			"the request's report path is outside this workflow's debug requests",
		);
	return expected;
}

/** Open a request's report with the platform's system opener. */
export async function openDebugRequestReport(
	state: DebugRequestLocationState,
	request: Pick<DebugRequestView, "id" | "reportPath">,
	open: typeof runSideApp = runSideApp,
): Promise<void> {
	const reportPath = debugRequestReportLocalPath(state, request);
	let stat: fs.Stats;
	try {
		stat = fs.lstatSync(reportPath);
	} catch {
		throw new EvidencePathError(`${reportPath} is not on this machine`);
	}
	if (!stat.isFile())
		throw new EvidencePathError(`${reportPath} is not a regular file`);
	const outcome: SideAppOutcome = await open(systemOpenerSideApp(reportPath));
	if (outcome.status !== undefined && outcome.status !== 0)
		throw new EvidencePathError(
			`${reportPath}: ${outcome.stderr?.trim() || `the opener exited ${outcome.status}`}`,
		);
}
