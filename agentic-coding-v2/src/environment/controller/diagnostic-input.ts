import * as z from "zod/v4";
import type { EndpointRequest } from "../endpoint.ts";
import { httpOptions } from "../http-options.ts";
import type { HttpInput } from "../http-receipts.ts";
import { queryInput } from "../query-config.ts";
import type { QueryRequest } from "../query-manager.ts";

export const diagnosticId = z.string().regex(/^[a-z][a-z0-9-]{0,63}$/);
export const httpInputSchema = z.strictObject({
	app: diagnosticId,
	endpoint: diagnosticId,
	path: z.string().min(1).max(2048).optional(),
	method: z
		.enum(["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"])
		.optional(),
	headers: z.record(z.string(), z.string().max(1024)).optional(),
	body: z.string().max(16384).optional(),
	allowWrite: z.boolean().optional(),
	followRedirects: z.boolean().optional(),
	authenticate: z.boolean().optional(),
});
export const queryInputSchema = z.strictObject({
	infra: diagnosticId,
	app: diagnosticId.optional(),
	sql: z.string().max(20000),
	schema: z.string().min(1).max(63).optional(),
	limit: z.number().int().min(1).max(200).optional(),
});
export function diagnosticHttpInput(raw: unknown): HttpInput {
	const { app, endpoint, path, ...options } = httpInputSchema.parse(raw);
	const http = httpOptions(options);
	return {
		app,
		endpoint,
		path: path ?? "/",
		http: {
			...http,
			headers: Object.fromEntries(
				Object.entries(http.headers).sort(([a], [b]) =>
					a < b ? -1 : a > b ? 1 : 0,
				),
			),
		},
	};
}
export function diagnosticQueryInput(raw: unknown) {
	const input = queryInputSchema.parse(raw);
	return queryInput(
		input.infra,
		input.sql,
		input.limit,
		input.schema,
		input.app,
	);
}
export type DiagnosticSnapshot =
	| {
			kind: "http";
			input: HttpInput;
			request: EndpointRequest;
			authority: string;
	  }
	| {
			kind: "sql";
			input: ReturnType<typeof queryInput>;
			request: QueryRequest;
			authority: string;
			rootScope?: string;
	  };

export const nativeDiagnosticId = (
	kind: DiagnosticSnapshot["kind"],
	id: string,
) => `${kind === "http" ? "http" : "query"}-controller-${id}`;

/** Native journals retain their full bounded result; presentation loss is not uncertain execution. */
export function diagnosticResult(
	result: unknown,
	snapshot: DiagnosticSnapshot,
	id: string,
) {
	let diagnostic = result;
	if (Buffer.byteLength(JSON.stringify(diagnostic)) > 48000) {
		if (
			diagnostic &&
			typeof diagnostic === "object" &&
			!Array.isArray(diagnostic) &&
			"body" in diagnostic
		)
			diagnostic = {
				...diagnostic,
				body: "[body omitted from controller receipt; inspect native diagnostic history]",
				bodyFormat: "omitted",
				controllerBodyOmitted: true,
			};
		if (Buffer.byteLength(JSON.stringify(diagnostic)) > 48000)
			diagnostic = {
				omitted: true,
				reason: "Controller receipt budget; inspect native diagnostic history",
			};
	}
	return {
		status: "completed",
		diagnostic,
		history: {
			kind: snapshot.kind,
			run: snapshot.request.run,
			operation: nativeDiagnosticId(snapshot.kind, id),
		},
	};
}
