// What the Home Orchestrator session may do through the unified server
// (orchestrator capability, `auth.ts` `orchestratorTokenFor`). Pure data and
// pure predicates: the transport (`app.ts`) asks these before routing a request
// authenticated as the orchestrator, so the boundary is enforced by the server,
// never by the orchestrator's prompt.
//
// The orchestrator observes everything, starts and drains workflows, and
// performs lifecycle management. It never decides a human review: plan,
// developer, findings and wiki reviews stay with the developer, as do developer
// questions, configuration edits, repairs, deletions, and the environment and
// credential surfaces.

/** Exact `METHOD path` pairs the orchestrator may call. Anything else is 403. */
const ALLOWED_ROUTES: ReadonlySet<string> = new Set([
	"GET /api/v1/health",
	"POST /api/v1/observe",
	"GET /api/v1/workflow/view",
	"POST /api/v1/workflow/start",
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

/** Lifecycle actions offered once the work is done (completion step). */
const LIFECYCLE_ACTIONS: ReadonlySet<string> = new Set(["close", "create-pr"]);

/** Whether the orchestrator may dispatch `actionId` while the workflow's
 * current step is `currentStep`. Returns the refusal reason, or undefined. */
export function orchestratorActionRefusal(
	actionId: string,
	currentStep: string,
): string | undefined {
	if (recoveryAction(actionId)) return undefined;
	if (HUMAN_REVIEW_STEPS.has(currentStep))
		return `${currentStep} is a developer review; only the developer can decide it`;
	if (LIFECYCLE_ACTIONS.has(actionId)) return undefined;
	return `action ${actionId} is reserved for the developer`;
}
