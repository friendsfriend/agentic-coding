import { type ConversationId, defineTool } from "@earendil-works/pi-durable";
import { Type } from "typebox";
import { requestReview } from "../reviews.ts";
import type { TaskInfo } from "../state.ts";
import {
	sqlDiagnosticAuthority,
	sqlRootScopeAuthority,
} from "./diagnostic-approval.ts";
import { queryInput } from "./query-config.ts";
import type { DatabaseDiagnostics } from "./query-manager.ts";
import { environmentResult } from "./tool-result.ts";

export function createQueryTools(
	database: DatabaseDiagnostics,
	ownerOf: (id: ConversationId) => Promise<TaskInfo | null>,
) {
	return [
		defineTool({
			name: "db_query",
			description:
				"Request exact human approval for one SELECT/WITH diagnostic on this task's live ready PostgreSQL shell, health-ready owned container or ready owned pod infrastructure with a replica-pinned forward required by a held application. A pod query connection requires the run's own declared loopback port forward on the query port. Optional app selects exactly one requiring application, including transitive prerequisites; its run and complete declared prerequisite generations are bound into approval, issuance and results. An unknown or non-requiring app never falls back to another app. Omission retains legacy selection. The complete coupled batch must still be live; this does not enable reference sharing or independent cleanup. One reserved verified-TLS numeric-loopback connection uses only configured credentials frozen at startup, a read-only transaction, explicit rollback and one total ten-second deadline. No SQL parameter-like $digits text (even in literals/comments), caller connections/credentials, other owners, shared leases, other engines or restart adoption. Query limit 1–200 (default 50); complete rows are bounded and redacted, oversized rows omitted, and database numeric values are strings to preserve precision. READ ONLY is not a sandbox for privileged functions. Durable issuance replay returns only recorded diagnostics or refuses uncertain execution; it never resends a query.",
			parameters: Type.Object(
				{
					infra: Type.String({ maxLength: 64 }),
					app: Type.Optional(Type.String({ minLength: 1, maxLength: 64 })),
					sql: Type.String({ maxLength: 20000 }),
					schema: Type.Optional(Type.String({ maxLength: 63 })),
					limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 200 })),
				},
				{ additionalProperties: false },
			),
			replay: "safe",
			executionMode: "sequential",
			execute: async (args, api, context) => {
				const owner = await ownerOf(api.conversationId);
				if (!owner)
					throw new Error("SQL diagnostics require a native skill task");
				const input = queryInput(
						args.infra,
						args.sql,
						args.limit,
						args.schema,
						args.app,
					),
					id = `query-${api.taskId}`,
					cached = await database.receipt(
						owner,
						id,
						input,
						context.abortSignal,
					);
				if (cached) return environmentResult(cached);
				const request = await database.prepare(
						owner,
						input,
						context.abortSignal,
					),
					snapshot = JSON.stringify(
						{
							request,
							...(input.app === undefined
								? {}
								: {
										rootScope: sqlRootScopeAuthority,
									}),
							authority: sqlDiagnosticAuthority,
						},
						null,
						2,
					);
				const review = await requestReview(
					owner,
					{ title: `Query ${input.infra}`, path: owner.workspace, snapshot },
					api,
					context,
				);
				if (review.state !== "approved" || review.snapshot !== snapshot)
					throw new Error("Exact current database diagnostic was not approved");
				return environmentResult(
					await database.request(owner, request, id, context.abortSignal),
				);
			},
		}),
	];
}
