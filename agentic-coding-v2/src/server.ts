import { randomBytes, timingSafeEqual } from "node:crypto";
import path from "node:path";
import { object, text } from "./config.ts";
import { renderMarkdown } from "./markdown.ts";
import type { Runtime } from "./runtime.ts";
import type { Review } from "./state.ts";
import script from "./web/app.js" with { type: "text" };
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
export function serve(app: Runtime, port = 0) {
	const token = randomBytes(32).toString("hex");
	const cookieName = `acv2_${randomBytes(8).toString("hex")}`;
	const security = {
		"Content-Security-Policy":
			"default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self'; connect-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'",
		"X-Content-Type-Options": "nosniff",
		"Referrer-Policy": "no-referrer",
		"Cache-Control": "no-store",
	};
	const json = (
		value: unknown,
		status = 200,
		extra: Record<string, string> = {},
	) => Response.json(value, { status, headers: { ...security, ...extra } });
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
			if (
				request.method === "GET" &&
				["/", "/app.js", "/style.css"].includes(url.pathname)
			) {
				const content =
					url.pathname === "/"
						? String(html)
						: url.pathname === "/app.js"
							? script
							: css;
				const type =
					url.pathname === "/"
						? "text/html"
						: url.pathname === "/app.js"
							? "text/javascript"
							: "text/css";
				return new Response(content, {
					headers: { ...security, "Content-Type": `${type}; charset=utf-8` },
				});
			}
			const bearer =
				request.headers.get("authorization")?.replace(/^Bearer /, "") ?? "";
			const cookie =
				(request.headers.get("cookie") ?? "")
					.split(";")
					.map((part) => part.trim())
					.find((part) => part.startsWith(`${cookieName}=`))
					?.slice(cookieName.length + 1) ?? "";
			if (!equalSecret(bearer, token) && !equalSecret(cookie, token))
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
					url.pathname === "/api/environments/logs"
				)
					return json(
						await app.environments.logs(
							text(url.searchParams.get("app"), "environment app", 64),
						),
					);
				if (request.method !== "POST") return json({ error: "Not found" }, 404);
				const body = object(await request.json());
				if (url.pathname === "/api/session")
					return json({ ok: true }, 200, {
						"Set-Cookie": `${cookieName}=${token}; HttpOnly; SameSite=Strict; Path=/`,
					});
				if (url.pathname === "/api/chat")
					return json({
						submissionId: await app.chat(
							text(body.content, "message", 64000),
							text(body.requestId, "request ID", 256),
						),
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
