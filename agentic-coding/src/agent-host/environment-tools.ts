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
import path from "node:path";
import { Type } from "@earendil-works/pi-ai";
import {
	defineExtension,
	defineTool,
	type Extension,
} from "@earendil-works/pi-durable";
import {
	AGENT_EVIDENCE_ATTACH_PATH,
	AGENT_EVIDENCE_LIST_PATH,
} from "../server/protocol.ts";
import { readActionProgress } from "./action-progress.ts";
import {
	environmentBindingOf as bindingOf,
	ENVIRONMENT_OWNER_HEADER,
} from "./environment-capability.ts";
import { withoutBlankOptionals } from "./optional-arguments.ts";
import { boundedToolLog, toolViewDetails } from "./tool-view-details.ts";
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
	details?: ReturnType<typeof toolViewDetails>;
	output: Array<{ type: "text"; text: string }>;
	isError?: boolean;
};

function text(value: unknown): Result {
	value = boundedToolLog(value, MAX_RESULT_CHARS);
	const raw =
		typeof value === "string"
			? value
			: JSON.stringify(
					value,
					null,
					value && typeof value === "object" && "output" in value
						? undefined
						: 2,
				);
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

/** Test seams: the poll loop's clock and sleep are injected so a wait can be
 * exercised without waiting, and the transport is injectable for a fake
 * server. Production callers pass nothing. */
export interface EnvironmentToolOptions {
	readonly now?: () => number;
	readonly sleep?: (ms: number) => Promise<void>;
	readonly fetch?: typeof fetch;
}

const NO_BINDING =
	"this run has no agent environment capability (the workflow server did not provide one); the environment tools are unavailable";

/** `env_list` — what the environment holds right now. The default answer is
 * compact; `detail: "full"` (or naming one app) returns the long form. */
const EnvListParameters = Type.Object({
	app: Type.Optional(
		Type.String({
			minLength: 1,
			description:
				"One app's own full listing, instead of every app's compact one",
		}),
	),
	detail: Type.Optional(
		Type.Literal("full", {
			description:
				"Every app's full targets, with the ids and the reason behind each default",
		}),
	),
});

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
				"Start only this runtime: docker, shell, systemshell or kubernetes. Docker is the default choice; `kubernetes` is the opt-in path for a problem that needs several replicas.",
		}),
	),
	replicas: Type.Optional(
		Type.Integer({
			minimum: 1,
			description:
				'Replica count of a Kubernetes run; it needs `runtime: "kubernetes"` (or a Kubernetes target) and is refused for any other runtime. Use it only when the problem depends on more than one replica: the cluster run is the slow, opt-in path.',
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

/** `evidence_attach`: store one file this run produced. `path` is resolved
 * against the run's own working directory and re-checked on the server, which
 * refuses anything outside the workflow's checkout or data directory. */
const EvidenceAttachParameters = Type.Object({
	path: Type.String({
		minLength: 1,
		description:
			"The file to store: absolute, or relative to this run's working directory. It must be a file this run produced inside its own checkout or scratch directory.",
	}),
	kind: Type.Union(
		[
			Type.Literal("screenshot"),
			Type.Literal("video"),
			Type.Literal("trace"),
			Type.Literal("script"),
			Type.Literal("log"),
			Type.Literal("other"),
		],
		{
			description:
				"What the file is. The content must match: screenshot is PNG/JPEG/WebP, video is WebM/MP4, trace is a ZIP, script and log are text.",
		},
	),
	caption: Type.String({
		minLength: 1,
		description:
			"One line the developer will read next to the evidence, saying what it shows.",
	}),
	requestId: Type.Optional(
		Type.String({
			description:
				"Store it under one debug request's evidence when it belongs to one.",
		}),
	),
	report: Type.Optional(
		Type.Boolean({
			description:
				"Mark this file as the run's markdown report: kind other, a .md/.markdown text file. The newest flagged entry is the report the dashboard reads beside the evidence list; the flag needs no new kind and no rename of the stored path.",
		}),
	),
});

/** `evidence_list`: what this workflow has already stored. */
const EvidenceListParameters = Type.Object({
	requestId: Type.Optional(
		Type.String({
			description:
				"Only this debug request's evidence; all of it when omitted.",
		}),
	),
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

/** One refused environment call. The server's own code (`run-exited`,
 * `run-max-wait`, `deadlock`, …) is what a caller branches on, so it is carried
 * rather than folded into prose. */
class EnvironmentCallError extends Error {
	readonly code: string;
	constructor(code: string, message: string) {
		super(message);
		this.name = "EnvironmentCallError";
		this.code = code;
	}
}

/** The failure line one refused call reports: the server's code first, so a
 * start that died during startup reads `env_start: run-exited: ...` and an agent
 * can tell it from a transport failure. */
function callFailure(prefix: string, error: unknown): string {
	if (error instanceof EnvironmentCallError)
		return `${prefix}: ${error.code}: ${error.message}`;
	return `${prefix}: ${message(error)}`;
}

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
		init: {
			body?: unknown;
			timeoutMs: number;
			signal?: AbortSignal;
			onProgress?: (value: unknown) => Promise<void>;
		},
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
				...(init.onProgress ? { accept: "application/x-ndjson" } : {}),
				authorization: `Bearer ${binding.token}`,
				[ENVIRONMENT_OWNER_HEADER]: binding.owner,
				...(init.body === undefined
					? {}
					: { "content-type": "application/json" }),
			},
			...(init.body === undefined
				? {}
				: { body: JSON.stringify(withoutBlankOptionals(init.body)) }),
			signal: AbortSignal.any(signals),
		});
		if (
			response.ok &&
			init.onProgress &&
			response.headers.get("content-type")?.includes("application/x-ndjson")
		)
			return readActionProgress(response, init.onProgress);
		const parsed = (await response.json().catch(() => undefined)) as
			| {
					ok?: boolean;
					value?: unknown;
					error?: { code?: string; message?: string };
			  }
			| undefined;
		if (!response.ok || !parsed || parsed.ok === false || parsed.error)
			throw new EnvironmentCallError(
				parsed?.error?.code ?? `http-${response.status}`,
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
				description: [
					"List this workflow's apps and infrastructure: who holds each app, who is waiting for it, the run, build and test targets it offers, and the configured infrastructure services with their kind, ports, state and whether db_query can use them. Read this before starting anything.",
					'The answer is compact by default (targets as targetId/label/action/runtime/default/availability); pass `detail: "full"`, or name one `app`, for the ids and the reason behind each default.',
				].join(" "),
				parameters: EnvListParameters,
				execute: async (args, api) => {
					const run = lookup(api.conversationId);
					if (!run) return failure("env_list: run context unavailable");
					const query = new URLSearchParams();
					if (args.app) query.set("app", args.app);
					if (args.detail) query.set("detail", args.detail);
					try {
						return text(
							await call(
								run.env,
								"GET",
								`/api/v1/agent-env/list${query.size > 0 ? `?${query}` : ""}`,
								{ timeoutMs: READ_TIMEOUT_MS },
							),
						);
					} catch (error) {
						return failure(callFailure("env_list", error));
					}
				},
			}),
			defineTool({
				name: "env_start",
				description: [
					"Start every app this run needs for the workflow, and block until the server has started them all.",
					"Name every app you need in one call: the server grants them together and can tell a deadlock from a wait.",
					'Prefer Docker (a compose/container target); ask for `runtime: "shell"` only when the app has no container target and runs as a plain process. One copy of an app runs at a time whatever the runtime, so a second copy is never available.',
					'Ask for `runtime: "kubernetes"` with `replicas` only when the problem depends on more than one replica (locking, caching, scheduled jobs, session affinity): the cluster run is the slow, opt-in path, and it fails with `cluster-unavailable` when the cluster does not exist rather than creating one.',
					"While an app is held by another workflow this call waits in the queue and reports its position and holder; it returns `still-waiting` with the position once `timeoutSec` elapses — call it again to keep the position. `released-by-developer` means the developer took the app back; `deadlock` means two workflows hold what the other needs — stop an app you hold that the other is waiting for (`env_list` names the holders) and call again, because repeating the same call deadlocks again immediately.",
					"Stop the apps you started when you are done: another workflow may be waiting for them.",
					"A run whose process dies during startup fails the call with `run-exited` and the run's own exit status and last output lines; nothing is held and nothing needs stopping.",
				].join(" "),
				parameters: EnvStartParameters,
				execute: async (args, api, context) => {
					const run = lookup(api.conversationId);
					if (!run) return failure("env_start: run context unavailable");
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
										...(args.replicas === undefined
											? {}
											: { replicas: args.replicas }),
										waitSec,
									},
								},
							)) as Record<string, unknown>;
						} catch (error) {
							// An abort during the wait is the tool's own outcome, not the
							// transport's raw message: the server withdrew the queue entry.
							if (context?.abortSignal?.aborted)
								return failure("env_start: cancelled");
							return failure(callFailure("env_start", error));
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
					"Report who holds each of this workflow's apps, their status, who is waiting, and any notice the developer left (a force release reads `released-by-developer`). Each app also carries its `run`: the runtime, the run's own status and, for a run that already ended, its exit code and the last output lines.",
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
						return failure(callFailure("env_status", error));
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
						return failure(callFailure("env_stop", error));
					}
				},
			}),
			defineTool({
				name: "env_build",
				description:
					"Run an app's build action in this workflow's checkout and return its bounded output. Needs no app slot, so it can run while someone else holds the app.",
				parameters: EnvActionParameters,
				execute: async (args, api, context) => {
					const run = lookup(api.conversationId);
					if (!run) return failure("env_build: run context unavailable");
					try {
						return text(
							await call(run.env, "POST", "/api/v1/agent-env/build", {
								timeoutMs: ACTION_TIMEOUT_MS,
								signal: context.abortSignal,
								onProgress: async (value) => {
									const details = toolViewDetails(
										boundedToolLog(value, MAX_RESULT_CHARS),
										MAX_RESULT_CHARS,
									);
									if (details) await api.details(details, context);
								},
								body: {
									app: args.app,
									...(args.target ? { target: args.target } : {}),
									...(args.profile ? { profile: args.profile } : {}),
								},
							}),
						);
					} catch (error) {
						return failure(callFailure("env_build", error));
					}
				},
			}),
			defineTool({
				name: "env_test",
				description:
					"Run an app's test action in this workflow's checkout and return its bounded output. Needs no app slot, so it can run while someone else holds the app.",
				parameters: EnvActionParameters,
				execute: async (args, api, context) => {
					const run = lookup(api.conversationId);
					if (!run) return failure("env_test: run context unavailable");
					try {
						return text(
							await call(run.env, "POST", "/api/v1/agent-env/test", {
								timeoutMs: ACTION_TIMEOUT_MS,
								signal: context.abortSignal,
								onProgress: async (value) => {
									const details = toolViewDetails(
										boundedToolLog(value, MAX_RESULT_CHARS),
										MAX_RESULT_CHARS,
									);
									if (details) await api.details(details, context);
								},
								body: {
									app: args.app,
									...(args.target ? { target: args.target } : {}),
									...(args.profile ? { profile: args.profile } : {}),
								},
							}),
						);
					} catch (error) {
						return failure(callFailure("env_test", error));
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
						return failure(callFailure("env_logs", error));
					}
				},
			}),
			defineTool({
				name: "evidence_attach",
				description: [
					"Store one file this run produced — a screenshot, video, trace, repro script or log — so it outlives this turn and the developer can review it.",
					"The file must be inside this run's own checkout or scratch directory: the server resolves it and refuses anything outside, so never attach a file you only read from elsewhere.",
					"The content must match the kind, and the store refuses a file over its cap (video 100 MB, other 20 MB) or one that would exceed the workflow's total; nothing already stored is ever deleted to make room.",
					"Set `report` on a markdown file to make it the run's report: the dashboard renders it beside the evidence it cites with `[^<evidence-id>]` markers.",
				].join(" "),
				parameters: EvidenceAttachParameters,
				execute: async (args, api) => {
					const run = lookup(api.conversationId);
					if (!run) return failure("evidence_attach: run context unavailable");
					try {
						return text(
							await call(run.env, "POST", AGENT_EVIDENCE_ATTACH_PATH, {
								timeoutMs: ACTION_TIMEOUT_MS,
								body: {
									// A path the agent wrote is relative to its own working
									// directory; the server never resolves a caller path itself.
									path: path.resolve(run.cwd, args.path),
									kind: args.kind,
									caption: args.caption,
									...(args.requestId || run.env.HERDR_DEBUG_REQUEST_ID
										? {
												// A delegated debug run files its evidence under its request
												// without having to repeat the id: the run environment carries it
												// (add-debug-subagent-requests).
												requestId:
													args.requestId ?? run.env.HERDR_DEBUG_REQUEST_ID,
											}
										: {}),
									// The producing step and role come from this run's own
									// environment, so the manifest records who attached it.
									...(run.env.HERDR_STEP_ID
										? { step: run.env.HERDR_STEP_ID }
										: {}),
									...(run.env.HERDR_ROLE ? { role: run.env.HERDR_ROLE } : {}),
									...(args.report ? { report: true } : {}),
								},
							}),
						);
					} catch (error) {
						return failure(`evidence_attach: ${message(error)}`);
					}
				},
			}),
			defineTool({
				name: "evidence_list",
				description:
					"List the evidence this workflow has stored: the manifest entries with their id, kind, caption, step and role. Read it before attaching so the same evidence is not stored twice.",
				parameters: EvidenceListParameters,
				execute: async (args, api) => {
					const run = lookup(api.conversationId);
					if (!run) return failure("evidence_list: run context unavailable");
					const query = args.requestId
						? `?requestId=${encodeURIComponent(args.requestId)}`
						: "";
					try {
						return text(
							await call(
								run.env,
								"GET",
								`${AGENT_EVIDENCE_LIST_PATH}${query}`,
								{ timeoutMs: READ_TIMEOUT_MS },
							),
						);
					} catch (error) {
						return failure(`evidence_list: ${message(error)}`);
					}
				},
			}),
		],
	});
}

function message(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}
