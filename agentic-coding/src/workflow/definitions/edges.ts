// The shared implementation-loop edge builder used by every workflow family
// that runs core.implementation through core.developer-review (openspec,
// no-openspec, fusion), plus the wikiGate=false legacy-tier version helper.
// Moved verbatim out of definitions.ts (split-workflow-god-modules).
import type { WorkflowManifest } from "../registry.ts";
import { LEGACY_ROUTE_STEPS, STEP_ROUTES } from "../steps/routing.ts";

export function definitionVersionForPolicy(rounds: number): number {
	return rounds + 100;
}

/** The route step that precedes each classifiable step, derived from the route
 * step catalog so a graph names an agent step and never its routing step
 * (classifier-driven-step-model-selection). */
export const ROUTE_STEP_FOR_TARGET: Readonly<Record<string, string>> =
	Object.freeze(
		Object.fromEntries(
			Object.entries(STEP_ROUTES).map(([routeStepId, route]) => [
				route.target,
				routeStepId,
			]),
		),
	);

/** The step an entry lands on: a classifiable step's route step, every other
 * step itself. */
export function routeEntry(target: string): string {
	return ROUTE_STEP_FOR_TARGET[target] ?? target;
}

/**
 * Rewrite one manifest for per-step routing: every classifiable step gains the
 * routing step that asks its pool question immediately before it runs, every
 * edge that entered the step enters that routing step instead (so a loop
 * re-selects the model), and the pre-per-step phase passes
 * (`core.route-plan`/`core.route-apply`) are retired — their inbound edges
 * follow the step they used to select for, and their place in the graph is
 * taken by the per-step routing steps.
 *
 * Derived rather than hand-written per family: the alternative is nine
 * manifests that must each remember to route every inbound edge, and a mistake
 * there silently leaves a step on its pool default. The original manifests stay
 * in the registry untouched for definitions pinned to earlier tiers.
 */
export function withPerStepRouting(
	manifest: WorkflowManifest,
): WorkflowManifest {
	const present = new Set(manifest.steps);
	/** A phase-pass route step, or a route step whose target this graph does not
	 * contain (a fusion graph never reaches `core.plan`). */
	const retired = (id: string): boolean => {
		if (LEGACY_ROUTE_STEPS[id]) return true;
		const route = STEP_ROUTES[id];
		return route !== undefined && !present.has(route.target);
	};
	const outgoing = (id: string): string | undefined =>
		manifest.edges.find(
			(edge) => edge.from === id && edge.outcome === "complete",
		)?.to;
	/** Where an edge or the initial step lands when the step it named is
	 * retired: the routing step of whatever the retired step selected for. */
	const retirementEntry = (id: string): string => {
		const next = outgoing(id);
		if (next !== undefined && !retired(next)) return routeEntry(next);
		const route = STEP_ROUTES[id] ?? LEGACY_ROUTE_STEPS[id];
		return route ? routeEntry(route.target) : id;
	};
	const entry = (to: string): string =>
		retired(to) ? retirementEntry(to) : routeEntry(to);
	const edges = manifest.edges
		.filter((edge) => !retired(edge.from))
		.map((edge) => {
			// An edge that already comes from the target's routing step is the
			// graph's own (or a previous tier's) form of the same transition and
			// stays byte-identical.
			if (edge.from === ROUTE_STEP_FOR_TARGET[edge.to]) return edge;
			const to = entry(edge.to);
			return to === edge.to ? edge : { ...edge, to };
		});
	// Route steps are derived, so the input list's own phase passes are dropped
	// and every classifiable step re-derives its routing step in place.
	const steps = manifest.steps
		.filter((id) => STEP_ROUTES[id] === undefined && !LEGACY_ROUTE_STEPS[id])
		.flatMap((id) => {
			const route = ROUTE_STEP_FOR_TARGET[id];
			return route ? [route, id] : [id];
		});
	const declared = new Set(
		edges.map((edge) => `${edge.from}|${edge.outcome}|${edge.to}`),
	);
	const routeEdges = manifest.steps
		.filter((id) => ROUTE_STEP_FOR_TARGET[id] !== undefined)
		.map((id) => ({
			from: ROUTE_STEP_FOR_TARGET[id],
			outcome: "complete",
			to: id,
		}))
		.filter((edge) => !declared.has(`${edge.from}|${edge.outcome}|${edge.to}`));
	return {
		...manifest,
		initial: entry(manifest.initial),
		steps,
		edges: [...edges, ...routeEdges],
	};
}

export function workflowEdges(
	archive: boolean,
	maxVerificationRounds: number,
	wikiGate = true,
	wikiBeforeArchive = true,
	includeTriageRoute = false,
	stageGates = false,
): WorkflowManifest["edges"] {
	const approved = archive
		? wikiGate && wikiBeforeArchive
			? "core.wiki"
			: "core.archive"
		: wikiGate
			? "core.wiki"
			: "core.delivery";
	// Derived once and reused by the developer approval and the review gate's
	// skip so the two cannot diverge: with a wiki gate both land on the gate,
	// and without one both land on the same unconditional tail.
	const afterReview = stageGates && wikiGate ? "core.wiki-gate" : approved;
	// The archive is mandatory for OpenSpec to complete, so no gate ever
	// stands in front of it: a wiki-gate skip enters it (or delivery, for the
	// archive-free no-OpenSpec family).
	const afterWikiGate = archive ? "core.archive" : "core.delivery";
	return [
		// The routing step is the per-round classifier gate: it sits between
		// implementation and triage, and an empty selection bypasses triage
		// entirely for the full-suite-only round.
		...(includeTriageRoute
			? ([
					{
						from: "core.implementation",
						outcome: "complete",
						to: "core.triage-route",
					},
					{
						from: "core.triage-route",
						outcome: "complete",
						to: "core.triage",
					},
					{
						from: "core.triage-route",
						outcome: "empty",
						to: "core.verification",
					},
					// The verification gate's skip is a whole-round skip: the only
					// edge out of it is the review gate, which skips again only
					// when the developer-review policy is itself automatic.
					...(stageGates
						? [
								{
									from: "core.triage-route",
									outcome: "skip-verification",
									to: "core.review-gate",
								},
							]
						: []),
				] as const)
			: []),
		...(includeTriageRoute
			? []
			: [
					{
						from: "core.implementation",
						outcome: "complete",
						to: "core.triage",
					},
				]),
		{
			from: "core.implementation",
			outcome: "blocked",
			to: "core.implementation",
			loop: { maxAttempts: 6 },
		},
		{
			from: "core.implementation",
			outcome: "failed",
			to: "core.implementation",
			loop: { maxAttempts: 6 },
		},
		{ from: "core.triage", outcome: "complete", to: "core.verification" },
		{
			from: "core.triage",
			outcome: "blocked",
			to: "core.triage",
			loop: { maxAttempts: 3 },
		},
		{
			from: "core.triage",
			outcome: "failed",
			to: "core.triage",
			loop: { maxAttempts: 3 },
		},
		...(stageGates
			? ([
					{
						from: "core.verification",
						outcome: "pass",
						to: "core.review-gate",
					},
					{
						from: "core.review-gate",
						outcome: "run",
						to: "core.developer-review",
					},
					{ from: "core.review-gate", outcome: "skip", to: afterReview },
				] as const)
			: [
					{
						from: "core.verification",
						outcome: "pass",
						to: "core.developer-review",
					},
				]),
		...(stageGates && wikiGate
			? ([
					{ from: "core.wiki-gate", outcome: "run", to: "core.wiki" },
					{ from: "core.wiki-gate", outcome: "skip", to: afterWikiGate },
				] as const)
			: []),
		{
			from: "core.verification",
			outcome: "fix",
			to: "core.implementation",
			loop: { maxAttempts: maxVerificationRounds },
		},
		{
			from: "core.verification",
			outcome: "limit",
			to: "core.verification",
			loop: { maxAttempts: 1 },
		},
		{
			from: "core.verification",
			outcome: "blocked",
			to: "core.verification",
			loop: { maxAttempts: maxVerificationRounds },
		},
		{
			from: "core.verification",
			outcome: "failed",
			to: "core.implementation",
			loop: { maxAttempts: maxVerificationRounds },
		},
		{ from: "core.developer-review", outcome: "approve", to: afterReview },
		{
			from: "core.developer-review",
			outcome: "comments",
			to: "core.implementation",
			loop: { maxAttempts: 6 },
		},
		...(archive
			? wikiGate
				? wikiBeforeArchive
					? ([
							{
								from: "core.wiki",
								outcome: "complete",
								to: "core.wiki-approval",
							},
							{
								from: "core.wiki",
								outcome: "blocked",
								to: "core.wiki",
								loop: { maxAttempts: 3 },
							},
							{
								from: "core.wiki",
								outcome: "failed",
								to: "core.wiki",
								loop: { maxAttempts: 3 },
							},
							{
								from: "core.wiki-approval",
								outcome: "approve",
								to: "core.archive",
								effects: [
									{
										kind: "wiki.verify",
										idempotencyKey: "wiki.verify",
										payload: {},
									},
								],
							},
							{
								from: "core.wiki-approval",
								outcome: "comments",
								to: "core.wiki",
								loop: { maxAttempts: 6 },
							},
							{
								from: "core.archive",
								outcome: "complete",
								to: "core.delivery",
							},
							{
								from: "core.archive",
								outcome: "blocked",
								to: "core.archive",
								loop: { maxAttempts: 3 },
							},
							{
								from: "core.archive",
								outcome: "failed",
								to: "core.archive",
								loop: { maxAttempts: 3 },
							},
						] as const)
					: ([
							{
								from: "core.archive",
								outcome: "complete",
								to: "core.wiki-approval",
							},
							{
								from: "core.wiki-approval",
								outcome: "approve",
								to: "core.delivery",
								effects: [
									{
										kind: "wiki.verify",
										idempotencyKey: "wiki.verify",
										payload: {},
									},
								],
							},
							{
								from: "core.wiki-approval",
								outcome: "comments",
								to: "core.archive",
								loop: { maxAttempts: 6 },
							},
							{
								from: "core.archive",
								outcome: "blocked",
								to: "core.archive",
								loop: { maxAttempts: 3 },
							},
							{
								from: "core.archive",
								outcome: "failed",
								to: "core.archive",
								loop: { maxAttempts: 3 },
							},
						] as const)
				: ([
						{ from: "core.archive", outcome: "complete", to: "core.delivery" },
						{
							from: "core.archive",
							outcome: "blocked",
							to: "core.archive",
							loop: { maxAttempts: 3 },
						},
						{
							from: "core.archive",
							outcome: "failed",
							to: "core.archive",
							loop: { maxAttempts: 3 },
						},
					] as const)
			: wikiGate
				? ([
						{
							from: "core.wiki",
							outcome: "complete",
							to: "core.wiki-approval",
						},
						{
							from: "core.wiki",
							outcome: "blocked",
							to: "core.wiki",
							loop: { maxAttempts: 3 },
						},
						{
							from: "core.wiki",
							outcome: "failed",
							to: "core.wiki",
							loop: { maxAttempts: 3 },
						},
						{
							from: "core.wiki-approval",
							outcome: "approve",
							to: "core.delivery",
							effects: [
								{
									kind: "wiki.verify",
									idempotencyKey: "wiki.verify",
									payload: {},
								},
							],
						},
						{
							from: "core.wiki-approval",
							outcome: "comments",
							to: "core.wiki",
							loop: { maxAttempts: 6 },
						},
					] as const)
				: []),
		{ from: "core.delivery", outcome: "complete", to: "core.completed" },
		{
			from: "core.delivery",
			outcome: "failed",
			to: "core.delivery",
			loop: { maxAttempts: 3 },
		},
		{
			from: "core.completed",
			outcome: "create-pr",
			to: "core.completed",
			loop: { maxAttempts: 3 },
		},
		{ from: "core.completed", outcome: "close", to: "core.closed" },
	];
}
