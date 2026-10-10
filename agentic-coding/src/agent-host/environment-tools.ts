// The environment tools of a durable agent run (`add-agent-environment-tools`):
// `agentic.environment` gives every run — read-only verifiers included — the
// seven `env_*` tools that act as its workflow on the environment.
//
// They never shell out to `docker`/`kubectl`: every call goes to the server's
// owner-scoped `/api/v1/agent-env/*` surface with the capability the run
// received in its run environment, so a start waits in the real app slot, a
// stop can only touch this owner's apps, and output is bounded and redacted by
// the server. `env_start` blocks in this process for as long as the app is held
// instead of spending a model turn per poll, and every tool is deliberately not
// replay-safe: after an interruption the agent calls it again rather than the
// host re-issuing a start it cannot see the end of.
import { Type } from "@earendil-works/pi-ai";
import {
	defineExtension,
	defineTool,
	type Extension,
} from "@earendil-works/pi-durable";
import {
	ENVIRONMENT_OWNER_HEADER,
	ENVIRONMENT_TOKEN_ENV,
	ENVIRONMENT_URL_ENV,
	environmentOwnerFor,
} from "./environment-capability.ts";
import type { RunContextLookup } from "./tools.ts";

export const ENVIRONMENT_EXTENSION = "agentic.environment";

/** Tool output bound: a larger view is truncated rather than flooding context. */
const MAX_RESULT_CHARS = 40_000;
/** One acquire long poll; the server's own ceiling for a single request. */
const POLL_WAIT_SEC = 300;
/** `env_start` waits this long by default, and at most two hours. */
const DEFAULT_TIMEOUT_SEC = 30 * 60;
const MAX_TIMEOUT_SEC = 2 * 60 * 60;
/** Read and stop calls answer quickly; a build or a test does not. */
const READ_TIMEOUT_MS = 120_000;
const ACTION_TIMEOUT_MS = 30 * 60_000;

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

/** Test seams: the poll loop's clock and sleep are injected so a wait can be
 * exercised without waiting, and the transport is injectable for a fake
 * server. Production callers pass nothing. */
export interface EnvironmentToolOptions {
	readonly now?: () => number;
	readonly sleep?: (ms: number) => Promise<void>;
	readonly fetch?: typeof fetch;
}

interface EnvironmentBinding {
	readonly url: string;
	readonly token: string;
	readonly owner: string;
}

/** The capability this run presents, or the reason it has none. */
function bindingOf(
	env: Readonly<Record<string, string>>,
): EnvironmentBinding | undefined {
	const url = env[ENVIRONMENT_URL_ENV];
	const token = env[ENVIRONMENT_TOKEN_ENV];
	const workflowId = env.HERDR_WORKFLOW_ID;
	if (!url || !token || !workflowId) return undefined;
	return { url, token, owner: environmentOwnerFor(workflowId) };
}

const NO_BINDING =
	"this run has no agent environment capability (the workflow server did not provide one); the environment tools are unavailable";

/** `env_list` — what the environment holds right now. */
const EnvListParameters = Type.Object({});

/** One app names the request, or a bounded list of the apps needed together.
 * `env_start` is told to name every app it needs in one call, so the server can
 * grant atomically and detect a deadlock the agent would otherwise wait out. */
const AppsParameter = Type.Union([
	Type.String({ minLength: 1, description: "One app ident" }),
	Type.Array(Type.String({ minLength: 1 }), {
		minItems: 1,
		maxItems: 16,
		description:
			"Every app this run needs, in one call: the server grants them together and detects a deadlock it would otherwise wait out",
	}),
]);

const EnvStartParameters = Type.Object({
	apps: AppsParameter,
	target: Type.Optional(
		Type.String({
			description:
				"Run target id or label (from env_list); needed when the app offers several profiles",
		}),
	),
	profile: Type.Optional(
		Type.String({ description: "Run profile from env_list" }),
	),
	runtime: Type.Optional(
		Type.String({
			description:
				"Start only this runtime: docker, shell or systemshell. Docker is the default choice.",
		}),
	),
	replicas: Type.Optional(
		Type.Integer({
			minimum: 1,
			description:
				"An app runs once at a time; only 1 is supported and anything else is refused",
		}),
	),
	timeoutSec: Type.Optional(
		Type.Number({
			maximum: MAX_TIMEOUT_SEC,
			minimum: 1,
			description: `How long to wait for the apps before returning still-waiting (default ${DEFAULT_TIMEOUT_SEC / 60} min, maximum ${MAX_TIMEOUT_SEC / 3600} h)`,
		}),
	),
});

const EnvStatusParameters = Type.Object({
	app: Type.Optional(
		Type.String({ description: "One app; every app when omitted" }),
	),
});

const EnvStopParameters = Type.Object({
	app: Type.String({ minLength: 1, description: "The app to stop" }),
});

const EnvActionParameters = Type.Object({
	app: Type.String({ minLength: 1, description: "The app to build or test" }),
	target: Type.Optional(
		Type.String({ description: "Build or test target id or label" }),
	),
	profile: Type.Optional(Type.String({ description: "Target profile" })),
});

const EnvLogsParameters = Type.Object({
	app: Type.String({ minLength: 1, description: "The app or infra service" }),
	infra: Type.Optional(
		Type.Boolean({ description: "Read app logs only or infra logs only" }),
	),
	service: Type.Optional(
		Type.String({
			description: "One container of the app, by name substring",
		}),
	),
	since: Type.Optional(
		Type.String({
			description:
				"ISO 8601 instant (for example 2026-01-01T00:00:00Z); lines older than it are dropped where the source timestamps them. A value that is not an instant is refused.",
		}),
	),
	grep: Type.Optional(
		Type.String({
			description:
				"A literal substring to keep lines by (not a regular expression)",
		}),
	),
	tail: Type.Optional(
		Type.Number({
			minimum: 1,
			maximum: 1000,
			description:
				"How many of the newest lines to return (default 200, maximum 1000)",
		}),
	),
});

/** `agentic.environment`: the environment tool surface of one durable run. */
export function createEnvironmentExtension(
	lookup: RunContextLookup,
	options: EnvironmentToolOptions = {},
): Extension {
	const now = options.now ?? (() => Date.now());
	const sleep =
		options.sleep ?? ((ms: number) => new Promise((r) => setTimeout(r, ms)));
	const send = options.fetch ?? fetch;

	/** One authenticated call to the server's agent environment surface.
	 * Resolves to the envelope's `value`; rejects with the server's message. */
	const call = async (
		env: Readonly<Record<string, string>>,
		method: "GET" | "POST",
		path: string,
		init: { body?: unknown; timeoutMs: number; signal?: AbortSignal },
	): Promise<unknown> => {
		const binding = bindingOf(env);
		if (!binding) throw new Error(NO_BINDING);
		const signals = [
			AbortSignal.timeout(init.timeoutMs),
			...(init.signal ? [init.signal] : []),
		];
		const response = await send(`${binding.url}${path}`, {
			method,
			headers: {
				authorization: `Bearer ${binding.token}`,
				[ENVIRONMENT_OWNER_HEADER]: binding.owner,
				...(init.body === undefined
					? {}
					: { "content-type": "application/json" }),
			},
			...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }),
			signal: AbortSignal.any(signals),
		});
		const parsed = (await response.json().catch(() => undefined)) as
			| { ok?: boolean; value?: unknown; error?: { message?: string } }
			| undefined;
		if (!response.ok || !parsed || parsed.ok === false || parsed.error)
			throw new Error(
				parsed?.error?.message ??
					`the environment server answered ${response.status}`,
			);
		return parsed.value;
	};

	return defineExtension({
		name: ENVIRONMENT_EXTENSION,
		tools: [
			defineTool({
				name: "env_list",
				description:
					"List this workflow's apps and infrastructure: who holds each app, who is waiting for it, and the run, build and test targets it offers. Read this before starting anything.",
				parameters: EnvListParameters,
				execute: async (_args, api) => {
					const run = lookup(api.conversationId);
					if (!run) return failure("env_list: run context unavailable");
					try {
						return text(
							await call(run.env, "GET", "/api/v1/agent-env/list", {
								timeoutMs: READ_TIMEOUT_MS,
							}),
						);
					} catch (error) {
						return failure(`env_list: ${message(error)}`);
					}
				},
			}),
			defineTool({
				name: "env_start",
				description: [
					"Start every app this run needs for the workflow, and block until the server has started them all.",
					"Name every app you need in one call: the server grants them together and can tell a deadlock from a wait.",
					'Prefer Docker (a compose/container target); ask for `runtime: "shell"` only when the app has no container target and runs as a plain process. One copy of an app runs at a time whatever the runtime, so a second copy is never available.',
					"While an app is held by another workflow this call waits in the queue and reports its position and holder; it returns `still-waiting` with the position once `timeoutSec` elapses — call it again to keep the position. `released-by-developer` means the developer took the app back; `deadlock` means two workflows hold what the other needs — stop an app you hold that the other is waiting for (`env_list` names the holders) and call again, because repeating the same call deadlocks again immediately.",
					"Stop the apps you started when you are done: another workflow may be waiting for them.",
				].join(" "),
				parameters: EnvStartParameters,
				execute: async (args, api, context) => {
					const run = lookup(api.conversationId);
					if (!run) return failure("env_start: run context unavailable");
					if (args.replicas !== undefined && args.replicas !== 1)
						return failure(
							"env_start: an app runs once at a time, so replicas is not supported; ask for the app without replicas",
						);
					const apps =
						typeof args.apps === "string" ? [args.apps] : [...args.apps];
					if (apps.length === 0)
						return failure("env_start: name at least one app");
					const timeoutSec = Math.max(
						1,
						Math.min(MAX_TIMEOUT_SEC, args.timeoutSec ?? DEFAULT_TIMEOUT_SEC),
					);
					const deadline = now() + timeoutSec * 1000;
					for (;;) {
						if (context?.abortSignal?.aborted)
							return failure("env_start: cancelled");
						const remaining = deadline - now();
						// One poll never outlives the caller's own deadline, so a
						// timeout is reported when the agent asked for it rather than
						// after an extra long poll.
						const waitSec = Math.max(
							1,
							Math.min(POLL_WAIT_SEC, Math.ceil(remaining / 1000)),
						);
						let value: Record<string, unknown>;
						try {
							value = (await call(
								run.env,
								"POST",
								"/api/v1/agent-env/acquire",
								{
									// The poll's own deadline is the request timeout: a
									// longer one would outlive the loop that set it.
									timeoutMs: waitSec * 1000 + 30_000,
									signal: context?.abortSignal,
									body: {
										apps,
										...(args.target ? { target: args.target } : {}),
										...(args.profile ? { profile: args.profile } : {}),
										...(args.runtime ? { runtime: args.runtime } : {}),
										waitSec,
									},
								},
							)) as Record<string, unknown>;
						} catch (error) {
							// An abort during the wait is the tool's own outcome, not the
							// transport's raw message: the server withdrew the queue entry.
							if (context?.abortSignal?.aborted)
								return failure("env_start: cancelled");
							return failure(`env_start: ${message(error)}`);
						}
						const outcome = String(value.outcome ?? "");
						if (outcome === "started" || outcome === "already-running")
							return text(value);
						if (outcome === "released-by-developer")
							return failure(
								`env_start: ${String(value.notice ?? "the developer released these apps")}`,
							);
						if (outcome === "deadlock")
							return failure(
								`env_start: ${String(value.message ?? value.cycle ?? "deadlock")}. Stop an app you hold that the other workflow needs (env_list names the holders), then call env_start again; repeating this call deadlocks again.`,
							);
						if (outcome === "cancelled") return failure("env_start: cancelled");
						// Still waiting: report the position and holder as running
						// output, then re-poll. The queue entry survives, so the
						// position is kept across calls.
						const positions = (value.positions ?? {}) as Record<string, number>;
						const holders = (value.holders ?? {}) as Record<string, string>;
						const waiting = apps
							.map((app) => {
								const position = positions[app];
								const holder = holders[app];
								return [
									app,
									position === undefined ? undefined : `position ${position}`,
									holder === undefined ? undefined : `held by ${holder}`,
								]
									.filter((part) => part !== undefined)
									.join(", ");
							})
							.join("; ");
						const leftMs = deadline - now();
						if (leftMs <= 0)
							return text({
								outcome: "still-waiting",
								apps,
								positions,
								holders,
								notice:
									"the apps are still held; call env_start again to keep this position, or do other work and stop with a note",
							});
						api.output(
							`env_start: waiting for ${waiting} (${Math.ceil(leftMs / 1000)}s left)\n`,
						);
						// Yield to the runtime before re-polling, so a long wait
						// streams its progress instead of blocking the event loop.
						await sleep(0);
					}
				},
			}),
			defineTool({
				name: "env_status",
				description:
					"Report who holds each of this workflow's apps, their status, who is waiting, and any notice the developer left (a force release reads `released-by-developer`).",
				parameters: EnvStatusParameters,
				execute: async (args, api) => {
					const run = lookup(api.conversationId);
					if (!run) return failure("env_status: run context unavailable");
					try {
						return text(
							await call(
								run.env,
								"GET",
								`/api/v1/agent-env/status${args.app ? `?app=${encodeURIComponent(args.app)}` : ""}`,
								{ timeoutMs: READ_TIMEOUT_MS },
							),
						);
					} catch (error) {
						return failure(`env_status: ${message(error)}`);
					}
				},
			}),
			defineTool({
				name: "env_stop",
				description:
					"Stop an app this workflow started and release its slot to whoever is waiting. Only the owner of an app may stop it: another workflow's app is refused.",
				parameters: EnvStopParameters,
				execute: async (args, api) => {
					const run = lookup(api.conversationId);
					if (!run) return failure("env_stop: run context unavailable");
					try {
						return text(
							await call(run.env, "POST", "/api/v1/agent-env/stop", {
								timeoutMs: READ_TIMEOUT_MS,
								body: { app: args.app },
							}),
						);
					} catch (error) {
						return failure(`env_stop: ${message(error)}`);
					}
				},
			}),
			defineTool({
				name: "env_build",
				description:
					"Run an app's build action in this workflow's checkout and return its bounded output. Needs no app slot, so it can run while someone else holds the app.",
				parameters: EnvActionParameters,
				execute: async (args, api) => {
					const run = lookup(api.conversationId);
					if (!run) return failure("env_build: run context unavailable");
					try {
						return text(
							await call(run.env, "POST", "/api/v1/agent-env/build", {
								timeoutMs: ACTION_TIMEOUT_MS,
								body: {
									app: args.app,
									...(args.target ? { target: args.target } : {}),
									...(args.profile ? { profile: args.profile } : {}),
								},
							}),
						);
					} catch (error) {
						return failure(`env_build: ${message(error)}`);
					}
				},
			}),
			defineTool({
				name: "env_test",
				description:
					"Run an app's test action in this workflow's checkout and return its bounded output. Needs no app slot, so it can run while someone else holds the app.",
				parameters: EnvActionParameters,
				execute: async (args, api) => {
					const run = lookup(api.conversationId);
					if (!run) return failure("env_test: run context unavailable");
					try {
						return text(
							await call(run.env, "POST", "/api/v1/agent-env/test", {
								timeoutMs: ACTION_TIMEOUT_MS,
								body: {
									app: args.app,
									...(args.target ? { target: args.target } : {}),
									...(args.profile ? { profile: args.profile } : {}),
								},
							}),
						);
					} catch (error) {
						return failure(`env_test: ${message(error)}`);
					}
				},
			}),
			defineTool({
				name: "env_logs",
				description:
					"Read an app's or infrastructure service's logs: Docker containers, a script's log file, or a Kubernetes release. Readable whoever holds the app. `grep` is a literal substring filter (not a regular expression), `tail` returns the newest lines, and both are applied server-side to a bounded window.",
				parameters: EnvLogsParameters,
				execute: async (args, api) => {
					const run = lookup(api.conversationId);
					if (!run) return failure("env_logs: run context unavailable");
					const query = new URLSearchParams({ app: args.app });
					if (args.infra !== undefined)
						query.set("infra", args.infra ? "1" : "0");
					if (args.service) query.set("service", args.service);
					if (args.since) query.set("since", args.since);
					if (args.grep) query.set("grep", args.grep);
					if (args.tail !== undefined) query.set("tail", String(args.tail));
					try {
						return text(
							await call(
								run.env,
								"GET",
								`/api/v1/agent-env/logs?${query.toString()}`,
								{ timeoutMs: READ_TIMEOUT_MS },
							),
						);
					} catch (error) {
						return failure(`env_logs: ${message(error)}`);
					}
				},
			}),
		],
	});
}

function message(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}
