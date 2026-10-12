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
import type { EvidenceAttachRequest } from "../../contracts/environment.ts";
import type { WorkflowSnapshot } from "../../contracts/workflow.ts";
import { engine as workflowEngine } from "../../workflow/operations.ts";
import {
	type WorkflowEvidenceLocation,
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
} from "../protocol.ts";
import {
	attachEvidence,
	EvidenceError,
	evidenceEntry,
	evidenceFilePath,
	evidenceRequestDirectory,
	listEvidence,
	type EvidenceAttachRequest as StoreAttachRequest,
} from "./store.ts";

/** The owner-scoped evidence surface, under the run capability prefix. The
 * declared paths come from the transport manifest, so this module and
 * `ROUTE_REQUESTS` can never drift apart. */
export const EVIDENCE_AGENT_ATTACH_PATH = AGENT_EVIDENCE_ATTACH_PATH;
export const EVIDENCE_AGENT_LIST_PATH = AGENT_EVIDENCE_LIST_PATH;
/** The instance-authenticated file route. */
export const EVIDENCE_FILE_PREFIX = "/api/v1/evidence/";

/** Everything the evidence routes read. `locate` resolves a workflow id to the
 * workflow's own checkout/definition — the engine's state, never a request
 * path — and is injectable so a route test needs no store on disk. */
export interface EvidenceRouteDeps {
	readonly locate?: (
		workflowId: string,
	) => WorkflowEvidenceLocation | undefined;
	readonly now?: () => Date;
}

/** Locate one workflow by id across every recorded target, plus the shared
 * wiki/research stores. A workflow that is nowhere recorded has no evidence. */
export function locateEvidenceWorkflow(
	workflowId: string,
): WorkflowEvidenceLocation | undefined {
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
				"workflowId" | "metadata" | "definition"
			> = engine.getSnapshot(target, workflowId);
			if (snapshot.workflowId !== workflowId) continue;
			return {
				workflowId,
				worktree: snapshot.metadata.worktree,
				definitionId: snapshot.definition.id,
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
): WorkflowEvidenceLocation {
	const location = (deps.locate ?? locateEvidenceWorkflow)(workflowId);
	if (!location)
		throw new EvidenceError(
			"evidence-missing",
			`no workflow ${JSON.stringify(workflowId)} is recorded in any workflow store`,
			404,
		);
	return { ...location, workflowId };
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
		const scope = workflowEvidenceScope(locate(deps, workflowId));
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
				...(deps.now === undefined ? {} : { now: deps.now }),
			};
			const entry = await attachEvidence(scope, input);
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
		const scope = workflowEvidenceScope(locate(deps, workflowId));
		const entry = evidenceEntry(scope, id);
		if (!entry)
			return errorResponse(
				404,
				"evidence-missing",
				`${JSON.stringify(workflowId)} has no evidence ${JSON.stringify(id)}`,
			);
		const file = evidenceFilePath(scope, entry);
		if (!file)
			return errorResponse(
				404,
				"evidence-missing",
				`evidence ${JSON.stringify(id)} is no longer on disk`,
			);
		return new Response(Bun.file(file), {
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
