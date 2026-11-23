import { randomBytes } from "node:crypto";
import {
	OperationRefusal,
	type OperatorAcknowledgement,
	type OperatorDecision,
	operatorAcknowledgementSchema,
	operatorDecisionSchema,
} from "../domain/operation.ts";
import type { openDiagnosticsLog } from "../persistence/diagnostics-log.ts";
import type { OperationJournal } from "../services/operation-journal.ts";
import { matchesBearerCredential } from "../transports/http/authentication.ts";
import { readBoundedBody } from "../transports/http/read-body.ts";

const headers = {
	"Cache-Control": "no-store",
	"Content-Security-Policy":
		"default-src 'none'; frame-ancestors 'none'; base-uri 'none'",
	"X-Content-Type-Options": "nosniff",
	"Referrer-Policy": "no-referrer",
};
const json = (value: unknown, status = 200) =>
	Response.json(value, { status, headers });

/** Separate human capability, never registered as MCP or given to agent sessions.
 * It can inspect/decide only; no issuance, execution or resource control. */
export function serveOperatorApi(
	operator: ReturnType<OperationJournal["operator"]>,
	options: {
		port?: number;
		diagnostics?: ReturnType<typeof openDiagnosticsLog>;
	} = {},
) {
	if (
		!Number.isInteger(options.port ?? 0) ||
		(options.port ?? 0) < 0 ||
		(options.port ?? 0) > 65535
	)
		throw new Error("Invalid operator port");
	const token = randomBytes(32).toString("hex");
	const pending = new Set<Promise<Response>>();
	let closing = false,
		stopping: Promise<void> | undefined;
	const route = async (request: Request): Promise<Response> => {
		const url = new URL(request.url),
			origin = `http://127.0.0.1:${server.port}`;
		if (
			url.origin !== origin ||
			request.headers.get("host") !== `127.0.0.1:${server.port}` ||
			url.username ||
			url.password
		)
			return json({ error: "Invalid operator host" }, 403);
		if (
			request.headers.has("origin") &&
			request.headers.get("origin") !== origin
		)
			return json({ error: "Cross-origin request refused" }, 403);
		if (!matchesBearerCredential(request, token))
			return json({ error: "Operator authentication required" }, 401);
		try {
			if (request.method === "GET" && url.pathname === "/operator/operations") {
				if (
					[...url.searchParams.keys()].some(
						(key) =>
							!["offset", "limit"].includes(key) ||
							url.searchParams.getAll(key).length !== 1,
					) ||
					[...url.searchParams.values()].some((value) => !/^\d+$/.test(value))
				)
					return json({ error: "Invalid operator query" }, 400);
				return json(
					operator.list(
						Number(url.searchParams.get("offset") ?? 0),
						Number(url.searchParams.get("limit") ?? 20),
					),
				);
			}
			if (
				request.method === "GET" &&
				url.pathname === "/operator/diagnostics"
			) {
				if (!options.diagnostics)
					return json({ error: "Diagnostics unavailable" }, 404);
				if (
					[...url.searchParams.keys()].some((key) => key !== "tail") ||
					url.searchParams.getAll("tail").length > 1
				)
					return json({ error: "Invalid diagnostics query" }, 400);
				const raw = url.searchParams.get("tail") ?? "50";
				if (!/^\d+$/.test(raw))
					return json({ error: "Invalid diagnostics query" }, 400);
				const tail = Number(raw);
				if (tail < 1 || tail > 200)
					return json({ error: "Invalid diagnostics query" }, 400);
				return json({ events: options.diagnostics.tail(tail) });
			}
			if (url.searchParams.size)
				return json({ error: "Unexpected operator query" }, 400);
			const match =
					/^\/operator\/operations\/([a-f0-9-]{36})(\/decision|\/acknowledge)?$/.exec(
						url.pathname,
					),
				id = match?.[1];
			if (!id) return json({ error: "Operator route not found" }, 404);
			if (!match[2] && request.method === "GET")
				return json(operator.inspect(id));
			if (match[2] && request.method === "POST") {
				let body: unknown;
				try {
					if (
						request.headers.get("content-type")?.split(";")[0]?.trim() !==
						"application/json"
					)
						throw new Error("JSON required");
					body = JSON.parse(await readBoundedBody(request, 4096));
				} catch {
					return json({ error: "Invalid operator request" }, 400);
				}
				if (match[2] === "/decision") {
					let decision: OperatorDecision;
					try {
						decision = operatorDecisionSchema.parse(body);
					} catch {
						return json({ error: "Invalid operator decision" }, 400);
					}
					return json(operator.decide(id, decision));
				}
				let acknowledgement: OperatorAcknowledgement;
				try {
					acknowledgement = operatorAcknowledgementSchema.parse(body);
				} catch {
					return json({ error: "Invalid operator acknowledgement" }, 400);
				}
				return json(operator.acknowledge(id, acknowledgement));
			}
			return json({ error: "Operator method not allowed" }, 405);
		} catch (error) {
			return json(
				{
					error:
						error instanceof OperationRefusal
							? error.code
							: "Operator request failed",
				},
				error instanceof OperationRefusal ? 409 : 500,
			);
		}
	};
	const server = Bun.serve({
		hostname: "127.0.0.1",
		port: options.port ?? 0,
		development: false,
		maxRequestBodySize: 4096,
		idleTimeout: 5,
		async fetch(request) {
			if (closing || pending.size >= 8)
				return json({ error: "Operator interface unavailable" }, 503);
			const response = route(request);
			pending.add(response);
			try {
				return await response;
			} finally {
				pending.delete(response);
			}
		},
		error: () => json({ error: "Operator request failed" }, 500),
	});
	return {
		url: `http://127.0.0.1:${server.port}`,
		token,
		stop() {
			closing = true;
			stopping ??= (async () => {
				await server.stop(true);
				await Promise.allSettled([...pending]);
			})();
			return stopping;
		},
	};
}
