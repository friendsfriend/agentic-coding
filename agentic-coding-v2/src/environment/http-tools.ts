import { type ConversationId, defineTool } from "@earendil-works/pi-durable";
import { Type } from "typebox";
import { requestReview } from "../reviews.ts";
import type { TaskInfo } from "../state.ts";
import { httpDiagnosticAuthority } from "./diagnostic-approval.ts";
import { httpOptions } from "./http-options.ts";
import type { Environments } from "./manager.ts";
import { environmentResult } from "./tool-result.ts";
export function createHttpTools(
	manager: Environments,
	environmentOf: (id: ConversationId) => Promise<TaskInfo | null>,
) {
	return [
		defineTool({
			name: "env_http_request",
			description:
				"Request exact human approval for an HTTP operation to this task's live ready shell, health-ready owned Docker/Podman, explicit Compose-service or owned single-replica Pod endpoint, the last two only through their declared service or loopback port forward. Non-read methods require allowWrite:true. Optional followRedirects permits at most three same-origin redirects within one ten-second deadline; POST 301/302 and non-HEAD 303 become GET without a body, while 307/308 preserve method/body and may replay writes. Optional authenticate uses only configured frozen Basic/Bearer secret references over verified HTTPS, never caller Authorization/cookies. No proxy, foreign origin, shared/external binding, automatic discovery or socket-ownership proof. Responses are bounded and redacted; writes cannot be rolled back by cancellation. A durable native issuance marker prevents automatic resend after an uncertain response or crash; completed replay returns the original diagnostic receipt, never fresh network authority. A referenced-roots-v1 approval additionally binds the exact root generation and its declared prerequisite generations; every one must still be the original live handle at dispatch and publication, with no substitute run.",
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
				const owner = await environmentOf(api.conversationId);
				if (!owner)
					throw new Error(
						"Endpoint diagnostics require a task or an environment it spawned",
					);
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
						authority: httpDiagnosticAuthority,
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
	];
}
