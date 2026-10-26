// The debug tools of a durable agent run (`add-agent-debug-tools`).
//
// `agentic.debug` gives every durable run — read-only verifiers included — the
// three tools that explain a failing request: `otel_query` reads the traces its
// own runs exported, `db_query` reads the data the app it holds keeps, and
// `http_request` calls a static endpoint of an app it holds. They never talk to
// the receiver, a database or `curl` themselves: every call goes to the
// server's owner-scoped `/api/v1/agent-env/debug/*` surface with the capability
// the run already holds, so a query can only ever answer with this workflow's
// runs, and an endpoint another workflow holds is refused by name.
//
// All three are reads of one kind or another, and all three say what they did
// not return: a trace list reports whether the index dropped older traces, a
// span tree whether it was cut, and a response whether it was truncated.
import { Type } from "@earendil-works/pi-ai";
import { defineExtension, defineTool } from "@earendil-works/pi-durable";
import {
	AGENT_DB_QUERY_PATH,
	AGENT_HTTP_REQUEST_PATH,
	AGENT_OTEL_QUERY_PATH,
} from "../server/protocol.ts";
import {
	ENVIRONMENT_OWNER_HEADER,
	ENVIRONMENT_TOKEN_ENV,
	ENVIRONMENT_URL_ENV,
	environmentOwnerFor,
} from "./environment-capability.ts";
import { toolViewDetails } from "./tool-view-details.ts";
import type { RunContextLookup } from "./tools.ts";

export const DEBUG_EXTENSION = "agentic.debug";

/** Tool output bound: a larger answer is truncated rather than flooding the
 * session. */
const MAX_RESULT_CHARS = 40_000;
const READ_TIMEOUT_MS = 120_000;
/** A database statement is bounded by its own timeout server-side; this is the
 * transport's own patience above it. */
const DB_TIMEOUT_MS = 180_000;
/** One HTTP call to an endpoint of a held app. */
const HTTP_TIMEOUT_MS = 120_000;

type Result = {
	details?: ReturnType<typeof toolViewDetails>;
	output: Array<{ type: "text"; text: string }>;
	isError?: boolean;
};

function text(value: unknown): Result {
	const raw =
		typeof value === "string" ? value : JSON.stringify(value, null, 2);
	return {
		details: toolViewDetails(value, MAX_RESULT_CHARS),
		output: [
			{
				type: "text",
				text:
					raw.length > MAX_RESULT_CHARS
						? `${raw.slice(0, MAX_RESULT_CHARS)}\n… (truncated)`
						: raw,
			},
		],
	};
}

function failure(message: string): Result {
	return { output: [{ type: "text", text: message }], isError: true };
}

interface DebugBinding {
	readonly url: string;
	readonly token: string;
	readonly owner: string;
}

function bindingOf(
	env: Readonly<Record<string, string>>,
): DebugBinding | undefined {
	const url = env[ENVIRONMENT_URL_ENV];
	const token = env[ENVIRONMENT_TOKEN_ENV];
	const workflowId = env.HERDR_WORKFLOW_ID;
	if (!url || !token || !workflowId) return undefined;
	return { url, token, owner: environmentOwnerFor(workflowId) };
}

const NO_BINDING =
	"this run has no agent environment capability (the workflow server did not provide one); the debug tools are unavailable";

/** One authenticated call to the server's owner-scoped debug surface. Resolves
 * to the envelope's `value`; rejects with the server's message, which already
 * carries the refusal code (`app-not-held`, `trace-unknown`, …). */
async function call(
	env: Readonly<Record<string, string>>,
	path: string,
	body: Record<string, unknown>,
	timeoutMs: number,
	send: typeof fetch,
): Promise<unknown> {
	const binding = bindingOf(env);
	if (!binding) throw new Error(NO_BINDING);
	const response = await send(`${binding.url}${path}`, {
		method: "POST",
		headers: {
			authorization: `Bearer ${binding.token}`,
			[ENVIRONMENT_OWNER_HEADER]: binding.owner,
			"content-type": "application/json",
		},
		body: JSON.stringify(body),
		signal: AbortSignal.timeout(timeoutMs),
	});
	const parsed = (await response.json().catch(() => undefined)) as
		| {
				ok?: boolean;
				value?: unknown;
				error?: { code?: string; message?: string };
		  }
		| undefined;
	if (!response.ok || !parsed || parsed.ok === false || parsed.error) {
		const code = parsed?.error?.code;
		throw new Error(
			`${parsed?.error?.message ?? `the debug server answered ${response.status}`}${code ? ` [${code}]` : ""}`,
		);
	}
	return parsed.value;
}

function message(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

/** `otel_query` — the traces, and the log records, this workflow's runs
 * exported. */
const OtelQueryParameters = Type.Object({
	mode: Type.Optional(
		Type.Union([Type.Literal("traces"), Type.Literal("logs")], {
			description:
				"`traces` (default) for the trace list or a span tree, `logs` for the log records of the same runs (a `traceId` narrows them to one request)",
		}),
	),
	app: Type.Optional(
		Type.String({
			minLength: 1,
			description: "Only traces of this app (`ac.app`)",
		}),
	),
	since: Type.Optional(
		Type.String({
			description:
				"ISO 8601 instant; traces that started before it are dropped",
		}),
	),
	status: Type.Optional(
		Type.Union(
			[Type.Literal("all"), Type.Literal("error"), Type.Literal("success")],
			{ description: "Only traces with (or without) an error span" },
		),
	),
	name: Type.Optional(
		Type.String({
			description: "Only traces containing a span whose name contains this",
		}),
	),
	traceId: Type.Optional(
		Type.String({
			description:
				"One trace: its span tree instead of the list, with the key attributes and exception events of every span",
		}),
	),
	minSpans: Type.Optional(
		Type.Integer({
			minimum: 1,
			maximum: 500,
			description: "Only traces with at least this many spans",
		}),
	),
	rootKind: Type.Optional(
		Type.String({
			description:
				"Only traces whose root span has this OTLP kind (`server` for an inbound request)",
		}),
	),
	http: Type.Optional(
		Type.String({
			description:
				"Only traces whose root span carries this HTTP method, route, target or URL, or whose span name contains it (a case-insensitive substring, with or without a leading `METHOD `)",
		}),
	),
	excludeNames: Type.Optional(
		Type.String({
			description:
				"Drop traces whose every span name contains this (a background poller's query)",
		}),
	),
	includeNoise: Type.Optional(
		Type.Boolean({
			description:
				"Rank the single-span background traces among the rest instead of after them",
		}),
	),
	severity: Type.Optional(
		Type.String({
			description:
				"Logs mode: only records whose severity contains this (`ERROR`)",
		}),
	),
	text: Type.Optional(
		Type.String({
			description:
				"Logs mode: only records whose body or attributes contain this",
		}),
	),
	limit: Type.Optional(
		Type.Integer({
			minimum: 1,
			maximum: 200,
			description:
				"How many rows the list returns (traces default 20, logs default 50, maximum 200)",
		}),
	),
});

/** `db_query` — one read-only statement against the infra a held app needs. */
const DbQueryParameters = Type.Object({
	infra: Type.String({
		minLength: 1,
		description:
			"The infra service to query, by ident. It must declare a query connection, and an app this workflow holds must require it.",
	}),
	sql: Type.String({
		minLength: 1,
		maxLength: 20_000,
		description:
			"One read-only SQL statement. It runs in a read-only transaction with a statement timeout, is always rolled back, and returns at most 200 rows.",
	}),
	schema: Type.Optional(
		Type.String({
			description:
				"Schema (Postgres `search_path`) or database (MySQL `USE`) to select for this query",
		}),
	),
	limit: Type.Optional(
		Type.Integer({
			minimum: 1,
			maximum: 200,
			description: "How many rows to return (default 50, maximum 200)",
		}),
	),
});

/** `http_request` — one call to a static endpoint of a held app. */
const HttpRequestParameters = Type.Object({
	app: Type.String({
		minLength: 1,
		description: "The app whose endpoint is called; this workflow must hold it",
	}),
	endpoint: Type.String({
		minLength: 1,
		description: "The endpoint name, exactly as env_list reports it",
	}),
	method: Type.Optional(
		Type.Union(
			[
				Type.Literal("GET"),
				Type.Literal("HEAD"),
				Type.Literal("POST"),
				Type.Literal("PUT"),
				Type.Literal("PATCH"),
				Type.Literal("DELETE"),
				Type.Literal("OPTIONS"),
			],
			{ description: "HTTP method; `GET` when omitted" },
		),
	),
	path: Type.Optional(
		Type.String({
			description:
				"Path and query to append to the endpoint, e.g. `/api/orders?limit=5`. It may not leave the endpoint's own origin.",
		}),
	),
	headers: Type.Optional(
		Type.Record(Type.String(), Type.String(), {
			description: "Request headers; at most 32",
		}),
	),
	body: Type.Optional(
		Type.String({
			description: "Request body for a method that carries one, at most 64 KiB",
		}),
	),
});

/** Test seams: the transport is injectable for a fake server. Production
 * callers pass nothing. */
export interface DebugToolOptions {
	readonly fetch?: typeof fetch;
}

/** `agentic.debug`: the debug tool surface of one durable run. */
export function createDebugExtension(
	lookup: RunContextLookup,
	options: DebugToolOptions = {},
) {
	const send = options.fetch ?? fetch;
	return defineExtension({
		name: DEBUG_EXTENSION,
		tools: [
			defineTool({
				name: "otel_query",
				description: [
					"Read the traces this workflow's own runs exported to the local receiver: a bounded list of recent traces, one trace's span tree, or (`mode: \"logs\"`) the log records of the same runs.",
					"App telemetry is attributed by resource attributes (`ac.app`, `ac.owner`, `ac.run`), so a previous holder's spans and logs are never returned even though its host and port are identical.",
					"Without `traceId` the answer is up to `limit` rows `{traceId, root, rootKind, durationMs, status, errorCount, startedAt, app, run, spanCount}`, plus `considered` and `filtered` (how many of them each active filter rejected on its own, so an empty `matched` names the filter that removed the traces); with one it is the span tree of that trace, with the `http.*`/`db.*` attributes and exception events of each span. `trace-evicted` says the index received the trace and has since dropped it (it retains the newest 200 traces, background traces first); `trace-unknown` says no run of this workflow exported that id — only the second is worth re-running the request for.",
					"A backend that polls its database exports one span per query, so single-span traces that are not `server` spans are ranked after the request traces, are evicted from the index before a request trace, and the answer reports how many were dropped: pass `includeNoise`, `minSpans`, `excludeNames` or `http` to see them or to narrow the list.",
					'`http` matches the method, the route/target/URL attributes and the span name of any span of the trace, case-insensitively and as a substring, with or without a leading `METHOD `, so `"/grid-allocation-api/v1/requests"` and `"POST /grid-allocation-api/v1/requests"` both match the same request.',
					'`mode: "logs"` returns `{at, severity, body, service, traceId, spanId, attributes}` rows, bounded like a span; filter them with `traceId` (the log lines of one request), `severity`, `text` and `since`.',
					"Nothing is returned when the app is not exporting to the receiver: check that it carries the `AC_OTEL_*` variables of its run definition.",
				].join(" "),
				parameters: OtelQueryParameters,
				execute: async (args, api) => {
					const run = lookup(api.conversationId);
					if (!run) return failure("otel_query: run context unavailable");
					try {
						return text(
							await call(
								run.env,
								AGENT_OTEL_QUERY_PATH,
								{
									...(args.app ? { app: args.app } : {}),
									...(args.since ? { since: args.since } : {}),
									...(args.status ? { status: args.status } : {}),
									...(args.name ? { name: args.name } : {}),
									...(args.traceId ? { traceId: args.traceId } : {}),
									...(args.mode ? { mode: args.mode } : {}),
									...(args.minSpans === undefined
										? {}
										: { minSpans: args.minSpans }),
									...(args.rootKind ? { rootKind: args.rootKind } : {}),
									...(args.http ? { http: args.http } : {}),
									...(args.excludeNames
										? { excludeNames: args.excludeNames }
										: {}),
									...(args.includeNoise === undefined
										? {}
										: { includeNoise: args.includeNoise }),
									...(args.severity ? { severity: args.severity } : {}),
									...(args.text ? { text: args.text } : {}),
									...(args.limit === undefined ? {} : { limit: args.limit }),
								},
								READ_TIMEOUT_MS,
								send,
							),
						);
					} catch (error) {
						return failure(`otel_query: ${message(error)}`);
					}
				},
			}),
			defineTool({
				name: "db_query",
				description: [
					"Run one read-only SQL statement against an infra service of this environment that declares a query connection.",
					"It is allowed only while this workflow holds an app whose run target requires that infra, so start the app with env_start first.",
					"The statement runs in a read-only transaction with a 10 s statement timeout and is always rolled back, so a write is refused by the database itself; rows are capped (default 50, maximum 200) and long values are truncated.",
					"The credentials come from the configuration `.env` and are never echoed; the answer names the database (and the selected schema) the rows came from.",
				].join(" "),
				parameters: DbQueryParameters,
				execute: async (args, api) => {
					const run = lookup(api.conversationId);
					if (!run) return failure("db_query: run context unavailable");
					try {
						return text(
							await call(
								run.env,
								AGENT_DB_QUERY_PATH,
								{
									infra: args.infra,
									sql: args.sql,
									...(args.schema ? { schema: args.schema } : {}),
									...(args.limit === undefined ? {} : { limit: args.limit }),
								},
								DB_TIMEOUT_MS,
								send,
							),
						);
					} catch (error) {
						return failure(`db_query: ${message(error)}`);
					}
				},
			}),
			defineTool({
				name: "http_request",
				description: [
					"Call a static endpoint of an app this workflow holds — the same endpoints `env_start` reports and `browser_open` resolves — and get a bounded, redacted response `{status, statusText, headers, body, bytes, truncated, url}`.",
					"An endpoint of an app another workflow holds is refused by naming the holder, and the path may not leave the endpoint's own origin.",
					"The response body is capped at 64 KiB, `authorization`, `cookie` and `set-cookie` values are redacted, and any secret this environment declares is redacted wherever it appears.",
					"Use it to check what the API actually answers; `env_logs` and `otel_query` explain what happened behind it.",
				].join(" "),
				parameters: HttpRequestParameters,
				execute: async (args, api) => {
					const run = lookup(api.conversationId);
					if (!run) return failure("http_request: run context unavailable");
					const headers = Object.entries(args.headers ?? {});
					try {
						return text(
							await call(
								run.env,
								AGENT_HTTP_REQUEST_PATH,
								{
									app: args.app,
									endpoint: args.endpoint,
									...(args.method ? { method: args.method } : {}),
									...(args.path ? { path: args.path } : {}),
									...(headers.length === 0
										? {}
										: {
												headers: headers.map(([name, value]) => ({
													name,
													value,
												})),
											}),
									...(args.body === undefined ? {} : { body: args.body }),
								},
								HTTP_TIMEOUT_MS,
								send,
							),
						);
					} catch (error) {
						return failure(`http_request: ${message(error)}`);
					}
				},
			}),
		],
	});
}
