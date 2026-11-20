import { randomBytes } from "node:crypto";
import * as z from "zod/v4";
import { equalSecret } from "../../server/auth.ts";
import { boundedRequestBody } from "./http-body.ts";
import type { ControllerOperations } from "./operations.ts";
import type { operatorControls } from "./operator-controls.ts";
import { ControllerRefusal } from "./state.ts";

const decisionSchema = z.strictObject({
	requestId: z.string().trim().min(1).max(256),
	revision: z.number().int().min(1),
	digest: z.string().regex(/^[a-f0-9]{64}$/),
	decision: z.enum(["approved", "rejected"]),
});
const headers = {
	"Cache-Control": "no-store",
	"Content-Security-Policy":
		"default-src 'none'; frame-ancestors 'none'; base-uri 'none'",
	"X-Content-Type-Options": "nosniff",
	"Referrer-Policy": "no-referrer",
};
const json = (value: unknown, status = 200) =>
	Response.json(value, { status, headers });

async function decisionBody(request: Request) {
	if (
		request.headers.get("content-type")?.split(";")[0]?.trim() !==
			"application/json" ||
		Number(request.headers.get("content-length") ?? 0) > 4096
	)
		throw new Error("Invalid decision body");
	return decisionSchema.parse(
		JSON.parse(await boundedRequestBody(request, 4096)),
	);
}

/** Human/operator capability only. This listener does not expose MCP or execute approved work. */
export function serveEnvironmentOperator(
	operations: ControllerOperations,
	options: {
		port?: number;
		operatorId?: string;
		controls?: ReturnType<typeof operatorControls>;
	} = {},
) {
	if (
		!Number.isInteger(options.port ?? 0) ||
		(options.port ?? 0) < 0 ||
		(options.port ?? 0) > 65535
	)
		throw new Error("Invalid operator port");
	const operator = operations.operator({
		id: options.operatorId ?? "local-operator",
		role: "operator",
	});
	const token = randomBytes(32).toString("hex");
	const pending = new Set<Promise<Response>>();
	let closing = false;
	let stopping: Promise<void> | null = null;
	const route = async (request: Request): Promise<Response> => {
		const url = new URL(request.url);
		const authority = `127.0.0.1:${server.port}`;
		const expected = new URL(`http://${authority}`);
		const host = request.headers.get("host");
		if (
			url.origin !== expected.origin ||
			(host !== expected.host && host !== authority)
		)
			return json({ error: "Invalid operator host" }, 403);
		const origin = request.headers.get("origin");
		if (origin && origin !== expected.origin)
			return json({ error: "Cross-origin request refused" }, 403);
		if (
			!equalSecret(
				request.headers.get("authorization")?.replace(/^Bearer /, "") ?? "",
				token,
			)
		)
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
					await operator.list(
						Number(url.searchParams.get("offset") ?? 0),
						Number(url.searchParams.get("limit") ?? 20),
					),
				);
			}
			if (url.searchParams.size)
				return json({ error: "Unexpected operator query" }, 400);
			if (options.controls && url.pathname.startsWith("/operator/controls/")) {
				let body: unknown;
				if (request.method === "POST") {
					try {
						if (
							request.headers.get("content-type")?.split(";")[0]?.trim() !==
							"application/json"
						)
							throw new Error("JSON required");
						body = JSON.parse(await boundedRequestBody(request, 512 * 1024));
					} catch {
						return json({ error: "Invalid operator body" }, 400);
					}
				}
				const result = await options.controls(
					url.pathname.slice("/operator/controls/".length),
					request.method,
					body,
				);
				return result === undefined
					? json({ error: "Operator route not found" }, 404)
					: json(result);
			}
			const match =
				/^\/operator\/operations\/([a-f0-9-]{36})(\/decision)?$/.exec(
					url.pathname,
				);
			const id = match?.[1];
			if (!id) return json({ error: "Operator route not found" }, 404);
			if (!match[2] && request.method === "GET")
				return json(await operator.inspect(id));
			if (match[2] && request.method === "POST") {
				let decision: z.output<typeof decisionSchema>;
				try {
					decision = await decisionBody(request);
				} catch {
					return json({ error: "Invalid operator decision" }, 400);
				}
				return json(await operator.decide(id, decision));
			}
			return json({ error: "Operator method not allowed" }, 405);
		} catch (error) {
			return json(
				{
					error:
						error instanceof ControllerRefusal
							? error.code
							: "Operator request failed",
				},
				error instanceof ControllerRefusal ? 409 : 500,
			);
		}
	};
	const server = Bun.serve({
		hostname: "127.0.0.1",
		port: options.port ?? 0,
		development: false,
		maxRequestBodySize: 512 * 1024,
		idleTimeout: 5,
		async fetch(request) {
			if (closing || pending.size >= 8)
				return json({ error: "Operator interface unavailable" }, 503);
			const operation = route(request);
			pending.add(operation);
			try {
				return await operation;
			} finally {
				pending.delete(operation);
			}
		},
		error: () => json({ error: "Operator request failed" }, 500),
	});
	return {
		url: `http://127.0.0.1:${server.port}`,
		token,
		stop: () => {
			closing = true;
			stopping ??= (async () => {
				await server.stop(true);
				await Promise.allSettled([...pending]);
			})();
			return stopping;
		},
	};
}
