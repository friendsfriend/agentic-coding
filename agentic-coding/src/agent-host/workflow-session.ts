// Dashboard-scoped batching and off-thread validation. No authoritative SQLite
// or filesystem work runs in this resolver; a single lazy worker owns that I/O.
import type { AuthenticatedHostEndpoint } from "./host-identity.ts";
import type {
	SessionBatchReply,
	SessionRequest,
	Verification,
} from "./workflow-session-lookup.ts";

export { workflowSessionSocket } from "./workflow-session-lookup.ts";

declare const WORKFLOW_SESSION_WORKER_PATH: string | undefined;

export interface WorkflowSessionResolver {
	resolve(runId: string, recordedSocket: string): Promise<string>;
	connection(
		runId: string,
		recordedSocket: string,
	): Promise<AuthenticatedHostEndpoint>;
	dispose(): void;
}

/** The optional executor is a focused-test seam; production always uses the
 * worker. Batches are serialized, with new acquisitions coalesced while busy.
 * No history-sized cache is retained and no handle is exposed before validation. */
export function createWorkflowSessionResolver(
	target: string,
	workflowId: string,
	execute?: (
		target: string,
		workflowId: string,
		requests: readonly SessionRequest[],
	) => Promise<Verification[]>,
): WorkflowSessionResolver {
	type Pending = SessionRequest & {
		resolve: (endpoint: { socket: string; fingerprint?: string }) => void;
		reject: (error: unknown) => void;
	};
	let pending: Pending[] = [];
	const outstanding = new Set<Pending>();
	let disposed = false;
	let busy = false;
	let failure: Error | undefined;
	let worker: Worker | undefined;
	let flight:
		| {
				resolve: (value: Verification[]) => void;
				reject: (error: unknown) => void;
		  }
		| undefined;
	const cancelled = () => new Error("workflow session resolver is disposed");
	const fail = (error: Error) => {
		failure = error;
		flight?.reject(error);
		flight = undefined;
		for (const request of outstanding) request.reject(error);
		outstanding.clear();
		pending = [];
		worker?.terminate();
	};
	const inWorker = (requests: readonly SessionRequest[]) => {
		if (!worker) {
			const file =
				typeof WORKFLOW_SESSION_WORKER_PATH === "string"
					? WORKFLOW_SESSION_WORKER_PATH
					: new URL("./workflow-session-worker.ts", import.meta.url);
			worker = new Worker(file, { preload: [] });
			worker.addEventListener(
				"message",
				(event: MessageEvent<SessionBatchReply>) => {
					const reply = event.data;
					if ("started" in reply) return;
					const current = flight;
					flight = undefined;
					if ("error" in reply) current?.reject(new Error(reply.error));
					else current?.resolve(reply.results);
				},
			);
			worker.addEventListener("error", (event) =>
				fail(new Error(event.message)),
			);
			worker.addEventListener("close", () => {
				if (!disposed && !failure)
					fail(new Error("workflow session verifier stopped"));
			});
		}
		const current = worker;
		return new Promise<Verification[]>((resolve, reject) => {
			flight = { resolve, reject };
			// Transport only identities, never callbacks or pending promise handles.
			current.postMessage({
				target,
				workflowId,
				requests: requests.map(({ runId, recordedSocket, authenticated }) => ({
					runId,
					recordedSocket,
					...(authenticated ? { authenticated: true } : {}),
				})),
			});
		});
	};
	const flush = async () => {
		if (busy || disposed || failure) return;
		const batch = pending;
		pending = [];
		if (!batch.length) return;
		busy = true;
		try {
			const verified = await (execute
				? execute(target, workflowId, batch)
				: inWorker(batch));
			for (const [index, request] of batch.entries()) {
				const result = verified[index];
				if (disposed) request.reject(cancelled());
				else if (!result)
					request.reject(new Error("workflow session is unavailable"));
				else if ("error" in result) request.reject(new Error(result.error));
				else request.resolve(result);
			}
		} catch (error) {
			for (const request of batch) request.reject(error);
		} finally {
			for (const request of batch) outstanding.delete(request);
			busy = false;
			if (pending.length) queueMicrotask(flush);
		}
	};
	const acquire = (
		runId: string,
		recordedSocket: string,
		authenticated = false,
	) => {
		if (disposed) return Promise.reject(cancelled());
		if (failure) return Promise.reject(failure);
		return new Promise<{ socket: string; fingerprint?: string }>(
			(resolve, reject) => {
				const request = {
					runId,
					recordedSocket,
					authenticated,
					resolve,
					reject,
				};
				outstanding.add(request);
				pending.push(request);
				if (pending.length === 1) queueMicrotask(flush);
			},
		).then((endpoint) => {
			if (disposed) throw cancelled();
			return endpoint;
		});
	};
	return {
		async resolve(runId, recordedSocket) {
			return (await acquire(runId, recordedSocket)).socket;
		},
		async connection(runId, recordedSocket) {
			const endpoint = await acquire(runId, recordedSocket, true);
			if (!endpoint.fingerprint)
				throw new Error("agent host instance identity is unavailable");
			return { socket: endpoint.socket, fingerprint: endpoint.fingerprint };
		},
		dispose() {
			if (disposed) return;
			disposed = true;
			for (const request of outstanding) request.reject(cancelled());
			outstanding.clear();
			pending = [];
			flight?.reject(cancelled());
			flight = undefined;
			worker?.terminate();
		},
	};
}
