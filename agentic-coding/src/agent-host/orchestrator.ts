// The Home Orchestrator's workflow-management tool and prompt surface
// (orchestrator host mode, `host-main.ts --orchestrator`). Every tool here
// calls the unified server through the narrower orchestrator capability the
// TUI writes into the session's run environment (`AGENTIC_ORCHESTRATOR_URL` /
// `AGENTIC_ORCHESTRATOR_TOKEN`); the server, not this prompt, enforces what
// that capability may do (`src/server/orchestrator-policy.ts`). The session
// also gets the full coding tools (read/write/edit/bash, wired in `host.ts`)
// so it can decide for itself whether a request is a direct edit or a
// workflow to launch; those tools act on the local filesystem directly, not
// through the server capability.
import { Type } from "@earendil-works/pi-ai";
import {
	defineExtension,
	defineTool,
	type Extension,
	section,
} from "@earendil-works/pi-durable";
import { PUBLIC_WORKFLOW_CATALOG } from "../workflow/definitions/catalog.ts";
import {
	cachedBranchRefs,
	compactWorkflowStatus,
	compactWorkflowStatusView,
	invalidateBranchCache,
	noteFullDetail,
	pendingQuestionUnion,
	projectAgentConfig,
	projectWorkflowList,
	type WorkflowListStatus,
} from "./orchestrator-compact.ts";
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
	// Compact JSON: every result is re-sent on each later turn of the
	// conversation, so indentation is paid for again and again (efficiency
	// backlog item 5).
	const raw = typeof value === "string" ? value : JSON.stringify(value);
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

/** The full view of one workflow, returned only with `detail: "full"`: status,
 * step, the task text, runs, failures, gate decisions and what is waiting on
 * the developer. */
export function summarizeWorkflowView(view: Record<string, unknown>): unknown {
	const runs = (view.runs as Array<Record<string, unknown>> | undefined) ?? [];
	const effects =
		(view.effects as Array<Record<string, unknown>> | undefined) ?? [];
	const step = view.currentStep as Record<string, unknown> | undefined;
	const definition = view.definition as Record<string, unknown> | undefined;
	return {
		workflowId: view.workflowId,
		// Pass this as `revision` to workflow_action; a stale value is rejected.
		revision: view.revision,
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
		// Developer questions routed to you first are folded in here (answer with
		// workflow_action `answer-question`, or hand them to the developer with
		// `forward-question`): the server's separate `orchestratorQuestions` copy
		// duplicated the same records, so the deduplicated union is the one list.
		pendingQuestions: pendingQuestionUnion(view),
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
		"Workflow target: any existing repository path on this machine (an absolute path, or one relative to your working directory), not only a path from list_projects or list_workflows",
});
const WorkflowIdParameter = Type.String({
	minLength: 1,
	maxLength: 128,
	description: "Workflow id",
});

/** The blueprint tool's parameter schema: the logical shape the model authors
 * and the server compiles (add-orchestrator-blueprint-workflows). The caps
 * mirror the server's decode bounds so an oversized document is refused here
 * with the model's own arguments rather than as a server diagnostic. */
const BlueprintStepParameter = Type.String({
	minLength: 1,
	maxLength: 256,
	description: "A logical step id from list_steps",
});
const BlueprintParameter = Type.Object(
	{
		label: Type.String({
			minLength: 1,
			maxLength: 256,
			description: "Short human label for the workflow shape",
		}),
		rationale: Type.String({
			minLength: 1,
			maxLength: 4096,
			description:
				"Why this shape fits the request; the developer reads it in every review",
		}),
		traits: Type.Object({
			changeArtifacts: Type.Union([
				Type.Literal("openspec"),
				Type.Literal("none"),
			]),
			planning: Type.Union([
				Type.Literal("none"),
				Type.Literal("single"),
				Type.Literal("fusion"),
			]),
			changeIdentity: Type.Union([
				Type.Literal("planned"),
				Type.Literal("workflow-id"),
				Type.Literal("none"),
			]),
			delivery: Type.Union([
				Type.Literal("pull-request"),
				Type.Literal("none"),
			]),
			startRequirements: Type.Array(
				Type.Union([
					Type.Literal("task"),
					Type.Literal("clean-tree"),
					Type.Literal("openspec-project"),
					Type.Literal("openspec-change"),
					Type.Literal("base-commit"),
					Type.Literal("rebase-refs"),
				]),
				{ maxItems: 6 },
			),
			openspecVerifier: Type.Boolean(),
		}),
		checkoutRequired: Type.Optional(
			Type.Boolean({
				description:
					"true when the workflow runs in the repository checkout instead of an isolated worktree",
			}),
		),
		verificationRounds: Type.Integer({
			minimum: 1,
			description:
				"Verification round budget; the core.verification fix edge must loop exactly this many times",
		}),
		steps: Type.Array(BlueprintStepParameter, {
			maxItems: 64,
			description: "The logical steps, from list_steps",
		}),
		edges: Type.Array(
			Type.Object({
				from: BlueprintStepParameter,
				outcome: Type.String({ minLength: 1, maxLength: 256 }),
				to: BlueprintStepParameter,
				loop: Type.Optional(
					Type.Object({ maxAttempts: Type.Integer({ minimum: 1 }) }),
				),
			}),
			{ maxItems: 256 },
		),
	},
	{
		description:
			"A workflow shape the server compiles; routing, gates and human reviews are inserted by the server",
	},
);

const START_WORKFLOW_CHECKLIST =
	"repository/project → task (goal, constraints, acceptance) → workflow type and why → agent preset/model profile → mode (worktree or checkout) → branch/base → ticket → `app` for env-setup";

export const ORCHESTRATOR_PROMPT = `You are the agentic-coding Orchestrator. You talk with the developer, make direct edits with your own coding tools (read/write/edit/bash) and launch, monitor and manage coding workflows through your other tools.

- Default to acting yourself, immediately, with read/write/edit/bash: looking something up (files, directories, OpenSpec changes/specs, git state, logs, anything readable) is never a reason to start a workflow or to ask the developer first — read it and answer. The same goes for a small, well-understood edit you can make and verify yourself. Only reach for a workflow when the request needs planning, a developer/plan/findings/wiki review, several coordinated agent steps, or a durable record of the work; say briefly why a workflow fits when you choose one.
- A workflow target (\`repo\`) is any existing path on this machine, not only one from list_projects or list_workflows; list_projects/list_workflows are for discovering what is already configured and running, not a restriction on where you may work or look.
- Discover before acting: list_projects, list_workflow_types, list_agent_config, list_workflows.
- Before you start a workflow, establish with the developer in this order: ${START_WORKFLOW_CHECKLIST}. list_agent_config shows preset/model-profile choices; respect an existing developer default and ask only if none is set or the request implies a different choice. Read project lists, branches, workflow state and presets yourself; do not ask the developer for facts you can read.
- An \`env-setup\` workflow authors the environment definitions (run/build/test/infrastructure) for one configured application: name that application's ident as \`app\` when you start one — list_projects reports them with their \`kind\` (\`app\` runs, \`library\` does not). Every other type refuses an \`app\`.
- Prefer a built-in workflow type when one fits. When none does, shape one: list_steps gives the logical steps you may compose, validate_blueprint compiles a candidate and answers with its summary or the reasons it was refused, and start_workflow takes the validated blueprint instead of a workflow type. Always validate before starting a blueprint, and state the rationale to the developer: every shape you start keeps its human reviews.
- Choose the workflow type, preset and checkout mode that fit the request; explain the choice briefly, then start it.
- Workflow ids are short, lowercase, kebab-case, and unique per repository.
- Plan approval, developer review, findings review and wiki review always belong to the developer. When a workflow waits on one, tell the developer what is waiting and where; never try to decide it.
- Developer questions from the workflows you started are routed to you first and appear in \`pendingQuestions\` in workflow_status (their record carries \`targetRole: "orchestrator"\`; there is no separate orchestrator list). Answer one from the design you and the developer agreed with workflow_action \`answer-question\` (input is the question answer, e.g. {questionId, kind:"custom", value:"..."} or {questionId, kind:"option", value:"<option value>"}). When you cannot answer from that shared design, hand it to the developer with workflow_action \`forward-question\` (input {questionId} or {groupId}); never guess. Unanswered questions auto-forward to the developer on timeout.
- workflow_status answers a compact row by default; poll it with \`sinceRevision\` set to the revision of the last answer, so a poll of an unchanged workflow costs a few bytes. The task text, the full run history and the gate decisions are not in that row: ask for the task with \`includeTask: true\` and for everything with \`detail: "full"\`, only when you actually need it.
- You may resume paused workflows, retry failed effects, switch presets, drain pending effects, and close or open a pull request for completed work.
- Workflow events: the monitor delivers subscribed events to you as notes whose first line is "[workflow-monitor] subs=<labels>" followed by one line per event, "- <workflowId> → <stepId> (<what changed>)". The subs= list names the subscriptions that asked for the note; if you have no subscription of your own it reads subs=default, the monitor's own default, which list_subscriptions shows. The notifications the developer needs (a review waiting, a pending developer question) always reach the shell whatever you subscribe to. Use subscribe_events to choose what wakes you (mode wake for immediate coalesced notes, digest for one note per interval, silent to record without delivering), list_subscriptions to see them, unsubscribe_events to remove one, and read_events to pull recorded events since a cursor when you would rather poll than be woken. Every subscription expires, so give it a label, a reason and an expiry or an until-condition. Completion and progress events (workflow.completed, step.*, run.completed) are severity info, so minSeverity "warning" excludes them: to be told when a workflow finishes, name the terminal events in eventIds (workflow.completed, workflow.failed, workflow.closed) or pass minSeverity "info".
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
					"Use to discover configured targets before choosing a repository or an `env-setup` app; returns each app/library's name, ident, path, kind, OpenSpec support and availability. An `env-setup` app must be a configured `app` ident from this list.",
				replay: "safe",
				parameters: Type.Object({}),
				execute: run(async (_args, env) => {
					const projects = (await observe(env, { kind: "projects" })) as Array<
						Record<string, unknown>
					>;
					return projects.map((project) => ({
						ident: project.ident,
						name: project.name,
						kind: project.kind,
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
					"Use to choose a built-in workflow before shaping a blueprint; returns each startable type's id, label and purpose.",
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
					'Use to inspect preset/model-profile choices before selecting a workflow preset; returns the default profile, the profile and preset names and the gate table, optionally resolved for `repository`. Pass detail:"full" for the complete profile and preset tables when you need to see which models a profile or a preset pool names.',
				replay: "safe",
				parameters: Type.Object({
					repository: Type.Optional(RepoParameter),
					detail: Type.Optional(
						Type.Union([Type.Literal("full")], {
							description:
								'"full" returns the full profile and preset tables instead of their names.',
						}),
					),
				}),
				execute: run(
					async (args: { repository?: string; detail?: "full" }, env) => {
						if (args.detail === "full")
							noteFullDetail(env, "list_agent_config");
						const query = args.repository
							? `?repository=${encodeURIComponent(args.repository)}`
							: "";
						const loaded = (await call(
							env,
							"GET",
							`/api/v1/config/agents${query}`,
						)) as { agents?: Record<string, unknown> };
						return projectAgentConfig(loaded.agents ?? {}, args);
					},
				),
			}),
			defineTool({
				name: "list_branches",
				description:
					"Use before choosing a branch or base for a workflow; returns the repository's local and remote branch refs compactly (current, local, remote, default), reusing an identical answer for 30 s — a workflow start clears that reuse.",
				replay: "safe",
				parameters: Type.Object({ repo: RepoParameter }),
				execute: run(async (args: { repo: string }, env) =>
					cachedBranchRefs(args.repo, () =>
						observe(env, { kind: "branches", repo: args.repo }),
					),
				),
			}),
			defineTool({
				name: "list_workflows",
				description:
					'Use to find existing workflows before starting or managing one; returns one compact row per workflow — workflowId, target, workflowType, status, step, branch, who started it and an attention count — for every workflow that is not closed. Pass status:"all" to include closed workflows (or "active" (includes paused)|"attention"|"completed"|"closed" to narrow), and detail:"full" for the task text, the attention text, the available actions and the agents.',
				replay: "safe",
				parameters: Type.Object({
					status: Type.Optional(
						Type.Union(
							[
								Type.Literal("active"),
								Type.Literal("attention"),
								Type.Literal("completed"),
								Type.Literal("closed"),
								Type.Literal("all"),
							],
							{
								description:
									"Filter: active (includes paused), attention, completed, closed, or all. Default: everything that is not closed.",
							},
						),
					),
					detail: Type.Optional(
						Type.Union([Type.Literal("full")], {
							description:
								'"full" adds the task text, the attention text, the available actions and the agents.',
						}),
					),
				}),
				execute: run(
					async (
						args: { status?: WorkflowListStatus; detail?: "full" },
						env,
					) => {
						if (args.detail === "full") noteFullDetail(env, "list_workflows");
						const overviews = (await observe(env, {
							kind: "workflows",
						})) as Array<Record<string, unknown>>;
						return projectWorkflowList(overviews, args);
					},
				),
			}),
			defineTool({
				name: "sessions_report",
				description:
					"Use to diagnose agent efficiency over recent runs (default 7d); returns role/profile/family aggregates for turns, tools, failures, blocked/abandoned runs and cost, plus ranked content-free findings. Findings distinguish prompt, config, engine and task issues; no session or task text is included.",
				replay: "safe",
				parameters: Type.Object({
					since: Type.Optional(
						Type.String({
							description:
								"Window length as <number><unit>, unit one of s/m/h/d. Default 7d.",
						}),
					),
				}),
				execute: run(async (args: { since?: string }, env) =>
					observe(env, { kind: "sessions-report", since: args.since }),
				),
			}),
			defineTool({
				name: "workflow_status",
				description:
					'Use to inspect one workflow or before an action; returns one compact row — workflowId, target, status, step, attention, current revision, pending questions (the ones routed to you included), available action ids and labels, failed effects, and the current run\'s role/status/model. The task text, the full run history and the gate decisions are NOT in the row: pass detail:"full" for the whole view, or includeTask:true for the task text alone. Pass sinceRevision equal to the previous answer\'s revision and an unchanged workflow answers in a few bytes ("unchanged", revision, status, step).',
				replay: "safe",
				parameters: Type.Object({
					repo: RepoParameter,
					workflowId: WorkflowIdParameter,
					sinceRevision: Type.Optional(
						Type.Integer({
							minimum: 0,
							description:
								"Revision of the previous answer; an unchanged workflow answers with a few bytes instead of the row.",
						}),
					),
					detail: Type.Optional(
						Type.Union([Type.Literal("full")], {
							description:
								'"full" returns the whole view: the task text, the run history, the gate decisions, health and every other field.',
						}),
					),
					includeTask: Type.Optional(
						Type.Boolean({
							description:
								"Include the task text in the compact row (it is the largest field of a task).",
						}),
					),
				}),
				execute: run(
					async (
						args: {
							repo: string;
							workflowId: string;
							sinceRevision?: number;
							detail?: "full";
							includeTask?: boolean;
						},
						env,
					) => {
						const view = (await call(
							env,
							"GET",
							`/api/v1/workflow/view?repo=${encodeURIComponent(args.repo)}&workflowId=${encodeURIComponent(args.workflowId)}`,
						)) as Record<string, unknown>;
						if (args.detail === "full") {
							noteFullDetail(env, "workflow_status");
							return summarizeWorkflowView(view);
						}
						return compactWorkflowStatus(view, args);
					},
				),
			}),
			defineTool({
				name: "list_steps",
				description:
					"Use when no built-in type fits and you are shaping a blueprint; returns composable step ids, labels, actors, outcomes and descriptions. The server inserts routing and gates.",
				replay: "safe",
				parameters: Type.Object({}),
				execute: run(async (_args, env) =>
					call(env, "GET", "/api/v1/workflow/steps"),
				),
			}),
			defineTool({
				name: "validate_blueprint",
				description:
					"Use to validate every candidate blueprint before starting it; compiles without side effects and returns its digest/summary or refusal diagnostics. A blueprint must be validated first.",
				replay: "safe",
				parameters: Type.Object({ blueprint: BlueprintParameter }),
				execute: run(async (args: { blueprint: unknown }, env) =>
					call(env, "POST", "/api/v1/workflow/blueprint/validate", {
						blueprint: args.blueprint,
					}),
				),
			}),
			defineTool({
				name: "start_workflow",
				description: `Use only after establishing with the developer, in order: ${START_WORKFLOW_CHECKLIST}; list_agent_config shows preset/model-profile choices; honor an existing developer default and ask only if none is set or the request implies another. Read project lists, branches, workflow state and presets yourself—do not ask for facts you can read; validate blueprints first, provide both sourceBranch and targetBranch for rebase and a configured app for env-setup; returns the start result with human reviews retained.`,
				parameters: Type.Object({
					repo: RepoParameter,
					workflowId: Type.String({
						minLength: 1,
						maxLength: 64,
						description: "New workflow id: lowercase kebab-case",
					}),
					workflowType: Type.Optional(
						Type.String({
							description:
								"A built-in workflow type id from list_workflow_types; mutually exclusive with blueprint. Rebase requires sourceBranch and targetBranch.",
						}),
					),
					blueprint: Type.Optional(BlueprintParameter),
					task: Type.String({
						minLength: 1,
						maxLength: 16_000,
						description:
							"Task agreed with the developer: goal, constraints and acceptance criteria.",
					}),
					mode: Type.Optional(
						Type.Union([Type.Literal("worktree"), Type.Literal("checkout")], {
							description:
								"Choose `worktree` (default) for isolation or `checkout` to use the repository checkout.",
						}),
					),
					preset: Type.Optional(
						Type.String({
							description:
								"Agent preset name; list_agent_config shows presets and the model profiles they use. Omit to use configured workflow defaults.",
						}),
					),
					app: Type.Optional(
						Type.String({
							minLength: 1,
							maxLength: 128,
							description:
								"The configured application an `env-setup` workflow drafts definitions for, by the ident list_projects reports (`kind` `app`). Required for workflowType `env-setup`; refused for every other type.",
						}),
					),
					ticket: Type.Optional(
						Type.String({
							maxLength: 128,
							description:
								"Optional ticket or issue reference for the workflow.",
						}),
					),
					sourceBranch: Type.Optional(
						Type.String({
							description:
								"For rebase, the source branch being rebased (required with targetBranch); for debug, the branch to investigate.",
						}),
					),
					targetBranch: Type.Optional(
						Type.String({
							description:
								"For rebase, the target ref to rebase onto (required with sourceBranch).",
						}),
					),
				}),
				execute: run(
					async (
						args: {
							repo: string;
							workflowId: string;
							workflowType?: string;
							blueprint?: unknown;
							task: string;
							mode?: "worktree" | "checkout";
							preset?: string;
							app?: string;
							ticket?: string;
							sourceBranch?: string;
							targetBranch?: string;
						},
						env,
					) => {
						if (args.blueprint !== undefined && args.workflowType !== undefined)
							throw new Error(
								"start_workflow takes a workflowType or a blueprint, not both",
							);
						if (args.blueprint === undefined && args.workflowType === undefined)
							throw new Error(
								"start_workflow needs a workflowType or a validated blueprint",
							);
						const message = await call(env, "POST", "/api/v1/workflow/start", {
							repo: args.repo,
							workflowId: args.workflowId,
							...(args.blueprint === undefined
								? { workflowType: args.workflowType }
								: { blueprint: args.blueprint }),
							task: args.task,
							mode: args.mode ?? "worktree",
							...(args.preset ? { preset: args.preset } : {}),
							// The env-setup family's subject: the configured app whose environment
							// definitions the workflow drafts. The server validates it against the
							// configured applications, so an unknown ident is refused before a
							// workflow exists.
							...(args.app ? { app: args.app } : {}),
							...(args.ticket ? { ticket: args.ticket } : {}),
							...(args.sourceBranch ? { sourceBranch: args.sourceBranch } : {}),
							...(args.targetBranch ? { targetBranch: args.targetBranch } : {}),
						});
						// A start can create the workflow's branch, so the cached branch
						// lists of every repository are dropped before the next poll.
						invalidateBranchCache();
						return message;
					},
				),
			}),
			defineTool({
				name: "workflow_action",
				description:
					"Use after workflow_status, passing its current revision, to resume, retry-effect, switch-preset, close, create-pr or answer/forward a routed question; returns the updated workflow's compact row (the same shape workflow_status returns by default). Approval, rejection and review decisions are refused and belong to the developer.",
				parameters: Type.Object({
					repo: RepoParameter,
					workflowId: WorkflowIdParameter,
					revision: Type.Integer({
						minimum: 0,
						description:
							"Current revision returned by workflow_status; stale revisions are refused.",
					}),
					actionId: Type.String({
						minLength: 1,
						maxLength: 256,
						description:
							"Management action id from workflow_status; review decisions are not allowed.",
					}),
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
						return compactWorkflowStatusView(view);
					},
				),
			}),
			defineTool({
				name: "drain_workflow",
				description:
					"Use to execute a workflow's pending effects now (for example, launch agents or run delivery); returns an execution-requested acknowledgement, not a final workflow status.",
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
			// The workflow event subscription tools (add-orchestrator-event-
			// subscriptions), appended so a concurrent change to the tools above merges
			// cleanly.
			defineTool({
				name: "subscribe_events",
				description:
					'Subscribe this session to workflow events in the mode you want them: `wake` delivers coalesced notes, `digest` one note per interval, `silent` records without delivering (read them with read_events). The filter picks workflows (`scope` `mine` = yours (the default), `all` = every workflow; or `workflowIds`/`repositories`), events (`eventIds` or `categories`) and conditions (`reasons` = attention reason substrings, `roles`, `minSeverity`). Completion and progress events (`workflow.completed`, `workflow.started`, `run.completed`, `run.started`, `step.*`) have severity `info`, so `minSeverity: "warning"` EXCLUDES them: a subscription that should tell you a workflow finished must name `eventIds` (`workflow.completed`, `workflow.failed`, `workflow.closed`, `attention.raised`, `review.waiting`, `question.pending`, `effect.failed`, `run.blocked`) or use `minSeverity: "info"`. `untilWorkflowClosed` only ends the subscription once that workflow closes or completes; it never widens the filter, so a filter that excludes the terminal events will never be the note you were waiting for. `coalesceMs`/`minIntervalMs` override wake mode\'s own window and `digestMinutes` the digest interval. Every subscription needs a label, expires (default 24h, at most 30 days) and can end early with `untilWorkflowClosed` or `remainingEvents` (which counts the events it matched).',
				parameters: Type.Object({
					label: Type.String({
						minLength: 1,
						maxLength: 40,
						description: "Short label the notes name (`subs=<label>`)",
					}),
					reason: Type.Optional(
						Type.String({
							maxLength: 200,
							description: "Why you want these events; the developer reads it",
						}),
					),
					scope: Type.Optional(
						Type.Union([Type.Literal("mine"), Type.Literal("all")], {
							description:
								"`mine` (default): only the workflows you started; `all` widens it",
						}),
					),
					workflowIds: Type.Optional(
						Type.Array(WorkflowIdParameter, { maxItems: 20 }),
					),
					repositories: Type.Optional(
						Type.Array(Type.String({ maxLength: 4096 }), { maxItems: 8 }),
					),
					eventIds: Type.Optional(
						Type.Array(Type.String({ maxLength: 64 }), { maxItems: 32 }),
					),
					categories: Type.Optional(
						Type.Array(Type.String({ maxLength: 32 }), { maxItems: 13 }),
					),
					reasons: Type.Optional(Type.Array(Type.String({ maxLength: 256 }))),
					roles: Type.Optional(Type.Array(Type.String({ maxLength: 128 }))),
					minSeverity: Type.Optional(
						Type.Union([
							Type.Literal("info"),
							Type.Literal("warning"),
							Type.Literal("critical"),
						]),
					),
					mode: Type.Optional(
						Type.Union([
							Type.Literal("wake"),
							Type.Literal("digest"),
							Type.Literal("silent"),
						]),
					),
					expiresAt: Type.Optional(
						Type.String({ description: "ISO instant; default now + 24h" }),
					),
					untilWorkflowClosed: Type.Optional(
						Type.String({
							description: "Prune once this workflow is closed/completed",
						}),
					),
					remainingEvents: Type.Optional(
						Type.Integer({
							minimum: 1,
							description: "Prune once this many matched events were recorded",
						}),
					),
					digestMinutes: Type.Optional(
						Type.Number({
							minimum: 0,
							description: "digest mode: minutes between notes",
						}),
					),
					coalesceMs: Type.Optional(
						Type.Integer({
							minimum: 1,
							description: "wake mode: the coalescing window in ms",
						}),
					),
					minIntervalMs: Type.Optional(
						Type.Integer({
							minimum: 1,
							description:
								"wake mode: the shortest gap between two notes it contributes to",
						}),
					),
				}),
				execute: run(
					async (
						args: {
							label: string;
							reason?: string;
							scope: "mine" | "all";
							workflowIds?: string[];
							repositories?: string[];
							eventIds?: string[];
							categories?: string[];
							reasons?: string[];
							roles?: string[];
							minSeverity?: "info" | "warning" | "critical";
							mode?: "wake" | "digest" | "silent";
							expiresAt?: string;
							untilWorkflowClosed?: string;
							remainingEvents?: number;
							digestMinutes?: number;
							coalesceMs?: number;
							minIntervalMs?: number;
						},
						env,
					) => {
						const {
							scope,
							label,
							reason,
							mode,
							expiresAt,
							untilWorkflowClosed,
							remainingEvents,
							digestMinutes,
							coalesceMs,
							minIntervalMs,
							...conditions
						} = args;
						return call(env, "POST", "/api/v1/orchestrator/subscriptions", {
							label,
							...(reason ? { reason } : {}),
							...(mode ? { mode } : {}),
							...(expiresAt ? { expiresAt } : {}),
							...(untilWorkflowClosed ? { untilWorkflowClosed } : {}),
							...(remainingEvents !== undefined ? { remainingEvents } : {}),
							...(digestMinutes !== undefined ? { digestMinutes } : {}),
							...(coalesceMs !== undefined ? { coalesceMs } : {}),
							...(minIntervalMs !== undefined ? { minIntervalMs } : {}),
							filter: { scope: scope ?? "mine", ...conditions },
						});
					},
				),
			}),
			defineTool({
				name: "unsubscribe_events",
				description:
					"Remove one of your event subscriptions by id (list_subscriptions reports the ids). Idempotent.",
				parameters: Type.Object({
					subscriptionId: Type.String({ minLength: 1, maxLength: 128 }),
				}),
				execute: run(async (args: { subscriptionId: string }, env) => {
					const value = (await call(
						env,
						"POST",
						"/api/v1/orchestrator/subscriptions/delete",
						{ subscriptionId: args.subscriptionId },
					)) as { removed?: boolean };
					return value?.removed
						? `removed ${args.subscriptionId}`
						: `${args.subscriptionId} was not subscribed`;
				}),
			}),
			defineTool({
				name: "list_subscriptions",
				description:
					"List this session's event subscriptions: label, id, filter, mode, expiry, until-condition and last delivery. With no subscription of your own it reports the implicit `default` subscription the monitor delivers with.",
				parameters: Type.Object({}),
				execute: run(async (_args, env) => {
					const value = (await call(
						env,
						"GET",
						"/api/v1/orchestrator/subscriptions",
					)) as { subscriptions?: unknown[] };
					return value?.subscriptions ?? [];
				}),
			}),
			defineTool({
				name: "read_events",
				description:
					"Pull recorded workflow events since a cursor instead of being woken: returns at most `limit` (max 200) matching events with the cursor to resume from. Filters are the same as subscribe_events. A cursor older than the retained window answers `cursorExpired` with the oldest retained sequence, so re-baseline from the newest events instead of guessing.",
				parameters: Type.Object({
					after: Type.Optional(
						Type.Integer({
							minimum: 0,
							description: "Cursor from the last read",
						}),
					),
					limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 200 })),
					scope: Type.Optional(
						Type.Union([Type.Literal("mine"), Type.Literal("all")], {
							description: "`mine` (default): only the workflows you started",
						}),
					),
					workflowIds: Type.Optional(Type.Array(WorkflowIdParameter)),
					repositories: Type.Optional(
						Type.Array(Type.String({ maxLength: 4096 })),
					),
					eventIds: Type.Optional(Type.Array(Type.String({ maxLength: 64 }))),
					categories: Type.Optional(Type.Array(Type.String({ maxLength: 32 }))),
					reasons: Type.Optional(Type.Array(Type.String({ maxLength: 256 }))),
					roles: Type.Optional(Type.Array(Type.String({ maxLength: 128 }))),
					minSeverity: Type.Optional(
						Type.Union([
							Type.Literal("info"),
							Type.Literal("warning"),
							Type.Literal("critical"),
						]),
					),
				}),
				execute: run(
					async (
						args: {
							after?: number;
							limit?: number;
							scope?: "mine" | "all";
							workflowIds?: string[];
							repositories?: string[];
							eventIds?: string[];
							categories?: string[];
							reasons?: string[];
							roles?: string[];
							minSeverity?: "info" | "warning" | "critical";
						},
						env,
					) => {
						const query = new URLSearchParams();
						if (args.after !== undefined)
							query.set("after", String(args.after));
						if (args.limit !== undefined)
							query.set("limit", String(args.limit));
						for (const [key, value] of Object.entries(args))
							if (Array.isArray(value) && value.length > 0)
								query.set(key, value.join(","));
						// Always sent: an absent scope is the documented `mine` default, so
						// the server never has to guess whether a narrowed read was meant.
						query.set("scope", args.scope ?? "mine");
						if (args.minSeverity) query.set("minSeverity", args.minSeverity);
						const suffix = query.toString();
						return call(
							env,
							"GET",
							`/api/v1/workflow/events${suffix ? `?${suffix}` : ""}`,
						);
					},
				),
			}),
		],
	});
}
