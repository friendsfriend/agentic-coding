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
import { AGENT_STAGES_PATH } from "../server/protocol.ts";
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

/** One authenticated read of the server's owner-scoped stage surface. */
async function call(
	env: Readonly<Record<string, string>>,
	path: string,
	timeoutMs: number,
	send: typeof fetch,
): Promise<unknown> {
	const binding = bindingOf(env);
	if (!binding) throw new Error(NO_BINDING);
	const response = await send(`${binding.url}${path}`, {
		method: "GET",
		headers: {
			authorization: `Bearer ${binding.token}`,
			[ENVIRONMENT_OWNER_HEADER]: binding.owner,
		},
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
			`${parsed?.error?.message ?? `the stage server answered ${response.status}`}${code ? ` [${code}]` : ""}`,
		);
	}
	return parsed.value;
}

export interface StageToolOptions {
	/** Test seam. */
	readonly fetch?: typeof fetch;
}

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
		],
	});
}
