// What the Home Orchestrator session may do through the unified server
// (orchestrator capability, `auth.ts` `orchestratorTokenFor`). Pure data and
// pure predicates: the transport (`app.ts`) asks these before routing a request
// authenticated as the orchestrator, so the boundary is enforced by the server,
// never by the orchestrator's prompt.
//
// The orchestrator observes everything, starts and drains workflows, and
// performs lifecycle management. It never decides a human review: plan,
// developer, findings and wiki reviews stay with the developer, as do
// configuration edits, repairs, deletions, and the environment and credential
// surfaces. It may answer or forward the developer questions its own workflows
// route to it first (route-developer-questions-through-orchestrator): the
// reducer restricts `answer-question` to questions still marked for the
// orchestrator, and `forward-question` hands them back to the developer.

import type { WorkflowReviewKind } from "../contracts/workflow-events.ts";

/** Exact `METHOD path` pairs the orchestrator may call. Anything else is 403. */
const ALLOWED_ROUTES: ReadonlySet<string> = new Set([
	"GET /api/v1/health",
	"POST /api/v1/observe",
	"GET /api/v1/workflow/view",
	"GET /api/v1/workflow/steps",
	"POST /api/v1/workflow/start",
	"POST /api/v1/workflow/blueprint/validate",
	"POST /api/v1/workflow/action",
	"POST /api/v1/workflow/execute",
	"GET /api/v1/config/agents",
	"GET /api/v1/classifier/status",
	"GET /api/v1/events",
	// The workflow event catalog and its subscriptions
	// (add-orchestrator-event-subscriptions): the orchestrator pulls recorded
	// events by cursor and manages its own subscriptions.
	"GET /api/v1/workflow/events",
	"GET /api/v1/orchestrator/subscriptions",
	"POST /api/v1/orchestrator/subscriptions",
	"POST /api/v1/orchestrator/subscriptions/delete",
]);

export function orchestratorRouteAllowed(
	method: string,
	pathname: string,
): boolean {
	return ALLOWED_ROUTES.has(`${method.toUpperCase()} ${pathname}`);
}

/** The four developer-review steps, named by the review kind an event payload
 * carries. The step *behaviour* stays with the step definitions; this map only
 * gives the review kinds a stable vocabulary, and `HUMAN_REVIEW_STEPS` is
 * derived from its keys so there is exactly one table. */
export const REVIEW_STEPS_BY_KIND = {
	plan: "core.plan-approval",
	developer: "core.developer-review",
	findings: "core.findings-review",
	wiki: "core.wiki-approval",
} as const satisfies Record<WorkflowReviewKind, string>;

/** Steps whose decision belongs to the developer. While a workflow sits on one
 * of these, the orchestrator may only run the recovery actions below. */
export const HUMAN_REVIEW_STEPS: ReadonlySet<string> = new Set(
	Object.values(REVIEW_STEPS_BY_KIND),
);

/** The review kind of a step, or undefined for every other step. */
export function reviewKindForStep(
	stepId: string,
): WorkflowReviewKind | undefined {
	for (const [kind, step] of Object.entries(REVIEW_STEPS_BY_KIND))
		if (step === stepId) return kind as WorkflowReviewKind;
	return undefined;
}

/** Recovery actions that never decide a review: resume a paused workflow,
 * retry a failed effect, or switch the preset for future runs. */
function recoveryAction(actionId: string): boolean {
	return (
		actionId === "resume" ||
		actionId === "switch-preset" ||
		actionId.startsWith("retry-effect:")
	);
}

/** Developer-question actions the orchestrator may run on its own workflows: it
 * answers a question routed to it, or forwards it to the developer. The reducer
 * enforces that only orchestrator-routed questions are affected; this gate only
 * frees the action from the developer-reserved refusal, whatever the step. */
function questionAction(actionId: string): boolean {
	return actionId === "answer-question" || actionId === "forward-question";
}

/** Lifecycle actions offered once the work is done (completion step). */
const LIFECYCLE_ACTIONS: ReadonlySet<string> = new Set(["close", "create-pr"]);

/** Whether the orchestrator may dispatch `actionId` while the workflow's
 * current step is `currentStep`. Returns the refusal reason, or undefined. */
export function orchestratorActionRefusal(
	actionId: string,
	currentStep: string,
): string | undefined {
	if (recoveryAction(actionId)) return undefined;
	if (questionAction(actionId)) return undefined;
	if (HUMAN_REVIEW_STEPS.has(currentStep))
		return `${currentStep} is a developer review; only the developer can decide it`;
	if (LIFECYCLE_ACTIONS.has(actionId)) return undefined;
	return `action ${actionId} is reserved for the developer`;
}
