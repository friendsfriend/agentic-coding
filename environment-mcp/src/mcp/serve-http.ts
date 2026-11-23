import { createMcpHandler } from "@modelcontextprotocol/server";
import * as z from "zod/v4";
import { DependencyBindingRefusal } from "../domain/dependency-binding.ts";
import { OperationRefusal } from "../domain/operation.ts";
import { createCapabilities } from "../interface/capabilities.ts";
import { describeAction } from "../interface/descriptors.ts";
import type { createCatalogService } from "../services/catalog-service.ts";
import type { DependencyOperationSession } from "../services/dependency-operation-service.ts";
import type { ExecutionSession } from "../services/execution-service.ts";
import { matchesBearerCredential } from "../transports/http/authentication.ts";
import { readBoundedBody } from "../transports/http/read-body.ts";
import { createMcpServer } from "./create-server.ts";

const securityHeaders = {
	"Cache-Control": "no-store",
	"X-Content-Type-Options": "nosniff",
	"Referrer-Policy": "no-referrer",
	"Content-Security-Policy": "default-src 'none'; frame-ancestors 'none'",
};
const json = (value: unknown, status = 200) =>
	Response.json(value, { status, headers: securityHeaders });
const errorResponse = (error: string, status: number) =>
	json({ error }, status);
const capabilityPath = /^\/capabilities\/([a-z][a-z0-9_]{0,63})$/;

/** One listener over pre-bound sessions. Per-request SDK instances do not open
 * state, create scopes or select authority from client/model arguments. The same
 * registry serves MCP tools and the authenticated UI capability transport. */
export function serveMcpHttp(
	catalog: ReturnType<typeof createCatalogService>,
	clients: readonly {
		token: string;
		operations: DependencyOperationSession;
		execution?: ExecutionSession;
		touch?: () => void;
		onAction?: (action: string, code?: string) => void;
	}[],
	options: { port?: number } = {},
) {
	if (
		!clients.length ||
		clients.length > 32 ||
		new Set(clients.map((client) => client.token)).size !== clients.length ||
		clients.some((client) => !/^[A-Za-z0-9_-]{32,128}$/.test(client.token)) ||
		!Number.isInteger(options.port ?? 0) ||
		(options.port ?? 0) < 0 ||
		(options.port ?? 0) > 65535
	)
		throw new Error("Invalid MCP listener configuration");
	const entries = clients.map(
		({ token, operations, execution, touch, onAction }) => {
			const base = createCapabilities({
				catalog,
				operations,
				execution,
			});
			const capabilities =
				touch || onAction
					? {
							list: () => base.list(),
							async invoke(
								name: string,
								input: unknown,
								context: { signal: AbortSignal },
							) {
								touch?.();
								try {
									const result = await base.invoke(name, input, context);
									onAction?.(name);
									return result;
								} catch (error) {
									const code =
										error &&
										typeof error === "object" &&
										"code" in error &&
										typeof error.code === "string"
											? error.code
											: "error";
									onAction?.(name, code);
									throw error;
								}
							},
						}
					: base;
			return {
				token,
				capabilities,
				handler: createMcpHandler(() => createMcpServer(capabilities), {
					maxRequestBodySize: 65536,
					maxSubscriptions: 8,
				}),
			};
		},
	);
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
			return errorResponse("Invalid environment host", 403);
		if (
			request.headers.has("origin") &&
			request.headers.get("origin") !== origin
		)
			return errorResponse("Cross-origin request refused", 403);
		const client = entries.find(({ token }) =>
			matchesBearerCredential(request, token),
		);
		if (!client)
			return errorResponse("Environment authentication required", 401);
		if (url.pathname === "/capabilities") {
			if (request.method !== "GET")
				return errorResponse("Capability method not allowed", 405);
			if (url.searchParams.size)
				return errorResponse("Unexpected capability query", 400);
			return json({
				actions: client.capabilities.list().map(describeAction),
			});
		}
		const match = capabilityPath.exec(url.pathname);
		if (match?.[1]) {
			const name = match[1];
			if (request.method !== "POST")
				return errorResponse("Capability method not allowed", 405);
			if (url.searchParams.size)
				return errorResponse("Unexpected capability query", 400);
			if (
				!client.capabilities
					.list()
					.some((capability) => capability.name === name)
			)
				return errorResponse("Capability not found", 404);
			let input: unknown;
			try {
				if (
					request.headers.get("content-type")?.split(";")[0]?.trim() !==
					"application/json"
				)
					throw new Error("JSON required");
				input = JSON.parse(await readBoundedBody(request, 65536));
			} catch {
				return errorResponse("Invalid capability input", 400);
			}
			try {
				const result = await client.capabilities.invoke(name, input, {
					signal: request.signal,
				});
				return json({ result });
			} catch (error) {
				if (
					error instanceof OperationRefusal ||
					error instanceof DependencyBindingRefusal
				)
					return errorResponse(error.code, 409);
				if (error instanceof z.ZodError)
					return errorResponse("invalid-input", 400);
				return errorResponse("capability-request-failed", 500);
			}
		}
		if (url.pathname !== "/mcp" || url.searchParams.size)
			return errorResponse("Environment route not found", 404);
		try {
			const incoming =
				request.method === "POST"
					? new Request(request, {
							body: await readBoundedBody(request, 65536),
						})
					: request;
			const response = await client.handler.fetch(incoming),
				headers = new Headers(response.headers);
			for (const [key, value] of Object.entries(securityHeaders))
				headers.set(key, value);
			return new Response(response.body, { status: response.status, headers });
		} catch {
			return errorResponse(
				"MCP request refused; inspect durable receipts before retrying",
				400,
			);
		}
	};
	const server = Bun.serve({
		hostname: "127.0.0.1",
		port: options.port ?? 0,
		development: false,
		maxRequestBodySize: 65536,
		idleTimeout: 255,
		async fetch(request) {
			if (closing || pending.size >= 32)
				return errorResponse("Environment listener unavailable", 503);
			const response = route(request);
			pending.add(response);
			try {
				return await response;
			} finally {
				pending.delete(response);
			}
		},
		error: () => errorResponse("Environment listener failed", 500),
	});
	return {
		url: `http://127.0.0.1:${server.port}/mcp`,
		stop() {
			closing = true;
			stopping ??= (async () => {
				await server.stop(true);
				await Promise.allSettled(entries.map(({ handler }) => handler.close()));
				await Promise.allSettled([...pending]);
			})();
			return stopping;
		},
	};
}
