import { parentPort } from "node:worker_threads";
import {
	type SessionBatchReply,
	type SessionRequest,
	verifyWorkflowSessions,
} from "./workflow-session-lookup.ts";

const port = parentPort;
if (!port)
	throw new Error("workflow session verifier requires a worker thread");
port.on(
	"message",
	(batch: {
		target: string;
		workflowId: string;
		requests: SessionRequest[];
	}) => {
		// A transport-level acceptance marker allows observers to distinguish an
		// executing lookup from worker construction/loading, even if SQLite blocks.
		port.postMessage({ started: true } satisfies SessionBatchReply);
		let reply: SessionBatchReply;
		try {
			reply = {
				results: verifyWorkflowSessions(
					batch.target,
					batch.workflowId,
					batch.requests,
				),
			};
		} catch (error) {
			reply = { error: error instanceof Error ? error.message : String(error) };
		}
		port.postMessage(reply);
	},
);
