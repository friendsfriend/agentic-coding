import path from "node:path";
import { object, text } from "../../config.ts";
import type { LogOptions } from "../../environment/logs.ts";
import type { TelemetryOptions } from "../../environment/model.ts";
import type { OperatorAction } from "../../environment/operator.ts";
import { renderMarkdown } from "../../markdown.ts";
import { providerRoute } from "../../providers/routes.ts";
import type { Runtime } from "../../runtime.ts";
import type { Review } from "../../state.ts";

function integer(value: unknown): number {
	if (!Number.isSafeInteger(value)) throw new Error("Expected an integer");
	return Number(value);
}
function environmentLogQuery(query: URLSearchParams): {
	app: string;
	options: LogOptions;
} {
	const allowed = new Set(["app", "since", "grep", "tail", "service", "kind"]);
	for (const key of query.keys())
		if (!allowed.has(key) || query.getAll(key).length !== 1)
			throw new Error("Unknown or repeated environment log query parameter");
	const kind = query.get("kind") ?? undefined;
	if (kind !== undefined && kind !== "infrastructure")
		throw new Error(
			"Environment log kind must be infrastructure when supplied",
		);
	return {
		app: text(query.get("app"), "environment app", 64),
		options: {
			since: query.get("since") ?? undefined,
			grep: query.get("grep") ?? undefined,
			service: query.get("service") ?? undefined,
			tail: query.has("tail") ? Number(query.get("tail")) : undefined,
			kind,
		},
	};
}
function environmentTelemetryQuery(query: URLSearchParams): {
	app: string;
	run: string;
	options: TelemetryOptions;
} {
	const allowed = new Set([
		"app",
		"run",
		"mode",
		"view",
		"cursor",
		"traceId",
		"spanId",
		"http",
		"service",
		"rootKind",
		"limit",
		"since",
		"status",
		"name",
		"severity",
		"text",
	]);
	for (const key of query.keys())
		if (!allowed.has(key) || query.getAll(key).length !== 1)
			throw new Error(
				"Unknown or repeated environment telemetry query parameter",
			);
	const mode = query.get("mode") ?? undefined;
	const view = query.get("view") ?? undefined;
	if (view !== undefined && view !== "flat" && view !== "tree")
		throw new Error("Telemetry view must be flat or tree");
	const status = query.get("status") ?? undefined;
	if (mode !== undefined && mode !== "traces" && mode !== "logs")
		throw new Error("Telemetry mode must be traces or logs");
	if (
		status !== undefined &&
		status !== "all" &&
		status !== "error" &&
		status !== "success"
	)
		throw new Error("Telemetry status must be all, error or success");
	return {
		app: text(query.get("app"), "environment app", 64),
		run: text(query.get("run"), "environment run", 512),
		options: {
			mode,
			view,
			cursor: query.get("cursor") ?? undefined,
			status,
			traceId: query.get("traceId") ?? undefined,
			spanId: query.get("spanId") ?? undefined,
			http: query.get("http") ?? undefined,
			service: query.get("service") ?? undefined,
			rootKind: query.get("rootKind") ?? undefined,
			limit: query.has("limit") ? Number(query.get("limit")) : undefined,
			since: query.get("since") ?? undefined,
			name: query.get("name") ?? undefined,
			severity: query.get("severity") ?? undefined,
			text: query.get("text") ?? undefined,
		},
	};
}

export function httpRoutes(
	app: Runtime,
	json: (value: unknown, status?: number) => Response,
	security: Record<string, string>,
) {
	return async (request: Request, url: URL) => {
		try {
			if (request.method === "GET" && url.pathname === "/api/state") {
				const state = await app.snapshot();
				return json({
					...state,
					messages: state.messages.map((message) => ({
						...message,
						html: renderMarkdown(message.content),
					})),
				});
			}
			if (
				request.method === "GET" &&
				/^\/attachments\/[a-f0-9]{64}$/.test(url.pathname)
			) {
				const attachment = await app.attachment(
					url.pathname.slice("/attachments/".length),
				);
				if (!attachment) return json({ error: "Attachment not found" }, 404);
				return new Response(
					Bun.file(
						path.join(app.config.stateDir, "attachments", attachment.filename),
					),
					{
						headers: {
							...security,
							"Content-Type": attachment.mediaType,
							"Content-Disposition": "inline",
						},
					},
				);
			}
			if (
				request.method === "GET" &&
				url.pathname === "/api/environments/discovery"
			) {
				if (
					url.searchParams.getAll("repository").length !== 1 ||
					url.searchParams.getAll("directory").length > 1 ||
					[...url.searchParams.keys()].some(
						(key) => !["repository", "directory"].includes(key),
					)
				)
					throw new Error(
						"Discovery requires exactly one repository query parameter",
					);
				return json(
					app.environments.discover(
						text(
							url.searchParams.get("repository"),
							"discovery repository",
							4096,
						),
						undefined,
						url.searchParams.get("directory") ?? ".",
					),
				);
			}
			if (
				request.method === "GET" &&
				url.pathname === "/api/environments/drafts/trees"
			) {
				if (url.searchParams.size)
					throw new Error(
						"Retained tree metadata does not accept query parameters",
					);
				return json(await app.environments.drafts.trees());
			}
			if (
				request.method === "GET" &&
				url.pathname === "/api/environments/drafts/preflights"
			) {
				if (url.searchParams.size)
					throw new Error("Preflight history does not accept query parameters");
				return json(await app.environments.drafts.preflights());
			}
			if (
				request.method === "GET" &&
				url.pathname === "/api/environments/drafts/preflight"
			) {
				if (
					[...url.searchParams.keys()].some((key) => key !== "id") ||
					url.searchParams.getAll("id").length !== 1
				)
					throw new Error("Preflight read requires exactly one report ID");
				return json(
					await app.environments.drafts.report(
						text(url.searchParams.get("id"), "preflight ID", 80),
					),
				);
			}
			if (
				request.method === "GET" &&
				url.pathname === "/api/environments/drafts/promotion-attempts"
			) {
				if (url.searchParams.size)
					throw new Error("Attempt history does not accept query parameters");
				return json(await app.environments.drafts.attempts());
			}
			if (
				request.method === "GET" &&
				url.pathname === "/api/environments/drafts/promotions"
			) {
				if (url.searchParams.size)
					throw new Error("Promotion history does not accept query parameters");
				return json(await app.environments.drafts.promotions());
			}
			if (
				request.method === "GET" &&
				url.pathname === "/api/environments/drafts/promotion"
			) {
				if (
					[...url.searchParams.keys()].some((key) => key !== "id") ||
					url.searchParams.getAll("id").length !== 1
				)
					throw new Error("Promotion read requires exactly one record ID");
				return json(
					await app.environments.drafts.promotion(
						text(url.searchParams.get("id"), "promotion ID", 80),
					),
				);
			}
			if (
				request.method === "GET" &&
				url.pathname === "/api/environments/drafts"
			) {
				if (
					[...url.searchParams.keys()].some((key) => key !== "id") ||
					url.searchParams.getAll("id").length > 1
				)
					throw new Error("Unknown or repeated draft query parameter");
				return json(
					url.searchParams.has("id")
						? await app.environments.drafts.read(
								text(url.searchParams.get("id"), "draft ID", 80),
							)
						: await app.environments.drafts.list(),
				);
			}
			if (
				request.method === "GET" &&
				url.pathname === "/api/environments/logs"
			) {
				const { app: project, options } = environmentLogQuery(url.searchParams);
				return json(
					(await app.environments.selectedLogs(project, undefined, options))
						.runs,
				);
			}
			if (
				request.method === "GET" &&
				[
					"/api/environments/database-history",
					"/api/environments/http-history",
				].includes(url.pathname)
			) {
				if (
					[...url.searchParams.keys()].some(
						(key) =>
							!["run", "operation", "cursor"].includes(key) ||
							url.searchParams.getAll(key).length !== 1,
					)
				)
					throw new Error(
						"Unknown or repeated diagnostic history query parameter",
					);
				const run = text(url.searchParams.get("run"), "diagnostic run", 128),
					operation = url.searchParams.has("operation")
						? text(url.searchParams.get("operation"), "diagnostic ID", 128)
						: undefined,
					cursor = url.searchParams.has("cursor")
						? text(url.searchParams.get("cursor"), "diagnostic cursor", 64)
						: undefined;
				const diagnostics = url.pathname.endsWith("/http-history")
					? app.environments.http
					: app.environments.database;
				return json(await diagnostics.history(run, { operation, cursor }));
			}
			if (
				request.method === "GET" &&
				url.pathname === "/api/environments/telemetry"
			) {
				const {
					app: project,
					run,
					options,
				} = environmentTelemetryQuery(url.searchParams);
				return json(
					await app.environments.queryTelemetry(
						project,
						undefined,
						options,
						run,
					),
				);
			}
			if (
				request.method === "GET" &&
				url.pathname.startsWith("/api/providers")
			) {
				const routed = await providerRoute(
					app.environments.providers,
					request.method,
					url,
					undefined,
				);
				if (routed) return json(routed.value, routed.status);
			}
			if (request.method !== "POST") return json({ error: "Not found" }, 404);
			const body = object(await request.json());
			if (url.pathname === "/api/session") return json({ ok: true });
			if (url.pathname === "/api/chat")
				return json({
					submissionId: await app.chat(
						text(body.content, "message", 64000),
						text(body.requestId, "request ID", 256),
					),
				});
			if (url.pathname === "/api/environments/drafts/source/base") {
				if (url.searchParams.size)
					throw new Error(
						"Source base establishment does not accept query parameters",
					);
				return json(await app.environments.drafts.captureBase(body));
			}
			if (url.pathname === "/api/environments/drafts/source") {
				if (url.searchParams.size)
					throw new Error("Source staging does not accept query parameters");
				return json(await app.environments.drafts.saveSource(body));
			}
			if (url.pathname === "/api/environments/drafts/source/remove") {
				if (url.searchParams.size)
					throw new Error("Source removal does not accept query parameters");
				return json(await app.environments.drafts.removeSource(body));
			}
			if (
				url.pathname === "/api/environments/drafts/tree-cleanup/acknowledge"
			) {
				if (url.searchParams.size)
					throw new Error(
						"Cleanup acknowledgement does not accept query parameters",
					);
				return json(await app.environments.drafts.acknowledgeTreeCleanup(body));
			}
			if (url.pathname === "/api/environments/drafts/tree/temporary-release") {
				if (url.searchParams.size)
					throw new Error(
						"Temporary tree release does not accept query parameters",
					);
				return json(await app.environments.drafts.releaseTemporaryTree(body));
			}
			if (url.pathname === "/api/environments/drafts/tree/release") {
				if (url.searchParams.size)
					throw new Error(
						"Retained tree release does not accept query parameters",
					);
				return json(await app.environments.drafts.releaseTree(body));
			}
			if (url.pathname === "/api/environments/drafts/remove") {
				if (url.searchParams.size)
					throw new Error("Draft removal does not accept query parameters");
				return json(await app.environments.drafts.removeDraft(body));
			}
			if (
				url.pathname ===
				"/api/environments/drafts/promotion-attempts/acknowledge"
			) {
				if (url.searchParams.size)
					throw new Error(
						"Attempt acknowledgement does not accept query parameters",
					);
				return json(await app.environments.drafts.acknowledgeAttempt(body));
			}
			if (url.pathname === "/api/environments/drafts/promote") {
				if (url.searchParams.size)
					throw new Error("Promotion does not accept query parameters");
				return json(await app.environments.drafts.promote(body));
			}
			if (url.pathname === "/api/environments/drafts/preflight") {
				if (url.searchParams.size)
					throw new Error("Preflight writes do not accept query parameters");
				return json(await app.environments.drafts.preflight(body));
			}
			if (url.pathname === "/api/environments/drafts")
				return json(await app.environments.drafts.save(body));
			if (url.pathname === "/api/environments/revoke")
				return json(await app.environments.operator.revoke(body));
			if (
				request.method === "POST" &&
				url.pathname.startsWith("/api/providers")
			) {
				const routed = await providerRoute(
					app.environments.providers,
					request.method,
					url,
					body,
				);
				if (routed) return json(routed.value, routed.status);
			}
			if (url.pathname === "/api/environments/actions")
				return json({
					taskId: await app.startEnvironmentAction(body as OperatorAction),
				});
			if (url.pathname === "/api/environments/release") {
				if (body.inspectionConfirmed !== true)
					throw new Error(
						"Confirm inspection and cleanup before releasing an interrupted environment",
					);
				const id = text(body.id, "environment run", 128);
				if (!/^env-\d+:[a-z][a-z0-9-]*$/.test(id))
					throw new Error("Invalid environment run ID");
				await app.environments.acknowledge(id, integer(body.revision));
				return json({ ok: true });
			}
			const review = url.pathname.match(/^\/api\/reviews\/(review-\d+)$/);
			if (review) {
				const decision = text(body.decision, "decision") as Review["state"];
				await app.decide(
					review[1],
					integer(body.revision),
					decision,
					typeof body.comments === "string" ? body.comments : "",
				);
				return json({ ok: true });
			}
			const cancel = url.pathname.match(/^\/api\/tasks\/(\d+)\/cancel$/);
			if (cancel) return json({ ok: await app.cancel(Number(cancel[1])) });
			return json({ error: "Not found" }, 404);
		} catch (error) {
			return json(
				{ error: error instanceof Error ? error.message : String(error) },
				400,
			);
		}
	};
}
