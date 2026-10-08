// The human-review validator over a blueprint's logical graph
// (add-workflow-blueprint-compiler).
//
// A compiled blueprint must never lose a human review, and the logical graph is
// the only place the shape is still visible: the compiler inserts the stage
// gates afterwards, and the orchestrator pins those gates to `always`, so a
// graph that routes around a review cannot be saved by a gate policy.
//
// Every rule is checked *by removal*: delete the review node(s) from the graph
// and ask whether a forbidden node is still reachable. That handles loops and
// shared tails without enumerating paths, and a violation carries one concrete
// path so the model author can fix it.
//
// The implementation rule is anchored on the graph's *entry* step, not on
// `core.implementation`: an author-controlled entry that starts downstream of
// the review chain (a delivery or completion step) must be rejected too, and
// the entry's reachable set is a superset of implementation's.
//
// Pure domain: steps and edges in, violations out.
import type { WorkflowEdge } from "../registry.ts";

export type BlueprintReviewRule =
	| "implementation-review"
	| "plan-approval"
	| "wiki-approval";

export interface BlueprintReviewViolation {
	readonly rule: BlueprintReviewRule;
	readonly message: string;
	/** One offending path, from the work step to the forbidden target. */
	readonly path: readonly string[];
}

export interface BlueprintReviewOptions {
	/** The derived entry step the implementation rule is anchored on. */
	readonly entry?: string;
	/** The blueprint's delivery trait. `core.completed`'s `create-pr` counts as
	 * a delivery point only when the workflow actually offers it, which is
	 * exactly `delivery: "pull-request"` (`steps/lifecycle.ts` offers
	 * `create-pr` only then). */
	readonly delivery?: "pull-request" | "none";
}

const REVIEW_STEP_IDS: readonly string[] = Object.freeze([
	"core.developer-review",
	"core.findings-review",
]);
const PLANNING_STEP_IDS: readonly string[] = Object.freeze([
	"core.plan",
	"fusion.plan",
	"fusion.consolidate",
]);
/** The steps a reviewing path must not reach unreviewed. `core.wiki` stays in
 * this set but is excluded from the completion clause: the wiki-only shape is
 * already guarded by the wiki-approval rule. */
const DELIVERING_STEP_IDS: readonly string[] = Object.freeze([
	"core.delivery",
	"core.archive",
	"core.wiki",
]);
/** The steps planning must not reach without plan approval. */
const APPROVAL_PROTECTED_STEP_IDS: readonly string[] = Object.freeze([
	"core.implementation",
	"core.delivery",
	"core.archive",
	"core.completed",
]);

interface Reachability {
	readonly reached: ReadonlySet<string>;
	readonly parent: ReadonlyMap<string, string>;
}

/** Outgoing edges by source, built once so each traversal is O(V + E). */
function outgoingBySource(
	edges: readonly WorkflowEdge[],
): ReadonlyMap<string, readonly WorkflowEdge[]> {
	const index = new Map<string, WorkflowEdge[]>();
	for (const edge of edges) {
		const bucket = index.get(edge.from);
		if (bucket) bucket.push(edge);
		else index.set(edge.from, [edge]);
	}
	return index;
}

/** Forward reachability from `from`, never entering a removed node. */
function reachability(
	stepsPresent: ReadonlySet<string>,
	outgoing: ReadonlyMap<string, readonly WorkflowEdge[]>,
	removed: ReadonlySet<string>,
	from: string,
): Reachability {
	const reached = new Set<string>([from]);
	const parent = new Map<string, string>();
	const queue: string[] = [from];
	while (queue.length > 0) {
		const current = queue.shift();
		if (current === undefined) break;
		for (const edge of outgoing.get(current) ?? []) {
			if (removed.has(edge.to) || !stepsPresent.has(edge.to)) continue;
			if (reached.has(edge.to)) continue;
			reached.add(edge.to);
			parent.set(edge.to, current);
			queue.push(edge.to);
		}
	}
	return { reached, parent };
}

function pathTo(reach: Reachability, target: string): string[] {
	const path = [target];
	let node = target;
	for (;;) {
		const previous = reach.parent.get(node);
		if (previous === undefined) return path;
		path.unshift(previous);
		node = previous;
	}
}

/**
 * Validate the logical graph's human reviews. Returns every violation; an
 * empty result means the graph keeps each review.
 *
 * - the entry step may reach `core.delivery`, `core.archive` and `core.wiki`
 *   only through a developer or findings review (so a graph that starts after
 *   the review chain, or is implementation-free and hands straight off to a
 *   delivery step, is rejected). `core.completed` is forbidden too for a
 *   workflow that pushes code — it contains delivery or archive, or its
 *   `core.completed` can create a pull request; a workflow that pushes nothing
 *   is the solo shape, whose only exit is completion. The start node itself is
 *   never a forbidden target, so a wiki-only graph whose entry is `core.wiki`
 *   stays legal (rule 3 guards its approval).
 * - planning may reach `core.implementation`, `core.delivery`, `core.archive`
 *   or `core.completed` only through `core.plan-approval`.
 * - `core.wiki` may reach `core.archive`, `core.delivery` or `core.completed`
 *   only through `core.wiki-approval`.
 */
export function validateBlueprintReviews(
	steps: readonly string[],
	edges: readonly WorkflowEdge[],
	options: BlueprintReviewOptions = {},
): BlueprintReviewViolation[] {
	const violations: BlueprintReviewViolation[] = [];
	const stepsPresent = new Set(steps);
	const outgoing = outgoingBySource(edges);
	const has = (id: string) => stepsPresent.has(id);

	// Rule 1: the run's work keeps a review. It runs for every graph, not only
	// one that declares `core.implementation`: an implementation-free graph that
	// hands straight off to a delivery step is the same bypass.
	{
		const start =
			options.entry !== undefined && stepsPresent.has(options.entry)
				? options.entry
				: "core.implementation";
		// `create-pr` turns completion into a delivery point, but only when the
		// workflow's delivery trait actually offers it.
		const prCapable =
			options.delivery === "pull-request" &&
			edges.some(
				(edge) =>
					edge.from === "core.completed" && edge.outcome === "create-pr",
			);
		const pushes = has("core.delivery") || has("core.archive");
		const forbidden = [
			...DELIVERING_STEP_IDS.filter(has),
			...(pushes || prCapable ? ["core.completed"] : []),
		].filter((id) => id !== start);
		if (stepsPresent.has(start) && forbidden.length > 0) {
			const reach = reachability(
				stepsPresent,
				outgoing,
				new Set(REVIEW_STEP_IDS),
				start,
			);
			const hit = forbidden.find((id) => reach.reached.has(id));
			if (hit !== undefined)
				violations.push({
					rule: "implementation-review",
					message: `${start} reaches ${hit} without a developer or findings review; add ${REVIEW_STEP_IDS.join(" or ")} on the path`,
					path: pathTo(reach, hit),
				});
		}
	}

	// Rule 2: planning keeps plan approval.
	for (const planner of PLANNING_STEP_IDS) {
		if (!has(planner)) continue;
		const reach = reachability(
			stepsPresent,
			outgoing,
			new Set(["core.plan-approval"]),
			planner,
		);
		const hit = APPROVAL_PROTECTED_STEP_IDS.filter(has).find((id) =>
			reach.reached.has(id),
		);
		if (hit !== undefined) {
			violations.push({
				rule: "plan-approval",
				message: `planning reaches ${hit} without core.plan-approval; route ${planner} through the approval step`,
				path: pathTo(reach, hit),
			});
			break;
		}
	}

	// Rule 3: wiki work keeps wiki approval.
	if (has("core.wiki")) {
		const reach = reachability(
			stepsPresent,
			outgoing,
			new Set(["core.wiki-approval"]),
			"core.wiki",
		);
		const forbidden = ["core.archive", "core.delivery", "core.completed"];
		const hit = forbidden.find((id) => reach.reached.has(id));
		if (hit !== undefined)
			violations.push({
				rule: "wiki-approval",
				message: `wiki work reaches ${hit} without core.wiki-approval; route core.wiki through the approval step`,
				path: pathTo(reach, hit),
			});
	}

	return violations;
}
