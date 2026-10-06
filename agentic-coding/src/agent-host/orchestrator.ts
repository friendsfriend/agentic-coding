// The Home Orchestrator's tool and prompt surface (orchestrator host mode,
// `host-main.ts --orchestrator`). Every tool calls the unified server through
// the narrower orchestrator capability the TUI writes into the session's run
// environment (`AGENTIC_ORCHESTRATOR_URL` / `AGENTIC_ORCHESTRATOR_TOKEN`); the
// server, not this prompt, enforces what that capability may do
// (`src/server/orchestrator-policy.ts`). The session gets no shell and no file
// writes, so the capability is the only way it can act.
import { Type } from "@earendil-works/pi-ai";
import {
	defineExtension,
	defineTool,
	type Extension,
	section,
} from "@earendil-works/pi-durable";
import { PUBLIC_WORKFLOW_CATALOG } from "../workflow/definitions/catalog.ts";
import {
	ORCHESTRATOR_TOKEN_ENV,
	ORCHESTRATOR_URL_ENV,
} from "./orchestrator-env.ts";
import type { RunContextLookup } from "./tools.ts";

export const ORCHESTRATOR_EXTENSION = "agentic.orchestrator";

/** Tool output bound: a large view is truncated rather than flooding context. */
const MAX_RESULT_CHARS = 60_000;
const REQUEST_TIMEOUT_MS = 60_000;

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

/** One authenticated call to the unified server. Resolves to the envelope's
 * `value`; rejects with the server's own error message. */
async function call(
	env: Readonly<Record<string, string>>,
	method: "GET" | "POST",
	path: string,
	body?: unknown,
): Promise<unknown> {
	const base = env[ORCHESTRATOR_URL_ENV];
	const token = env[ORCHESTRATOR_TOKEN_ENV];
	if (!base || !token)
		throw new Error(
			"no server connection for this session; reopen the Orchestrator page",
		);
	const response = await fetch(`${base}${path}`, {
		method,
		headers: {
			authorization: `Bearer ${token}`,
			...(body === undefined ? {} : { "content-type": "application/json" }),
		},
		...(body === undefined ? {} : { body: JSON.stringify(body) }),
		signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
	});
	const parsed = (await response.json().catch(() => undefined)) as
		| { ok?: boolean; value?: unknown; error?: { message?: string } }
		| undefined;
	if (!response.ok || !parsed || parsed.ok === false || parsed.error)
		throw new Error(
			parsed?.error?.message ?? `server answered ${response.status}`,
		);
	return parsed.value;
}

const observe = (env: Readonly<Record<string, string>>, observation: unknown) =>
	call(env, "POST", "/api/v1/observe", { observation });

/** The compact view of one workflow the orchestrator reasons about: status,
 * step, runs, failures, and what is waiting on the developer. */
export function summarizeWorkflowView(view: Record<string, unknown>): unknown {
	const runs = (view.runs as Array<Record<string, unknown>> | undefined) ?? [];
	const effects =
		(view.effects as Array<Record<string, unknown>> | undefined) ?? [];
	const step = view.currentStep as Record<string, unknown> | undefined;
	const definition = view.definition as Record<string, unknown> | undefined;
	return {
		workflowId: view.workflowId,
		workflowType: definition?.id,
		status: view.status,
		currentStep: step ? { id: step.id, label: step.label } : undefined,
		repository: view.repository,
		worktree: view.worktree,
		branch: view.branch,
		task: view.task,
		preset: view.selectedPreset,
		startedBy: view.startedBy,
		gatePolicies: view.gatePolicies,
		health: view.health,
		availableActions: view.availableActions,
		pendingQuestions: view.pendingQuestions,
		runs: runs.slice(-20).map((run) => ({
			stepId: run.stepId,
			role: run.role,
			attempt: run.attempt,
			status: run.status,
			model: run.model,
		})),
		failedEffects: effects
			.filter((effect) => effect.status === "failed")
			.map((effect) => ({
				id: effect.id,
				kind: effect.kind,
				attempts: effect.attempts,
				lastError: effect.lastError,
			})),
		gateDecisions: view.gateDecisions,
	};
}

const RepoParameter = Type.String({
	minLength: 1,
	maxLength: 4096,
	description:
		"Workflow target: the repository path from list_projects, or the `target` from list_workflows",
});
const WorkflowIdParameter = Type.String({
	minLength: 1,
	maxLength: 128,
	description: "Workflow id",
});

const ORCHESTRATOR_PROMPT = `You are the agentic-coding Orchestrator. You talk with the developer and launch, monitor and manage their coding workflows through your tools.

- Discover before acting: list_projects, list_workflow_types, list_agent_config, list_workflows.
- Choose the workflow type, preset and checkout mode that fit the request; explain the choice briefly, then start it.
- Workflow ids are short, lowercase, kebab-case, and unique per repository.
- Plan approval, developer review, findings review and wiki review always belong to the developer. When a workflow waits on one, tell the developer what is waiting and where; never try to decide it.
- Developer questions from workflow agents are answered by the developer in the workflow dashboard, not by you.
- You may resume paused workflows, retry failed effects, switch presets, drain pending effects, and close or open a pull request for completed work.
- Report what you did and the resulting workflow status. Be concise.`;

/** The orchestrator extension: workflow tools plus the orchestrator prompt. */
export function createOrchestratorExtension(
	lookup: RunContextLookup,
): Extension {
	/** Run one tool body against the calling session's environment. */
	const run =
		<A>(
			body: (
				args: A,
				env: Readonly<Record<string, string>>,
			) => Promise<unknown>,
		) =>
		async (
			args: A,
			api: { conversationId: Parameters<RunContextLookup>[0] },
		) => {
			const context = lookup(api.conversationId);
			if (!context) return failure("orchestrator session context unavailable");
			try {
				return text(await body(args, context.env));
			} catch (error) {
				return failure(error instanceof Error ? error.message : String(error));
			}
		};
	return defineExtension({
		name: ORCHESTRATOR_EXTENSION,
		sections: [
			section("orchestrator", () => ORCHESTRATOR_PROMPT, { tag: false }),
		],
		tools: [
			defineTool({
				name: "list_projects",
				description:
					"List the configured projects (applications and libraries) workflows can run in: name, ident, repository path, OpenSpec support and availability.",
				replay: "safe",
				parameters: Type.Object({}),
				execute: run(async (_args, env) => {
					const projects = (await observe(env, { kind: "projects" })) as Array<
						Record<string, unknown>
					>;
					return projects.map((project) => ({
						ident: project.ident,
						name: project.name,
						repository: project.path,
						openspec: project.openspec,
						available: project.available,
						...(project.detail ? { detail: project.detail } : {}),
					}));
				}),
			}),
			defineTool({
				name: "list_workflow_types",
				description:
					"List the workflow types that can be started, with what each one runs.",
				replay: "safe",
				parameters: Type.Object({}),
				execute: run(async () =>
					PUBLIC_WORKFLOW_CATALOG.map(({ id, label, description }) => ({
						id,
						label,
						description,
					})),
				),
			}),
			defineTool({
				name: "list_agent_config",
				description:
					"List the agent presets (model pools per step, stage gates) and model profiles, optionally as a project's configuration resolves them.",
				replay: "safe",
				parameters: Type.Object({
					repository: Type.Optional(RepoParameter),
				}),
				execute: run(async (args: { repository?: string }, env) => {
					const query = args.repository
						? `?repository=${encodeURIComponent(args.repository)}`
						: "";
					const loaded = (await call(
						env,
						"GET",
						`/api/v1/config/agents${query}`,
					)) as { agents?: Record<string, unknown> };
					const agents = loaded.agents ?? {};
					return {
						defaultProfile: agents.default_profile,
						profiles: agents.profiles,
						presets: agents.presets,
						gates: agents.gates,
					};
				}),
			}),
			defineTool({
				name: "list_branches",
				description: "List the local and remote branches of a repository.",
				replay: "safe",
				parameters: Type.Object({ repo: RepoParameter }),
				execute: run(async (args: { repo: string }, env) =>
					observe(env, { kind: "branches", repo: args.repo }),
				),
			}),
			defineTool({
				name: "list_workflows",
				description:
					"List every durable workflow with its target, status, current step, and agents.",
				replay: "safe",
				parameters: Type.Object({}),
				execute: run(async (_args, env) => {
					const overviews = (await observe(env, {
						kind: "workflows",
					})) as Array<Record<string, unknown>>;
					return overviews.map((overview) => {
						const state = (overview.state ?? {}) as Record<string, unknown>;
						return {
							target: overview.target,
							workflowId: state.workflowId,
							workflowType: (state.definition as { id?: string } | undefined)
								?.id,
							status: state.status,
							step: state.stepLabel ?? state.stepId,
							task: state.task,
							branch: state.branch,
							// Who started the workflow: the session tells its own work from
							// the developer's.
							startedBy: overview.startedBy,
							attention: (state.health as { attention?: string[] } | undefined)
								?.attention,
							availableActions: state.availableActions,
							agents: overview.agents,
						};
					});
				}),
			}),
			defineTool({
				name: "workflow_status",
				description:
					"Read one workflow in detail: status, current step, runs, failed effects, pending developer questions, and available actions.",
				replay: "safe",
				parameters: Type.Object({
					repo: RepoParameter,
					workflowId: WorkflowIdParameter,
				}),
				execute: run(
					async (args: { repo: string; workflowId: string }, env) => {
						const view = (await call(
							env,
							"GET",
							`/api/v1/workflow/view?repo=${encodeURIComponent(args.repo)}&workflowId=${encodeURIComponent(args.workflowId)}`,
						)) as Record<string, unknown>;
						return summarizeWorkflowView(view);
					},
				),
			}),
			defineTool({
				name: "start_workflow",
				description:
					"Start a workflow. Human reviews (plan approval, developer review, wiki review) are always kept for workflows you start.",
				parameters: Type.Object({
					repo: RepoParameter,
					workflowId: Type.String({
						minLength: 1,
						maxLength: 64,
						description: "New workflow id: lowercase kebab-case",
					}),
					workflowType: Type.String({
						description: "A workflow type id from list_workflow_types",
					}),
					task: Type.String({
						minLength: 1,
						maxLength: 16_000,
						description: "The task the workflow's agents work on",
					}),
					mode: Type.Optional(
						Type.Union([Type.Literal("worktree"), Type.Literal("checkout")], {
							description:
								"worktree (default) isolates the work; checkout uses the repository checkout",
						}),
					),
					preset: Type.Optional(
						Type.String({ description: "Agent preset name" }),
					),
					ticket: Type.Optional(Type.String({ maxLength: 128 })),
					sourceBranch: Type.Optional(
						Type.String({ description: "rebase only: branch to rebase" }),
					),
					targetBranch: Type.Optional(
						Type.String({ description: "rebase only: ref to rebase onto" }),
					),
				}),
				execute: run(
					async (
						args: {
							repo: string;
							workflowId: string;
							workflowType: string;
							task: string;
							mode?: "worktree" | "checkout";
							preset?: string;
							ticket?: string;
							sourceBranch?: string;
							targetBranch?: string;
						},
						env,
					) => {
						const message = await call(env, "POST", "/api/v1/workflow/start", {
							repo: args.repo,
							workflowId: args.workflowId,
							workflowType: args.workflowType,
							task: args.task,
							mode: args.mode ?? "worktree",
							...(args.preset ? { preset: args.preset } : {}),
							...(args.ticket ? { ticket: args.ticket } : {}),
							...(args.sourceBranch ? { sourceBranch: args.sourceBranch } : {}),
							...(args.targetBranch ? { targetBranch: args.targetBranch } : {}),
						});
						return message;
					},
				),
			}),
			defineTool({
				name: "workflow_action",
				description:
					"Run a management action on a workflow: resume, retry-effect:<id>, switch-preset (input {preset}), close, or create-pr. Read the current revision with workflow_status first. Review decisions are refused.",
				parameters: Type.Object({
					repo: RepoParameter,
					workflowId: WorkflowIdParameter,
					revision: Type.Integer({ minimum: 0 }),
					actionId: Type.String({ minLength: 1, maxLength: 256 }),
					input: Type.Optional(Type.Unknown()),
				}),
				execute: run(
					async (
						args: {
							repo: string;
							workflowId: string;
							revision: number;
							actionId: string;
							input?: unknown;
						},
						env,
					) => {
						const view = (await call(env, "POST", "/api/v1/workflow/action", {
							repo: args.repo,
							workflowId: args.workflowId,
							revision: args.revision,
							actionId: args.actionId,
							...(args.input === undefined ? {} : { input: args.input }),
						})) as Record<string, unknown>;
						return summarizeWorkflowView(view);
					},
				),
			}),
			defineTool({
				name: "drain_workflow",
				description:
					"Ask the server to execute a workflow's pending effects now (launch agents, run deliveries).",
				parameters: Type.Object({
					repo: RepoParameter,
					workflowId: WorkflowIdParameter,
				}),
				execute: run(
					async (args: { repo: string; workflowId: string }, env) => {
						await call(env, "POST", "/api/v1/workflow/execute", {
							repo: args.repo,
							workflowId: args.workflowId,
						});
						return "execution requested";
					},
				),
			}),
		],
	});
}
