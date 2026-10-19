// The stage tool of a durable agent run (`add-stage-testing-foundation`,
// task 2.2).
//
// `agentic.stages` gives every durable run — read-only verifiers included — the
// one tool that answers "which hosted stages may I drive, and how do I log in
// to them". It never returns a credential: the catalog holds references (a
// variable *name* such as `GRID_INT_CLERK_PASSWORD`) and the values stay in the
// configuration `.env`, resolved server-side at the moment a login types them.
// Every reply also carries the value-free diagnostics of the stage files, so a
// run can tell "this stage does not exist" from "this stage was refused, and
// why".
//
// Like the browser and debug tools it talks to the server's owner-scoped
// `/api/v1/agent-env/stages` surface with the capability the run already holds.
import { Type } from "@earendil-works/pi-ai";
import { defineExtension, defineTool } from "@earendil-works/pi-durable";
import {
	AGENT_STAGE_API_REQUEST_PATH,
	AGENT_STAGE_TOKEN_INFO_PATH,
	AGENT_STAGES_PATH,
} from "../server/protocol.ts";
import {
	ENVIRONMENT_OWNER_HEADER,
	ENVIRONMENT_TOKEN_ENV,
	ENVIRONMENT_URL_ENV,
	environmentOwnerFor,
} from "./environment-capability.ts";
import type { RunContextLookup } from "./tools.ts";

export const STAGE_EXTENSION = "agentic.stages";

/** Tool output bound: a larger answer is truncated rather than flooding the
 * session. */
const MAX_RESULT_CHARS = 40_000;
/** What is left for a `stage_api_request` body once the envelope's own fields
 * are counted: the body is the only part that may grow, and a cut inside it
 * leaves a result that still parses (USAB-001). */
const MAX_API_BODY_CHARS = MAX_RESULT_CHARS - 2_000;
/** A version probe is bounded server-side; this is the transport's own
 * patience above it. */
const READ_TIMEOUT_MS = 120_000;

type Result = {
	content: Array<{ type: "text"; text: string }>;
	isError?: boolean;
};

function text(value: unknown): Result {
	const raw =
		typeof value === "string" ? value : JSON.stringify(value, null, 2);
	return {
		content: [
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
	return { content: [{ type: "text", text: message }], isError: true };
}

/**
 * The result of `stage_api_request`: the envelope's own fields (`status`,
 * `statusText`, `url`, `truncated`, `bytes`, `renewals`) are never what gets
 * cut, because a caller has to be able to read them (USAB-001).
 *
 * A body above the bound is cut *inside* its own string with a marker, and
 * `truncated` is forced to `true` so the answer says so — the whole result is
 * then still valid JSON.
 */
function apiResult(value: unknown): Result {
	if (value === null || typeof value !== "object" || Array.isArray(value))
		return text(value);
	const envelope = value as Record<string, unknown>;
	const body = envelope.body;
	if (typeof body !== "string" || body.length <= MAX_API_BODY_CHARS)
		return text(envelope);
	return text({
		...envelope,
		body: `${body.slice(0, MAX_API_BODY_CHARS)}\n… (body truncated)`,
		truncated: true,
	});
}

interface StageBinding {
	readonly url: string;
	readonly token: string;
	readonly owner: string;
}

function bindingOf(
	env: Readonly<Record<string, string>>,
): StageBinding | undefined {
	const url = env[ENVIRONMENT_URL_ENV];
	const token = env[ENVIRONMENT_TOKEN_ENV];
	const workflowId = env.HERDR_WORKFLOW_ID;
	if (!url || !token || !workflowId) return undefined;
	return { url, token, owner: environmentOwnerFor(workflowId) };
}

const NO_BINDING =
	"this run has no agent environment capability (the workflow server did not provide one); the stage tool is unavailable";

/** One authenticated call of the server's owner-scoped stage surface. */
async function call(
	env: Readonly<Record<string, string>>,
	path: string,
	timeoutMs: number,
	send: typeof fetch,
	body?: unknown,
): Promise<unknown> {
	const binding = bindingOf(env);
	if (!binding) throw new Error(NO_BINDING);
	const response = await send(`${binding.url}${path}`, {
		method: body === undefined ? "GET" : "POST",
		headers: {
			authorization: `Bearer ${binding.token}`,
			[ENVIRONMENT_OWNER_HEADER]: binding.owner,
			...(body === undefined ? {} : { "content-type": "application/json" }),
		},
		...(body === undefined ? {} : { body: JSON.stringify(body) }),
		signal: AbortSignal.timeout(timeoutMs),
	});
	const parsed = (await response.json().catch(() => undefined)) as
		| {
				ok?: boolean;
				value?: unknown;
				error?: { code?: string; message?: string; retryAfterMs?: number };
		  }
		| undefined;
	if (!response.ok || !parsed || parsed.ok === false || parsed.error) {
		const code = parsed?.error?.code;
		const retryAfterMs = parsed?.error?.retryAfterMs;
		// A rate limit is only actionable with the wait attached: an agent that
		// reads it can schedule its retry instead of polling (USAB-005).
		const retry =
			typeof retryAfterMs === "number" && retryAfterMs > 0
				? `; retry in ${Math.ceil(retryAfterMs / 1_000)} s`
				: "";
		throw new Error(
			`${parsed?.error?.message ?? `the stage server answered ${response.status}`}${code ? ` [${code}]` : ""}${retry}`,
		);
	}
	return parsed.value;
}

export interface StageToolOptions {
	/** Test seam. */
	readonly fetch?: typeof fetch;
}

/** The two optional coordinates `stage_api_request` and `stage_token_info` share:
 * a stage is only named when a run knows more than one, and an application only
 * when the stage has more than one candidate. */
const TargetParameters = {
	stage: Type.Optional(
		Type.String({
			description:
				"The stage ident. Omit it when this configuration allows exactly one stage, which then applies.",
		}),
	),
	app: Type.Optional(
		Type.String({
			description:
				"The application key. Omit it when the stage has exactly one candidate (one `api` application, or one that declares the role).",
		}),
	),
	role: Type.String({
		description:
			'The role whose token authenticates the call, as `stage_info` lists it. It has to select the `oauth2` login recipe (`loginKind: "oauth2"`); `stage_info` lists that role\'s provider, grant and `bearerOrigins`.',
	}),
};

export function createStageExtension(
	lookup: RunContextLookup,
	options: StageToolOptions = {},
) {
	const send = options.fetch ?? fetch;
	return defineExtension({
		name: STAGE_EXTENSION,
		tools: [
			defineTool({
				name: "stage_info",
				description: [
					"List the hosted test stages this configuration allows, or read one stage in detail. It never returns a secret: a credential appears as the *name* of the `.env` variable that has to be set (Settings → Stages), never as a value.",
					"An entry names the stage's environment and system, its `access` (`read-only` refuses state-changing requests, `writable` allows them), the applications it knows with their URLs, kinds and roles, the role's login recipe kind, each credential field's status (`set` or `missing VAR`), the origin allow-list and the declared read-only exceptions.",
					"A stage with a version probe resolves it with a bounded timeout: a host that does not answer reports `not discoverable` instead of failing the read.",
					"A stage that declares `oauth2` providers reports them with their token endpoint, scope, audience and client-authorization mode, and each role reports the `provider`, `grant` and `bearerOrigins` it selected — that is what a run needs to choose a role for `stage_api_request`. An `oauth2` role's `loginMode` is `automated` for the two unattended grants, `handoff` for the `authorization_code` grant (the developer signs in at the provider), and `unavailable` when the references it needs are unset or this configuration forbids a window.",
					'`excluded` lists the stage files that were refused with their value-free diagnostics, so "my stage is not here" has an answer.',
					"Open a stage with `browser_open({ stage, stageApp })`, then log in with `stage_login({ app, role })`.",
				].join(" "),
				parameters: Type.Object({
					stage: Type.Optional(
						Type.String({
							description:
								"One stage ident, for the detail (its applications and resolved version probes). Omit it for every allow-listed stage.",
						}),
					),
				}),
				execute: async (args, api) => {
					const run = lookup(api.conversationId);
					if (!run) return failure("stage_info: run context unavailable");
					const stage = args.stage?.trim();
					try {
						return text(
							await call(
								run.env,
								stage === undefined || stage === ""
									? AGENT_STAGES_PATH
									: `${AGENT_STAGES_PATH}/${encodeURIComponent(stage)}`,
								READ_TIMEOUT_MS,
								send,
							),
						);
					} catch (error) {
						return failure(
							`stage_info: ${error instanceof Error ? error.message : String(error)}`,
						);
					}
				},
			}),
			defineTool({
				name: "stage_api_request",
				description: [
					"Call a hosted stage's API as one of its roles: the server attaches the role's bearer token and sends the request to that application's configured origin. Use it instead of `browser_run_script` for a `api` application.",
					"`path` is a path of the application (`/v1/requests?limit=5`), never a URL: the host is the one the stage names, and an absolute URL is refused. `query` sends the parameters as an object instead; the two are refused together.",
					"Do not send an `Authorization` header — the server's own token is attached, and an agent-supplied one is refused rather than overwritten.",
					"A `read-only` stage refuses a state-changing method, a request above 64 KiB, and a response above 256 KiB (the body is truncated and `truncated` says so). A `401` is retried once with a renewed token.",
					"The answer is redacted: the status, the response headers on the allow-list, and the body. Learn the token's four presentation fields with `stage_token_info`.",
				].join(" "),
				parameters: Type.Object({
					...TargetParameters,
					method: Type.Union(
						[
							Type.Literal("GET"),
							Type.Literal("HEAD"),
							Type.Literal("POST"),
							Type.Literal("PUT"),
							Type.Literal("PATCH"),
							Type.Literal("DELETE"),
						],
						{ description: "The HTTP method of the call." },
					),
					path: Type.String({
						description:
							"The path of the application, with an optional query string, e.g. `/v1/requests?limit=5`.",
					}),
					query: Type.Optional(
						Type.Record(Type.String(), Type.String(), {
							description:
								"Query parameters of the call, as an object of name to value. Refused together with a `?` inside `path`.",
						}),
					),
					headers: Type.Optional(
						Type.Record(Type.String(), Type.String(), {
							description:
								"Additional request headers. `Authorization`, `host` and `content-length` are refused.",
						}),
					),
					body: Type.Optional(
						Type.String({
							description:
								"The request body, at most 64 KiB. Send JSON as a JSON string.",
						}),
					),
				}),
				execute: async (args, api) => {
					const run = lookup(api.conversationId);
					if (!run)
						return failure("stage_api_request: run context unavailable");
					try {
						const value = await call(
							run.env,
							AGENT_STAGE_API_REQUEST_PATH,
							READ_TIMEOUT_MS,
							send,
							{
								...(args.stage === undefined ? {} : { stage: args.stage }),
								...(args.app === undefined ? {} : { app: args.app }),
								role: args.role,
								method: args.method,
								path: args.path,
								...(args.query === undefined ? {} : { query: args.query }),
								...(args.headers === undefined
									? {}
									: { headers: args.headers }),
								...(args.body === undefined ? {} : { body: args.body }),
							},
						);
						return apiResult(value);
					} catch (error) {
						return failure(
							`stage_api_request: ${error instanceof Error ? error.message : String(error)}`,
						);
					}
				},
			}),
			defineTool({
				name: "stage_token_info",
				description: [
					"Read the four presentation fields of the token one role holds on a stage: `expiresAt` (epoch **milliseconds**, comparable with `Date.now()`), `scopes`, `audience` and `issuer`.",
					"A token that does not exist yet is acquired first, so this is also how to check that a role can obtain one at all.",
					"Nothing else about the token is ever returned — no claim, no subject, no value — so a run can plan around an expiry without ever holding the credential.",
				].join(" "),
				parameters: Type.Object({ ...TargetParameters }),
				execute: async (args, api) => {
					const run = lookup(api.conversationId);
					if (!run) return failure("stage_token_info: run context unavailable");
					try {
						return text(
							await call(
								run.env,
								AGENT_STAGE_TOKEN_INFO_PATH,
								READ_TIMEOUT_MS,
								send,
								{
									...(args.stage === undefined ? {} : { stage: args.stage }),
									...(args.app === undefined ? {} : { app: args.app }),
									role: args.role,
								},
							),
						);
					} catch (error) {
						return failure(
							`stage_token_info: ${error instanceof Error ? error.message : String(error)}`,
						);
					}
				},
			}),
		],
	});
}
