import { type ConversationId, defineTool } from "@earendil-works/pi-durable";
import { Type } from "typebox";
import { requestReview } from "../reviews.ts";
import type { TaskInfo } from "../state.ts";
import { httpOptions } from "./http-options.ts";
import type { Environments } from "./manager.ts";
import { environmentResult } from "./tool-result.ts";
export function createHttpTools(
	manager: Environments,
	ownerOf: (id: ConversationId) => Promise<TaskInfo | null>,
) {
	return [
		defineTool({
			name: "env_http_request",
			description:
				"Request exact human approval for an HTTP operation to this task's live ready shell endpoint. Non-read methods require allowWrite:true. Optional followRedirects permits at most three same-origin redirects within one ten-second deadline; POST 301/302 and non-HEAD 303 become GET without a body, while 307/308 preserve method/body and may replay writes. Optional authenticate uses only configured frozen Basic/Bearer secret references over verified HTTPS, never caller Authorization/cookies. No proxy, foreign origin or other-runtime binding. Responses are bounded and redacted; writes cannot be rolled back by cancellation. A durable native issuance marker prevents automatic resend after an uncertain response or crash; completed replay returns the original diagnostic receipt, never fresh network authority. A referenced-roots-v1 approval additionally binds the exact root generation and its declared prerequisite generations; every one must still be the original live handle at dispatch and publication, with no substitute run.",
			parameters: Type.Object({
				app: Type.String({ maxLength: 64 }),
				endpoint: Type.String({ maxLength: 64 }),
				path: Type.Optional(Type.String({ maxLength: 2048 })),
				method: Type.Optional(
					Type.Union([
						Type.Literal("GET"),
						Type.Literal("HEAD"),
						Type.Literal("POST"),
						Type.Literal("PUT"),
						Type.Literal("PATCH"),
						Type.Literal("DELETE"),
						Type.Literal("OPTIONS"),
					]),
				),
				headers: Type.Optional(
					Type.Record(Type.String(), Type.String({ maxLength: 1024 })),
				),
				body: Type.Optional(Type.String({ maxLength: 16384 })),
				allowWrite: Type.Optional(Type.Boolean()),
				followRedirects: Type.Optional(Type.Boolean()),
				authenticate: Type.Optional(Type.Boolean()),
			}),
			replay: "safe",
			executionMode: "sequential",
			execute: async (args, api, context) => {
				const owner = await ownerOf(api.conversationId);
				if (!owner)
					throw new Error("Endpoint diagnostics require a native skill task");
				const options = httpOptions({
					method: args.method,
					headers: args.headers,
					body: args.body,
					allowWrite: args.allowWrite,
					followRedirects: args.followRedirects,
					authenticate: args.authenticate,
				});
				const issuance = {
					id: `http-${api.taskId}`,
					input: {
						app: args.app,
						endpoint: args.endpoint,
						path: args.path ?? "/",
						http: options,
					},
				};
				const cached = await manager.http.receipt(
					owner,
					issuance.id,
					issuance.input,
					context.abortSignal,
				);
				if (cached) return environmentResult(cached);
				const request = await manager.http.prepare(
					owner,
					args.app,
					args.endpoint,
					args.path ?? "/",
					context.abortSignal,
					options,
				);
				const snapshot = JSON.stringify(
					{
						request,
						authority:
							"One direct HTTP operation or explicitly requested bounded same-origin redirect chain to this exact held ready shell endpoint. A durable native issuance marker is written before dispatch; replay returns only a completed original response or refuses uncertain issuance, never resends it. This is not a server-side transaction or exactly-once effect guarantee. The displayed method, headers and body are authorized; non-read methods require allowWrite:true. Writes, GET and redirect replay may cause irreversible server-side effects; cancellation/timeout is not rollback. At most three redirects and ten seconds total: POST 301/302 and non-HEAD 303 become GET without body/content-type; 307/308 preserve method/body. Every hop rechecks owner/live handle and approved public CA source; no different origin, insecure TLS, cookies, proxies, caller credentials, transport headers or other-runtime binding. Optional Basic/Bearer authentication uses only the displayed configured secret-variable references frozen in the live app, over verified HTTPS; referenced credentials are not expanded into this review; known literal secrets and the derived Basic header/base64 value are redacted from results, not arbitrary transformations or encodings. Redirect bodies are omitted; final source is capped at 64 KiB with text-only bounded output and incomplete-line withholding. No socket-to-process ownership proof.",
					},
					null,
					2,
				);
				const review = await requestReview(
					owner,
					{
						title: `Endpoint ${options.method}: ${args.app}/${args.endpoint}`,
						path: owner.workspace,
						snapshot,
					},
					api,
					context,
				);
				if (review.state !== "approved" || review.snapshot !== snapshot)
					throw new Error(
						"Exact current endpoint HTTP operation was not approved",
					);
				return environmentResult(
					await manager.http.request(
						owner,
						request,
						context.abortSignal,
						issuance,
					),
				);
			},
		}),
		defineTool({
			name: "env_http_get",
			description:
				"Request exact human approval for one GET to a named numeric-loopback HTTP/HTTPS endpoint of this task's live ready shell app. HTTPS requires TLS 1.2+ and valid certificate/IP verification, using system trust or one configured public CA file digest-pinned to this approval. No insecure TLS, client credentials, redirects, proxies, cookies, custom headers or writes. GET may have server-side effects. Ten-second deadline, 64 KiB source cap, text-only output and frozen app-secret redaction; discard responses if app ownership ends. No socket-to-process identity proof or other runtimes.",
			parameters: Type.Object({
				app: Type.String({ maxLength: 64 }),
				endpoint: Type.String({ maxLength: 64 }),
				path: Type.Optional(Type.String({ maxLength: 2048 })),
			}),
			replay: "safe",
			executionMode: "sequential",
			execute: async (args, api, context) => {
				const owner = await ownerOf(api.conversationId);
				if (!owner)
					throw new Error("Endpoint diagnostics require a native skill task");
				const issuance = {
					id: `http-${api.taskId}`,
					input: {
						app: args.app,
						endpoint: args.endpoint,
						path: args.path ?? "/",
						http: httpOptions(),
					},
				};
				const cached = await manager.http.receipt(
					owner,
					issuance.id,
					issuance.input,
					context.abortSignal,
				);
				if (cached) return environmentResult(cached);
				const request = await manager.http.prepare(
						owner,
						args.app,
						args.endpoint,
						args.path ?? "/",
						context.abortSignal,
					),
					snapshot = JSON.stringify(
						{
							request,
							authority:
								"One direct GET to the displayed configured local origin while this exact ready shell app is held. HTTPS verifies the certificate and numeric IP with TLS 1.2+, using system trust unless the displayed public CA reference/digest replaces it. That single public CA file must remain inside the configuration directory and match the approved source digest before sending. No insecure TLS, hostname override, client certificate/key or authentication authority. HTTP is unencrypted; neither scheme proves socket-to-process ownership. GET may cause server-side effects; no redirects, proxy, cookies, credentials or custom headers. Source response bounded to 64 KiB/10 seconds, known app secrets redacted; non-text/encoded bodies omitted. No other methods or origins are approved. A durable native issuance marker prevents automatic resend on uncertain replay; completed replay returns only the original diagnostic response, not fresh authority.",
						},
						null,
						2,
					);
				const review = await requestReview(
					owner,
					{
						title: `Endpoint GET: ${args.app}/${args.endpoint}`,
						path: owner.workspace,
						snapshot,
					},
					api,
					context,
				);
				if (review.state !== "approved" || review.snapshot !== snapshot)
					throw new Error("Exact current endpoint GET was not approved");
				return environmentResult(
					await manager.http.request(
						owner,
						request,
						context.abortSignal,
						issuance,
					),
				);
			},
		}),
	];
}
