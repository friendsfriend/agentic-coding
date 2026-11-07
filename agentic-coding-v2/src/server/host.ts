import { randomBytes } from "node:crypto";
import { clientPath } from "../protocol/index.ts";
import type { Runtime } from "../runtime.ts";
import { equalSecret } from "./auth.ts";
import { type Connection, clientGateway } from "./client/index.ts";
import { httpRoutes } from "./http/index.ts";
import { webAssets } from "./http/web.ts";

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
	const assets = webAssets();
	const route = httpRoutes(app, json, security);
	const gateway = clientGateway(app);
	const server = Bun.serve<Connection>({
		websocket: gateway.websocket,
		hostname: "127.0.0.1",
		port,
		maxRequestBodySize: 1_000_000,
		async fetch(request, listener) {
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
			if (url.pathname === clientPath) {
				if (request.method !== "GET" || url.searchParams.size)
					return json({ error: "Unsupported client handshake" }, 400);
				return listener.upgrade(request, { data: gateway.connection() })
					? undefined
					: json({ error: "WebSocket upgrade required" }, 426);
			}
			return route(request, url);
		},
	});
	return {
		url: `http://127.0.0.1:${server.port}/#token=${token}`,
		client: { url: `ws://127.0.0.1:${server.port}${clientPath}`, token },
		stop: async () => {
			await gateway.stop();
			await server.stop(true);
		},
	};
}
