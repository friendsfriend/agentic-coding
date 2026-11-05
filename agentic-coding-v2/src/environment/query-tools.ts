import { type ConversationId, defineTool } from "@earendil-works/pi-durable";
import { Type } from "typebox";
import { requestReview } from "../reviews.ts";
import type { TaskInfo } from "../state.ts";
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
				"Request exact human approval for one SELECT/WITH diagnostic on this task's live ready PostgreSQL shell infrastructure required by a held application. Optional app selects exactly one requiring application, including transitive prerequisites; its run and complete declared prerequisite generations are bound into approval, issuance and results. An unknown or non-requiring app never falls back to another app. Omission retains legacy selection. The complete coupled batch must still be live; this does not enable reference sharing or independent cleanup. One reserved verified-TLS numeric-loopback connection uses only configured credentials frozen at startup, a read-only transaction, explicit rollback and one total ten-second deadline. No SQL parameter-like $digits text (even in literals/comments), caller connections/credentials, other owners, shared leases, other engines or restart adoption. Query limit 1–200 (default 50); complete rows are bounded and redacted, oversized rows omitted, and database numeric values are strings to preserve precision. READ ONLY is not a sandbox for privileged functions. Durable issuance replay returns only recorded diagnostics or refuses uncertain execution; it never resends a query.",
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
										rootScope:
											"This exact requiring application run and its immutable transitive infrastructure generations, not another app with access to the same database. All existing coupled-batch liveness, pending-operation and cleanup fences remain mandatory. Root binding is attribution/liveness, not database row or credential isolation. No managed reference lease, partial release or scoped dependency idle permission is granted.",
									}),
							authority:
								"One exact SQL diagnostic through this task's live required infrastructure and held application. The SELECT/WITH shape check is not a permission grant or complete effect classifier: the database READ ONLY transaction fences database writes, but privileged functions can have nontransactional/external effects. Inspect the SQL and configure a least-privileged database role. TLS must verify the numeric loopback certificate identity with system trust or this digest-pinned public CA; credentials are only the displayed variable references, frozen in the live process. No caller credentials, other database/host/port, TLS downgrade, owner, saved-lease adoption or socket-to-process identity proof. The driver requires a positional row-cap binding to force the single-statement extended protocol; caller $digits text is refused conservatively, including in literals/comments. The user statement is wrapped as a bound single prepared query with LIMIT+1 lookahead and a 1025-character JSON row projection. Over-1024-UTF-16-unit rows are entirely withheld; returned complete JSON rows share an 8192-byte budget. Database numeric values become exact lexical strings; nested data beyond eight levels is omitted. Literal frozen secrets in complete row strings/keys are redacted; arbitrary encodings/transformations are not. One read-only transaction is always rolled back before accepting a successful result, with a ten-second total deadline. Cancellation/failure may leave rollback unconfirmed; its durable issued receipt prevents automatic resend. Successful replay is only a historical diagnostic, not new connection or execution authority.",
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
