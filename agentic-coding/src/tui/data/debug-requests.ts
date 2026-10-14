// Delegated debug request reads (add-debug-subagent-requests).
//
// One workflow's requests, each with the report it produced and the evidence
// filed under it, read through the gateway port like every other dashboard
// read. Cached under one key so a workflow event (a new request, a finished
// run) drops it: the report text is the reason it is not memoized more
// aggressively.
//
// Reads only: the view offers navigation and opening files, never an action, so
// this module has none.
import type { DebugRequests } from "../../contracts/environment.ts";
import { debugRequestsSchema } from "../../contracts/environment.ts";
import { cache, gateway } from "./index.ts";

type Signal = AbortSignal | undefined;

export interface DebugRequestsReadOptions {
	readonly refresh?: boolean;
}

export function debugRequestsKey(repo: string, workflowId: string): string {
	return `debug-requests:${repo}:${workflowId}`;
}

/** One workflow's delegated debug requests, oldest first. */
export async function loadDebugRequests(
	repo: string,
	workflowId: string,
	signal?: Signal,
	options: DebugRequestsReadOptions = {},
): Promise<DebugRequests | undefined> {
	return cache.load(
		debugRequestsKey(repo, workflowId),
		(readSignal) =>
			gateway().observe<DebugRequests>(
				{ kind: "debug-requests", repo, workflowId },
				debugRequestsSchema,
				readSignal,
			),
		{ signal, ...options },
	);
}
