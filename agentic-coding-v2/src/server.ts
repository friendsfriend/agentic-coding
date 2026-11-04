import { randomBytes, timingSafeEqual } from "node:crypto";
import path from "node:path";
import { object, text } from "./config.ts";
import type { LogOptions } from "./environment/logs.ts";
import type { TelemetryOptions } from "./environment/model.ts";
import type { OperatorAction } from "./environment/operator.ts";
import { renderMarkdown } from "./markdown.ts";
import type { Runtime } from "./runtime.ts";
import type { Review } from "./state.ts";
import script from "./web/app.js" with { type: "text" };
import authenticatedMessage from "./web/authenticated-message.js" with {
	type: "text",
};
import discovery from "./web/definition-discovery.js" with { type: "text" };
import drafts from "./web/definition-drafts.js" with { type: "text" };
import dom from "./web/dom.js" with { type: "text" };
import diagnostics from "./web/environment-diagnostics.js" with {
	type: "text",
};
import lifecycle from "./web/environment-lifecycle.js" with { type: "text" };
import html from "./web/index.html" with { type: "text" };
import css from "./web/style.css" with { type: "text" };

function equalSecret(actual: string, expected: string): boolean {
	const left = Buffer.from(actual);
	const right = Buffer.from(expected);
	return left.length === right.length && timingSafeEqual(left, right);
}
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
		"traceId",
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
			status,
			traceId: query.get("traceId") ?? undefined,
			limit: query.has("limit") ? Number(query.get("limit")) : undefined,
			since: query.get("since") ?? undefined,
			name: query.get("name") ?? undefined,
			severity: query.get("severity") ?? undefined,
			text: query.get("text") ?? undefined,
		},
	};
}
export function serve(app: Runtime, port = 0) {
	const token = randomBytes(32).toString("hex");
	const security = {
		"Content-Security-Policy":
			"default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' blob:; connect-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'",
		"X-Content-Type-Options": "nosniff",
		"Referrer-Policy": "no-referrer",
		"Cache-Control": "no-store",
	};
	const json = (value: unknown, status = 200) =>
		Response.json(value, { status, headers: security });
	const assets = new Map([
		["/", { content: String(html), type: "text/html" }],
		["/app.js", { content: script, type: "text/javascript" }],
		[
			"/authenticated-message.js",
			{ content: authenticatedMessage, type: "text/javascript" },
		],
		["/dom.js", { content: dom, type: "text/javascript" }],
		["/definition-drafts.js", { content: drafts, type: "text/javascript" }],
		[
			"/definition-discovery.js",
			{ content: discovery, type: "text/javascript" },
		],
		[
			"/environment-lifecycle.js",
			{ content: lifecycle, type: "text/javascript" },
		],
		[
			"/environment-diagnostics.js",
			{ content: diagnostics, type: "text/javascript" },
		],
		["/style.css", { content: css, type: "text/css" }],
	]);
	const server = Bun.serve({
		hostname: "127.0.0.1",
		port,
		maxRequestBodySize: 1_000_000,
		async fetch(request) {
			const url = new URL(request.url);
			// The Host check also prevents DNS rebinding to the loopback server.
			if (url.hostname !== "127.0.0.1" || url.port !== String(server.port))
				return json({ error: "Invalid host" }, 403);
			if (request.method === "GET" && url.pathname === "/favicon.ico")
				return new Response(null, { status: 204, headers: security });
			const asset =
				request.method === "GET" ? assets.get(url.pathname) : undefined;
			if (asset)
				return new Response(asset.content, {
					headers: {
						...security,
						"Content-Type": `${asset.type}; charset=utf-8`,
					},
				});
			const bearer =
				request.headers.get("authorization")?.replace(/^Bearer /, "") ?? "";
			// Cookies are host-scoped, not port-scoped. Never accept or issue a dashboard
			// credential that another loopback service could receive.
			if (!equalSecret(bearer, token))
				return json(
					{ error: "Open the private host URL printed in your terminal" },
					401,
				);
			const origin = request.headers.get("origin");
			if (origin && origin !== url.origin)
				return json({ error: "Cross-origin request refused" }, 403);
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
							path.join(
								app.config.stateDir,
								"attachments",
								attachment.filename,
							),
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
						[...url.searchParams.keys()].some((key) => key !== "repository")
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
						),
					);
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
					const { app: project, options } = environmentLogQuery(
						url.searchParams,
					);
					return json(
						(await app.environments.selectedLogs(project, undefined, options))
							.runs,
					);
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
				if (url.pathname === "/api/environments/drafts/remove") {
					if (url.searchParams.size)
						throw new Error("Draft removal does not accept query parameters");
					return json(await app.environments.drafts.removeDraft(body));
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
		},
	});
	return {
		url: `http://127.0.0.1:${server.port}/#token=${token}`,
		stop: () => server.stop(true),
	};
}
