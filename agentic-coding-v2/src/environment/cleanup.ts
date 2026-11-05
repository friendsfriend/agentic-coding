import { sharedLifetime, sharedRoot } from "./lifetime.ts";
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
/** A shared lifetime lets a later acquisition reuse one prerequisite generation,
 * so its cleanup context spans the owner's acquisitions; every other lifetime
 * stays inside its own batch. */
function related(a: EnvironmentRun, b: EnvironmentRun) {
	if (sameAcquisition(a, b)) return true;
	return (
		a.owner === b.owner &&
		sharedRoot(a.plan) &&
		sharedRoot(b.plan) &&
		a.plan.lifetime === sharedLifetime &&
		b.plan.lifetime === sharedLifetime
	);
}
function prerequisiteGenerations(
	run: EnvironmentRun,
	context: readonly EnvironmentRun[],
) {
	if (!run.plan.dependencyBatch) return new Set<string>();
	const byApp = new Map<string, EnvironmentRun[]>();
	for (const member of context) {
		const list = byApp.get(member.plan.app) ?? [];
		list.push(member);
		byApp.set(member.plan.app, list);
	}
	// One generation per app: this acquisition's own, or the live one it reused.
	const pick = (app: string) => {
		const candidates = byApp.get(app) ?? [],
			local = candidates.filter((member) => sameAcquisition(run, member)),
			pool = local.length ? local : candidates,
			live = pool.filter(holdsResource),
			chosen =
				live.length === 1 ? live[0] : pool.length === 1 ? pool[0] : pool[0];
		if (!chosen || live.length > 1 || (local.length !== 1 && pool.length !== 1))
			throw new Error(
				"Cleanup prerequisite generation is ambiguous or missing",
			);
		return chosen;
	};
	const ordered = new Set<string>(),
		visiting = new Set([run.plan.app]);
	const visit = (app: string, depth: number) => {
		if (visiting.has(app))
			throw new Error("Cyclic declared dependency closure");
		if (depth > 16)
			throw new Error(
				"Infrastructure dependency chain exceeds the batch limit",
			);
		const dependency = pick(app);
		if (dependency.plan.projectKind !== "infrastructure")
			throw new Error("Incomplete declared infrastructure dependency closure");
		visiting.add(app);
		for (const next of dependency.plan.requires ?? []) visit(next, depth + 1);
		visiting.delete(app);
		ordered.add(dependency.id);
	};
	for (const app of run.plan.requires ?? []) visit(app, 1);
	return ordered;
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
		requested.some((member) => related(run, member)),
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
