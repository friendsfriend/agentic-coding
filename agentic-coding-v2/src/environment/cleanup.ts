import { declaredInfrastructure } from "./dependencies.ts";
import { type EnvironmentRun, holdsResource } from "./state.ts";

export class CleanupUncertain extends Error {
	constructor() {
		super(
			"Cleanup remains uncertain; operator inspection required. Use a fresh stop after inspection, not replay of this outcome.",
		);
	}
}
function sameAcquisition(a: EnvironmentRun, b: EnvironmentRun) {
	return (
		a.owner === b.owner &&
		a.batch === b.batch &&
		a.plan.workspace === b.plan.workspace
	);
}
function prerequisiteGenerations(
	run: EnvironmentRun,
	context: readonly EnvironmentRun[],
) {
	const members = context.filter((member) => sameAcquisition(run, member));
	const plans = run.plan.dependencyBatch
		? declaredInfrastructure(
				run.plan,
				members.map((member) => member.plan),
			)
		: [];
	return new Set(
		plans.map((plan) => {
			const resource = members.find((member) => member.plan === plan);
			if (!resource)
				throw new Error("Cleanup prerequisite generation is missing");
			return resource.id;
		}),
	);
}
function dependentFirst(
	selected: readonly string[],
	byId: ReadonlyMap<string, EnvironmentRun>,
	requirements: ReadonlyMap<string, ReadonlySet<string>>,
) {
	const visited = new Set<string>(),
		order: EnvironmentRun[] = [];
	const visit = (id: string) => {
		if (visited.has(id)) return;
		visited.add(id);
		for (const resource of requirements.get(id) ?? [])
			if (selected.includes(resource)) visit(resource);
		const run = byId.get(id);
		if (!run) throw new Error("Cleanup generation disappeared");
		order.push(run);
	};
	for (const id of selected) visit(id);
	return order.reverse();
}
function unsettledDependents(
	id: string,
	current: readonly EnvironmentRun[],
	context: readonly EnvironmentRun[],
	requirements: ReadonlyMap<string, ReadonlySet<string>>,
) {
	// Missing rows are not release evidence. Only a confirmed native exit or
	// explicit revision-bound inspection settles a known generation.
	const settled = new Set(
		current.filter((run) => !holdsResource(run)).map((run) => run.id),
	);
	return context
		.filter((run) => !settled.has(run.id) && requirements.get(run.id)?.has(id))
		.map((run) => run.id);
}
/** An immutable same-acquisition DAG is a cleanup constraint, never process or
 * reference authority. Only the manager's original private handles may act. */
export function cleanupSchedule(
	all: readonly EnvironmentRun[],
	selected: readonly string[],
) {
	const requested = all.filter((run) => selected.includes(run.id));
	const context = all.filter((run) =>
		requested.some((member) => sameAcquisition(run, member)),
	);
	const byId = new Map(context.map((run) => [run.id, run]));
	if (byId.size !== context.length || selected.some((id) => !byId.has(id)))
		throw new Error("Cleanup generations cannot be established");
	const requirements = new Map(
		context.map((run) => [run.id, prerequisiteGenerations(run, context)]),
	);
	return {
		order: dependentFirst(selected, byId, requirements),
		blockedBy: (id: string, current: readonly EnvironmentRun[]) =>
			unsettledDependents(id, current, context, requirements),
		/** Last-reference release: context generations whose dependents are all
		 * confirmed released. Derived from immutable plans and current states. */
		orphans: (current: readonly EnvironmentRun[]) => {
			const settled = new Set(
					current.filter((run) => !holdsResource(run)).map((run) => run.id),
				),
				referenced = new Set(
					[...requirements.values()].flatMap((set) => [...set]),
				);
			return context.filter(
				(run) =>
					referenced.has(run.id) &&
					!settled.has(run.id) &&
					unsettledDependents(run.id, current, context, requirements).length ===
						0,
			);
		},
	};
}
