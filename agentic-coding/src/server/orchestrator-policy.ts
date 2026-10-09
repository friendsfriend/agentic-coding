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

import type { OrchestratorLimits } from "../workflow/profiles.ts";
import type { OrchestratorLaunch } from "../workflow/runtime/orchestrator-launches.ts";

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
]);

export function orchestratorRouteAllowed(
	method: string,
	pathname: string,
): boolean {
	return ALLOWED_ROUTES.has(`${method.toUpperCase()} ${pathname}`);
}

/** Steps whose decision belongs to the developer. While a workflow sits on one
 * of these, the orchestrator may only run the recovery actions below. */
export const HUMAN_REVIEW_STEPS: ReadonlySet<string> = new Set([
	"core.plan-approval",
	"core.developer-review",
	"core.findings-review",
	"core.wiki-approval",
]);

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

/** The counts and ceiling the launch decision reads. Gathered by the transport
 * (`app.ts`) from `countOrchestratorLaunches` and the configured limits. */
export interface OrchestratorLaunchRefusalInput {
	readonly limits: OrchestratorLimits;
	readonly active: readonly OrchestratorLaunch[];
	readonly recent: readonly OrchestratorLaunch[];
	/** Targets whose store could not be read, counted as zero. */
	readonly skipped?: readonly string[];
}

/** How many workflow ids / skipped targets a refusal names before it elides
 * the rest. The message length stays independent of the configured limits and
 * of how many workflows a store holds. */
const MAX_NAMED = 10;

function boundedList(names: readonly string[]): string {
	const named = names.slice(0, MAX_NAMED).join(", ");
	const rest = names.length - MAX_NAMED;
	return rest > 0 ? `${named}, … and ${rest} more` : named;
}

function launchNames(launches: readonly OrchestratorLaunch[]): string {
	return boundedList(launches.map((launch) => launch.workflowId));
}

/** Whether the orchestrator has spent its launch budget. The refusal names the
 * limit, the current count and the workflows that were counted, so the session
 * can relay exactly why a start was refused. Returns undefined when a start is
 * allowed. */
export function orchestratorLaunchRefusal(
	input: OrchestratorLaunchRefusalInput,
): string | undefined {
	const { limits, active, recent, skipped = [] } = input;
	const note = skipped.length
		? ` (unreadable stores skipped: ${boundedList(skipped)})`
		: "";
	if (active.length >= limits.maxActive)
		return `orchestrator launch limit reached: ${active.length} of ${limits.maxActive} active workflows (${launchNames(active)})${note}`;
	if (recent.length >= limits.maxStartsPerDay)
		return `orchestrator launch limit reached: ${recent.length} of ${limits.maxStartsPerDay} starts in the last 24 hours (${launchNames(recent)})${note}`;
	return undefined;
}
