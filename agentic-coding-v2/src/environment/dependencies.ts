import type { Plan, Project } from "./model.ts";
/** Closed declared graphs only. Legacy requires edges stay same-repository infrastructure; new app/foreign edges require an explicit target, never discovery/adoption. */
export function validateDependencies(projects: Project[]) {
	const visited = new Set<string>();
	const visit = (project: Project, stack: Set<string>) => {
		if (stack.has(project.id))
			throw new Error("Cyclic infrastructure dependencies");
		if (visited.has(project.id)) return;
		if (stack.size >= 16)
			throw new Error(
				"Infrastructure dependency chain exceeds the batch limit",
			);
		const next = new Set([...stack, project.id]);
		for (const id of project.requires ?? []) {
			const dependency = projects.find((item) => item.id === id);
			if (
				dependency?.kind !== "infrastructure" ||
				dependency.repository !== project.repository
			)
				throw new Error(
					"Dependencies must name declared infrastructure in the same repository",
				);
			visit(dependency, next);
		}
		for (const edge of [
			...(project.prerequisites ?? []),
			...project.targets.flatMap((target) => target.prerequisites ?? []),
		]) {
			const dependency = projects.find((item) => item.id === edge.app);
			if (
				!dependency ||
				dependency.kind === "library" ||
				!dependency.targets.some(
					(target) => target.id === edge.target && target.action === "run",
				)
			)
				throw new Error(
					"Prerequisites must name an authorized runnable project and an explicit run target",
				);
			visit(dependency, next);
		}
		visited.add(project.id);
	};
	for (const project of projects) visit(project, new Set());
}
/** Project only an already-declared closed DAG; no defaults, discovery, runtime
 * selection or ownership authority. Callers must establish same-batch authority. */
export function declaredInfrastructure(
	root: Plan,
	members: readonly Plan[],
): Plan[] {
	const byApp = new Map(members.map((plan) => [plan.app, plan]));
	if (byApp.size !== members.length || members.length > 16)
		throw new Error(
			"Declared dependency closure is ambiguous or exceeds 16 projects",
		);
	const ordered = new Map<string, Plan>(),
		visiting = new Set([root.app]);
	const visit = (app: string, parent: Plan) => {
		if (visiting.has(app))
			throw new Error("Cyclic declared dependency closure");
		if (ordered.has(app)) return;
		const dependency = byApp.get(app);
		if (
			!dependency ||
			(dependency.projectKind !== "infrastructure" &&
				!(
					dependency.projectKind === "app" &&
					parent.prerequisiteTargets?.[app] === dependency.id
				)) ||
			(parent.prerequisiteTargets?.[app] &&
				parent.prerequisiteTargets[app] !== dependency.id)
		)
			throw new Error(
				"Incomplete or changed declared prerequisite target closure",
			);
		visiting.add(app);
		for (const next of dependency.requires ?? []) visit(next, dependency);
		visiting.delete(app);
		ordered.set(app, dependency);
	};
	for (const app of root.requires ?? []) visit(app, root);
	return [...ordered.values()];
}
/** Dependency-first admission; one exclusive, coupled-lifetime batch, no cross-task sharing. */
export function expandDependencies(
	roots: Plan[],
	resolve: (id: string, parent: Plan) => Plan,
): Plan[] {
	const explicit = new Map(roots.map((plan) => [plan.app, plan]));
	const ordered = new Map<string, Plan>();
	const visiting = new Set<string>();
	const visit = (plan: Plan) => {
		if (visiting.has(plan.app))
			throw new Error("Cyclic infrastructure dependencies");
		if (ordered.has(plan.app)) return;
		if (ordered.size + visiting.size >= 16)
			throw new Error("Expanded environment batch exceeds 16 projects");
		visiting.add(plan.app);
		for (const id of plan.requires ?? []) {
			const dependency = explicit.get(id) ?? resolve(id, plan);
			if (
				plan.prerequisiteTargets?.[id] &&
				dependency.id !== plan.prerequisiteTargets[id]
			)
				throw new Error(
					"Explicit root selection conflicts with the declared prerequisite target",
				);
			if (ordered.has(id) && ordered.get(id)?.id !== dependency.id)
				throw new Error(
					"Prerequisite graph selects conflicting targets for one project",
				);
			if (dependency.kubernetes && !explicit.has(id))
				throw new Error(
					"Kubernetes dependencies must be explicitly requested with an eligible target/runtime; no implicit Pod starts",
				);
			visit(dependency);
		}
		visiting.delete(plan.app);
		ordered.set(plan.app, plan);
	};
	for (const root of roots) visit(root);
	const plans = [...ordered.values()];
	return plans.some((plan) => plan.requires?.length)
		? plans.map((plan) => ({ ...plan, dependencyBatch: true }))
		: plans;
}
