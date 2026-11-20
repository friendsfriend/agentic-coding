import type { McpServer } from "@modelcontextprotocol/server";
import * as z from "zod/v4";
import {
	diagnosticId,
	httpInputSchema,
	queryInputSchema,
} from "../environment/controller/diagnostic-input.ts";
import type { BoundEnvironmentController } from "../environment/controller/service.ts";
import { outputSchema, respond } from "./execution.ts";

const requestId = z.string().trim().min(1).max(256);
const read = { readOnlyHint: true, idempotentHint: true, openWorldHint: false };

export function registerEnvironmentDiagnostics(
	server: McpServer,
	controller: BoundEnvironmentController,
) {
	server.registerTool(
		"env_http_request",
		{
			description:
				"Prepare exact human approval for HTTP to this scope's live ready declared endpoint. Returns a pending operation, never sends at admission. Non-read methods require allowWrite:true. After operator approval use environment_action execute with its ID. Native generation, ownership, verified-TLS, credential-reference and redirect restrictions remain mandatory. No caller URL/credentials/owner; cancellation is not rollback and issued requests are never automatically resent.",
			inputSchema: httpInputSchema.extend({ requestId }),
			outputSchema,
			annotations: {
				readOnlyHint: false,
				destructiveHint: false,
				idempotentHint: true,
				openWorldHint: false,
			},
		},
		({ requestId, ...input }) =>
			respond(() => controller.http(requestId, input)),
	);
	server.registerTool(
		"db_query",
		{
			description:
				"Prepare exact human approval for SELECT/WITH on this scope's live declared PostgreSQL prerequisite. Returns a pending operation, never queries at admission. After operator approval use environment_action execute. Native requiring-app/generation checks, least-privileged frozen credentials, verified TLS, read-only transaction, bounds, rollback and issuance fences remain mandatory. READ ONLY is not a sandbox for privileged functions. No caller connection/credentials/owner; never automatically resend issued SQL.",
			inputSchema: queryInputSchema.extend({ requestId }),
			outputSchema,
			annotations: {
				readOnlyHint: false,
				destructiveHint: false,
				idempotentHint: true,
				openWorldHint: false,
			},
		},
		({ requestId, ...input }) =>
			respond(() => controller.query(requestId, input)),
	);
	server.registerTool(
		"env_logs",
		{
			description:
				"Read this scope's already-redacted retained logs. Choose exactly one app or infra. Literal grep, newest matching tail and strict ISO since use native bounded windows/counts; no runtime/CLI call or full-history claim. Exact Compose service/Pod replica selectors never fall back to another source. Historical data grants no resource authority.",
			inputSchema: z
				.strictObject({
					app: diagnosticId.optional(),
					infra: diagnosticId.optional(),
					grep: z.string().max(512).optional(),
					since: z.string().min(1).max(128).optional(),
					tail: z.number().int().min(1).max(1000).optional(),
					service: diagnosticId.optional(),
					replica: z.number().int().min(0).max(15).optional(),
				})
				.refine(
					(input) => (input.app === undefined) !== (input.infra === undefined),
				),
			outputSchema,
			annotations: read,
		},
		({ app, infra, ...options }) =>
			respond(() =>
				controller.logs(app ?? infra ?? "", {
					...options,
					...(infra ? { kind: "infrastructure" as const } : {}),
				}),
			),
	);
	server.registerTool(
		"otel_query",
		{
			description:
				"Read only this scope's live ready app's opt-in native telemetry. Native trace/log filters, bounded tree/history/cursor rules and current generation/prerequisite checks apply. No external backend, metrics, saved receiver authority or credentials. Querying an unavailable or replaced receiver refuses rather than restoring it.",
			inputSchema: z.strictObject({
				app: diagnosticId,
				run: z.string().min(1).max(256).optional(),
				mode: z.enum(["traces", "logs"]).optional(),
				view: z.enum(["flat", "tree"]).optional(),
				cursor: z.string().max(512).optional(),
				traceId: z.string().max(64).optional(),
				spanId: z.string().max(64).optional(),
				http: z.string().max(1024).optional(),
				service: z.string().max(200).optional(),
				rootKind: z.string().max(64).optional(),
				limit: z.number().int().min(1).max(200).optional(),
				since: z.string().max(128).optional(),
				status: z.enum(["all", "error", "success"]).optional(),
				name: z.string().max(512).optional(),
				severity: z.string().max(64).optional(),
				text: z.string().max(512).optional(),
			}),
			outputSchema,
			annotations: read,
		},
		({ app, run, ...options }) =>
			respond(() => controller.telemetry(app, options, run)),
	);
	server.registerTool(
		"env_diagnostic_history",
		{
			description:
				"Read retained native HTTP/SQL issuances for one exact run owned by this scope. Optional operation selects an exact ID; cursor selects an older page, never both. Counts cover retained observations only. Issued is pending/uncertain, never execution proof; historical data cannot resend or restore resources.",
			inputSchema: z
				.strictObject({
					run: z.string().min(1).max(256),
					kind: z.enum(["http", "sql"]),
					limit: z.number().int().min(1).max(50).default(50),
					operation: z.string().min(1).max(256).optional(),
					cursor: z
						.string()
						.regex(/^[a-f0-9]{64}$/)
						.optional(),
				})
				.refine(
					(input) =>
						input.operation === undefined || input.cursor === undefined,
				),
			outputSchema,
			annotations: read,
		},
		({ run, kind, ...selection }) =>
			respond(() => controller.diagnosticHistory(run, kind, selection)),
	);
}
