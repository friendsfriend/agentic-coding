import { createMcpHandler } from "@modelcontextprotocol/server";
import { boundedRequestBody } from "../environment/controller/http-body.ts";
import type { EnvironmentController } from "../environment/controller/service.ts";
import type { ControllerPrincipal } from "../environment/controller/state.ts";
import { equalSecret } from "../server/auth.ts";
import type { EnvironmentCatalog } from "./catalog.ts";
import { createEnvironmentMcpServer } from "./server.ts";

export type McpClientBinding = {
	token: string;
	principal: ControllerPrincipal;
	scopeId: string;
};
const security = {
	"Cache-Control": "no-store",
	"X-Content-Type-Options": "nosniff",
	"Referrer-Policy": "no-referrer",
	"Content-Security-Policy": "default-src 'none'; frame-ancestors 'none'",
};
const json = (error: string, status: number) =>
	Response.json({ error }, { status, headers: security });

/** One listener, one shared controller. Per-client handlers never create resource authorities. */
export async function serveEnvironmentMcp(options: {
	controller: EnvironmentController;
	catalog: EnvironmentCatalog;
	bindings: readonly McpClientBinding[];
	port?: number;
}) {
	const bindings = structuredClone(options.bindings);
	if (
		!bindings.length ||
		bindings.length > 32 ||
		new Set(bindings.map((binding) => binding.token)).size !==
			bindings.length ||
		!Number.isInteger(options.port ?? 0) ||
		(options.port ?? 0) < 0 ||
		(options.port ?? 0) > 65535
	)
		throw new Error("Invalid MCP listener configuration");
	for (const binding of bindings) {
		if (
			!/^[A-Za-z0-9_-]{32,128}$/.test(binding.token) ||
			binding.principal.role !== "agent"
		)
			throw new Error("Invalid MCP client binding");
		await options.controller.scopes
			.bind(binding.principal)
			.assertActive(binding.scopeId);
	}
	const handlers = bindings.map((binding) => {
		const bound = options.controller.bind(binding.principal, binding.scopeId);
		return {
			...binding,
			handler: createMcpHandler(
				() => createEnvironmentMcpServer(options.catalog, bound),
				{ maxRequestBodySize: 65536, maxSubscriptions: 8 },
			),
		};
	});
	let closing = false;
	let stopping: Promise<void> | null = null;
	const pending = new Set<Promise<Response>>();
	const route = async (request: Request): Promise<Response> => {
		const url = new URL(request.url);
		const expected = new URL(`http://127.0.0.1:${server.port}`);
		const host = request.headers.get("host");
		if (
			url.origin !== expected.origin ||
			(host !== expected.host && host !== `127.0.0.1:${server.port}`)
		)
			return json("Invalid MCP host", 403);
		const origin = request.headers.get("origin");
		if (origin && origin !== expected.origin)
			return json("Cross-origin MCP request refused", 403);
		if (url.pathname !== "/mcp" || url.searchParams.size)
			return json("MCP route not found", 404);
		const token =
			request.headers.get("authorization")?.replace(/^Bearer /, "") ?? "";
		const binding = handlers.find((candidate) =>
			equalSecret(token, candidate.token),
		);
		if (!binding) return json("MCP authentication required", 401);
		try {
			let incoming = request;
			if (request.method === "POST") {
				const body = await boundedRequestBody(request, 65536);
				incoming = new Request(request, { body });
			}
			const response = await binding.handler.fetch(incoming);
			const headers = new Headers(response.headers);
			for (const [key, value] of Object.entries(security))
				headers.set(key, value);
			return new Response(response.body, { status: response.status, headers });
		} catch {
			return json(
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
		idleTimeout: 10,
		async fetch(request) {
			if (closing || pending.size >= 32)
				return json("MCP listener unavailable", 503);
			const operation = route(request);
			pending.add(operation);
			try {
				return await operation;
			} finally {
				pending.delete(operation);
			}
		},
		error: () => json("MCP listener failed", 500),
	});
	return {
		url: `http://127.0.0.1:${server.port}/mcp`,
		stop: () => {
			closing = true;
			stopping ??= (async () => {
				await server.stop(true);
				await Promise.allSettled(
					handlers.map(({ handler }) => handler.close()),
				);
				await Promise.allSettled([...pending]);
			})();
			return stopping;
		},
	};
}
