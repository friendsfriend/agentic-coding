// Evidence routes (`add-workflow-evidence-store`): the attach/list surface a
// durable run's evidence tools call, and the file route the dashboard reads.
//
// Two authorizations meet here, and they are deliberately different surfaces:
//
// * `POST /api/v1/agent-env/evidence/attach` and `GET
//   /api/v1/agent-env/evidence` ride the owner-scoped environment capability a
//   run already holds (the same one `/api/v1/agent-env/*` uses), so a run can
//   only ever write evidence into *its own* workflow's store. The workflow is
//   located from the verified owner, never from the request body.
// * `GET /api/v1/evidence/{workflowId}/{id}` serves the recorded bytes to the
//   local dashboard under the instance capability, so a TUI can show evidence
//   without a second store or a second copy on disk.
import fs from "node:fs";
import type { EvidenceAttachRequest } from "../../contracts/environment.ts";
import type {
	WorkflowSnapshot,
	WorkflowStatus,
} from "../../contracts/workflow.ts";
import { engine as workflowEngine } from "../../workflow/operations.ts";
import {
	type WorkflowEvidenceLocation,
	type WorkflowEvidenceScope,
	workflowEvidenceScope,
} from "../../workflow/runtime/evidence-store.ts";
import {
	researchWorkflowTarget,
	wikiWorkflowTarget,
	workflowTargets,
} from "../../workflow/runtime.ts";
import { readJsonBody } from "../auth.ts";
import {
	AGENT_EVIDENCE_ATTACH_PATH,
	AGENT_EVIDENCE_LIST_PATH,
	decodeRouteRequest,
	EVIDENCE_FILE_PREFIX,
} from "../protocol.ts";
import {
	attachEvidence,
	EvidenceError,
	evidenceEntry,
	evidenceRequestDirectory,
	listEvidence,
	type OpenedEvidenceFile,
	openEvidenceFile,
	type EvidenceAttachRequest as StoreAttachRequest,
} from "./store.ts";

/** The owner-scoped evidence surface, under the run capability prefix. The
 * declared paths come from the transport manifest, so this module and
 * `ROUTE_REQUESTS` can never drift apart. */
export const EVIDENCE_AGENT_ATTACH_PATH = AGENT_EVIDENCE_ATTACH_PATH;
export const EVIDENCE_AGENT_LIST_PATH = AGENT_EVIDENCE_LIST_PATH;
/** The instance-authenticated file route. Re-exported from the transport
 * manifest, which owns every declared path. */
export { EVIDENCE_FILE_PREFIX };

/** One located workflow: its evidence address, plus the state an attach has to
 * re-check under the root lock. */
export interface LocatedEvidenceWorkflow extends WorkflowEvidenceLocation {
	/** The workflow's own status. `closed` means its workspace cleanup already
	 * removed the evidence directory. */
	readonly status?: WorkflowStatus;
}

/** Everything the evidence routes read. `locate` resolves a workflow id to the
 * workflow's own checkout/definition — the engine's state, never a request
 * path — and is injectable so a route test needs no store on disk. */
export interface EvidenceRouteDeps {
	readonly locate?: (workflowId: string) => LocatedEvidenceWorkflow | undefined;
	readonly now?: () => Date;
}

/** Locate one workflow by id across every recorded target, plus the shared
 * wiki/research stores. A workflow that is nowhere recorded has no evidence. */
export function locateEvidenceWorkflow(
	workflowId: string,
): LocatedEvidenceWorkflow | undefined {
	let targets: string[];
	try {
		targets = [
			...workflowTargets(),
			wikiWorkflowTarget(),
			researchWorkflowTarget(),
		];
	} catch {
		return undefined;
	}
	const engine = workflowEngine();
	for (const target of targets) {
		try {
			const snapshot: Pick<
				WorkflowSnapshot,
				"workflowId" | "metadata" | "definition" | "status"
			> = engine.getSnapshot(target, workflowId);
			if (snapshot.workflowId !== workflowId) continue;
			return {
				workflowId,
				worktree: snapshot.metadata.worktree,
				definitionId: snapshot.definition.id,
				status: snapshot.status,
			};
		} catch {
			// Not this target's workflow.
		}
	}
	return undefined;
}

function json(value: unknown, status = 200): Response {
	return new Response(JSON.stringify(value), {
		status,
		headers: {
			"content-type": "application/json; charset=utf-8",
			"cache-control": "no-store",
		},
	});
}

function errorResponse(
	status: number,
	code: string,
	message: string,
): Response {
	return json({ error: { code, message } }, status);
}

function message(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

/** The workflow one owner acts as. The owner was verified against the
 * capability before this module ran; a `user` owner has no workflow, so it has
 * no evidence store to write to. */
function ownerWorkflowId(owner: string): string {
	const prefix = "workflow:";
	if (!owner.startsWith(prefix) || owner.slice(prefix.length).trim() === "")
		throw new EvidenceError(
			"evidence-path",
			`evidence belongs to a workflow; ${JSON.stringify(owner)} is not a workflow owner`,
			403,
		);
	return owner.slice(prefix.length);
}

function locate(
	deps: EvidenceRouteDeps,
	workflowId: string,
): LocatedEvidenceWorkflow {
	const location = (deps.locate ?? locateEvidenceWorkflow)(workflowId);
	if (!location)
		throw new EvidenceError(
			"evidence-missing",
			`no workflow ${JSON.stringify(workflowId)} is recorded in any workflow store`,
			404,
		);
	return { ...location, workflowId };
}

/** One workflow's evidence scope, or a refusal when the workflow is nowhere
 * recorded or its id is not a usable directory component. */
function scopeFor(
	deps: EvidenceRouteDeps,
	workflowId: string,
): WorkflowEvidenceScope {
	return workflowEvidenceScope(locate(deps, workflowId));
}

/**
 * The owner-scoped evidence routes. Answers `undefined` for a path this module
 * does not own, so `app.ts` can hand the rest of the capability prefix to the
 * environment routes.
 */
export async function handleEvidenceRoute(
	deps: EvidenceRouteDeps,
	request: Request,
	url: URL,
	owner: string,
): Promise<Response | undefined> {
	const method = request.method.toUpperCase();
	const path = url.pathname;
	if (path !== EVIDENCE_AGENT_LIST_PATH && path !== EVIDENCE_AGENT_ATTACH_PATH)
		return undefined;
	try {
		const workflowId = ownerWorkflowId(owner);
		const scope = scopeFor(deps, workflowId);
		if (method === "GET" && path === EVIDENCE_AGENT_LIST_PATH) {
			const requestId = url.searchParams.get("requestId") ?? undefined;
			// Validate the request id before the manifest filter ever sees it.
			if (requestId !== undefined) evidenceRequestDirectory(requestId);
			return json({
				ok: true,
				value: listEvidence(
					scope,
					requestId === undefined ? {} : { requestId },
				),
			});
		}
		if (method === "POST" && path === EVIDENCE_AGENT_ATTACH_PATH) {
			const body = decodeRouteRequest<EvidenceAttachRequest>(
				EVIDENCE_AGENT_ATTACH_PATH,
				await readJsonBody(request),
			);
			const input: StoreAttachRequest = {
				path: body.path,
				kind: body.kind,
				caption: body.caption,
				...(body.requestId === undefined ? {} : { requestId: body.requestId }),
				...(body.step === undefined ? {} : { step: body.step }),
				...(body.role === undefined ? {} : { role: body.role }),
				...(body.app === undefined ? {} : { app: body.app }),
				...(body.url === undefined ? {} : { url: body.url }),
				...(body.poster === undefined ? {} : { poster: body.poster }),
				...(body.pinned === undefined ? {} : { pinned: body.pinned }),
				...(body.report === undefined ? {} : { report: body.report }),
				...(deps.now === undefined ? {} : { now: deps.now }),
			};
			const entry = await attachEvidence(scope, {
				...input,
				// The workflow was located before the body was read; re-checking it under
				// the root lock is what makes a delete that landed meanwhile win — and a
				// workflow whose workspace cleanup already removed the evidence directory
				// refuses too, so an attach cannot resurrect what the cleanup removed.
				verify: () => {
					const current = locate(deps, workflowId);
					if (current.status === "closed")
						throw new EvidenceError(
							"evidence-missing",
							`workflow ${JSON.stringify(workflowId)} is closed; its evidence was removed with its workspace and is not recreated`,
							409,
						);
				},
			});
			return json({ ok: true, value: entry }, 201);
		}
		return errorResponse(
			405,
			"method-not-allowed",
			`${method} is not available on ${path}`,
		);
	} catch (error) {
		if (error instanceof EvidenceError)
			return errorResponse(error.status, error.code, message(error));
		return errorResponse(400, "bad-request", message(error));
	}
}

/** The dashboard's file read, under the instance capability. */
export async function handleEvidenceFileRoute(
	deps: EvidenceRouteDeps,
	request: Request,
	url: URL,
): Promise<Response> {
	const path = url.pathname;
	if (
		request.method.toUpperCase() !== "GET" ||
		!path.startsWith(EVIDENCE_FILE_PREFIX)
	)
		return errorResponse(404, "not-found", `unknown route ${path}`);
	const parts = path.slice(EVIDENCE_FILE_PREFIX.length).split("/");
	if (parts.length !== 2 || parts.some((part) => part === ""))
		return errorResponse(
			404,
			"not-found",
			"evidence is addressed as /api/v1/evidence/{workflowId}/{id}",
		);
	const [workflowId, id] = parts as [string, string];
	try {
		const scope = scopeFor(deps, workflowId);
		const entry = evidenceEntry(scope, id);
		if (!entry)
			return errorResponse(
				404,
				"evidence-missing",
				`${JSON.stringify(workflowId)} has no evidence ${JSON.stringify(id)}`,
			);
		const opened = openEvidenceFile(scope, entry);
		if (!opened)
			return errorResponse(
				404,
				"evidence-missing",
				`evidence ${JSON.stringify(id)} is no longer on disk`,
			);
		// The descriptor that was verified is the one served: nothing re-opens the
		// name, so a file that disappears (or is swapped for a symlink) after the
		// check can neither be followed nor answered with an empty body.
		return new Response(evidenceStream(opened), {
			headers: {
				"content-type": evidenceContentType(entry.file),
				"cache-control": "no-store",
			},
		});
	} catch (error) {
		if (error instanceof EvidenceError)
			return errorResponse(error.status, error.code, message(error));
		return errorResponse(400, "bad-request", message(error));
	}
}

/** The recorded bytes of one manifest entry, or `undefined` when the workflow,
 * the entry or its file is gone. This is the in-process dashboard read: the
 * file route below serves the same bytes over the instance capability, and the
 * in-process dashboard adapter calls this directly because this process owns
 * both the store and the view. */
export async function readEvidenceBytes(
	workflowId: string,
	id: string,
	deps: EvidenceRouteDeps = {},
): Promise<Uint8Array | undefined> {
	let scope: WorkflowEvidenceScope;
	try {
		scope = scopeFor(deps, workflowId);
	} catch {
		return undefined;
	}
	const entry = evidenceEntry(scope, id);
	if (!entry) return undefined;
	const opened = openEvidenceFile(scope, entry);
	if (!opened) return undefined;
	try {
		// Read through the verified descriptor: the bytes are the object that was
		// checked, and a file removed after the check still reads instead of
		// rejecting — "the file is gone" is an answer this port defines, not a
		// failure.
		return new Uint8Array(fs.readFileSync(opened.fd));
	} catch {
		return undefined;
	} finally {
		fs.closeSync(opened.fd);
	}
}

/** One window of an evidence stream. A poster is a screenshot, and a trace or a
 * video is bounded by the store's own caps, so a small buffer keeps the whole
 * file out of memory while still streaming it to the reader. */
const EVIDENCE_STREAM_CHUNK_BYTES = 1024 * 1024;

/**
 * Stream one opened evidence file from its verified descriptor, closing that
 * descriptor when the stream ends, fails, or the reader goes away. Nothing here
 * re-opens the path by name.
 */
function evidenceStream(
	opened: OpenedEvidenceFile,
): ReadableStream<Uint8Array> {
	let position = 0;
	let closed = false;
	const close = () => {
		if (closed) return;
		closed = true;
		fs.closeSync(opened.fd);
	};
	return new ReadableStream<Uint8Array>({
		pull(controller) {
			if (position >= opened.size) {
				close();
				controller.close();
				return;
			}
			const length = Math.min(
				EVIDENCE_STREAM_CHUNK_BYTES,
				opened.size - position,
			);
			const buffer = Buffer.allocUnsafe(length);
			try {
				const read = fs.readSync(opened.fd, buffer, 0, length, position);
				if (read <= 0) {
					close();
					controller.close();
					return;
				}
				position += read;
				controller.enqueue(new Uint8Array(buffer.subarray(0, read)));
			} catch (error) {
				close();
				controller.error(error);
			}
		},
		cancel() {
			close();
		},
	});
}

/** The content type one stored evidence file is served as. */
export function evidenceContentType(file: string): string {
	const extension = file.slice(file.lastIndexOf(".") + 1).toLowerCase();
	switch (extension) {
		case "png":
			return "image/png";
		case "jpg":
		case "jpeg":
			return "image/jpeg";
		case "webp":
			return "image/webp";
		case "webm":
			return "video/webm";
		case "mp4":
			return "video/mp4";
		case "zip":
			return "application/zip";
		case "json":
			return "application/json; charset=utf-8";
		default:
			return "text/plain; charset=utf-8";
	}
}
