import { digest } from "../config.ts";
import { decode, values } from "../state.ts";
import { declaredInfrastructure } from "./dependencies.ts";
import { samePlanOwnerScope } from "./dependency-workspaces.ts";
import {
	isShellRuntime,
	type Plan,
	type ReferenceGraph,
	type ReferenceObservation,
} from "./model.ts";
import type { EnvironmentRun } from "./state.ts";

type Journal = {
	runs: Record<string, string>;
	referenceGraphs?: Record<string, string>;
};

/** Observations only. These records never authorize attach, diagnostics or cleanup.
 * Capture a closed shell app/infrastructure graph from one existing coupled batch.
 * Direct/unattributed infrastructure, old receipts and other runtimes are not inferred. */
export function captureReferenceGraph(
	doc: Journal,
	batch: string,
	owner: number,
	request: string,
	plans: Plan[],
) {
	if (
		!plans.length ||
		!plans.some((plan) => plan.requires?.length) ||
		plans.some(
			(plan) =>
				plan.action !== "run" ||
				!isShellRuntime(plan.runtime) ||
				!plan.dependencyBatch ||
				plan.lifetime !== undefined ||
				!["app", "infrastructure"].includes(plan.projectKind ?? ""),
		)
	)
		return;
	const byApp = new Map(plans.map((plan) => [plan.app, plan]));
	if (
		byApp.size !== plans.length ||
		plans.length > 16 ||
		plans.some((plan) => !plans[0] || !samePlanOwnerScope(plan, plans[0])) ||
		plans.some((plan) =>
			Object.keys(plan.prerequisiteTargets ?? {}).some((app) =>
				plans.some(
					(member) => member.app === app && member.projectKind === "app",
				),
			),
		)
	)
		return;
	const roots: ReferenceGraph["roots"] = [];
	for (const plan of plans.filter((plan) => plan.projectKind === "app")) {
		try {
			const closure = declaredInfrastructure(plan, plans);
			roots.push({
				run: `${batch}:${plan.app}`,
				resources: closure
					.filter((member) => member.projectKind === "infrastructure")
					.map((member) => `${batch}:${member.app}`),
				observation: "reserved-observed",
			});
		} catch {
			// An incomplete/unsupported observation is not a request for discovery.
			return;
		}
	}
	if (
		!roots.length ||
		plans.some(
			(plan) =>
				plan.projectKind === "infrastructure" &&
				!roots.some((root) => root.resources.includes(`${batch}:${plan.app}`)),
		)
	)
		return;
	doc.referenceGraphs ??= {};
	if (doc.referenceGraphs[batch]) return; // Never replace a generation's recorded graph.
	doc.referenceGraphs[batch] = JSON.stringify({
		protocol: "native-root-reference-graph-v1",
		control: "coupled-observation-only",
		batch,
		owner,
		requestDigest: digest(request),
		revision: 1,
		createdAt: Date.now(),
		observation: "reserved-observed",
		roots,
		members: plans.map((plan) => ({
			run: `${batch}:${plan.app}`,
			app: plan.app,
			kind: plan.projectKind,
			planDigest: digest(JSON.stringify(plan)),
			requires: (plan.requires ?? []).map((app) => `${batch}:${app}`),
		})),
	} satisfies ReferenceGraph);
}
function observation(
	runs: (EnvironmentRun | undefined)[],
): ReferenceObservation {
	if (runs.some((run) => !run || run.state === "interrupted"))
		return "interrupted-observed";
	if (runs.every((run) => run?.state === "exited")) return "settled-observed";
	if (runs.some((run) => run?.state === "stopping" || run?.state === "exited"))
		return "closing-observed";
	return runs.every((run) => run?.state === "running")
		? "running-observed"
		: "reserved-observed";
}
/** Match only the recorded generation/plan; this is not live ownership verification. */
function matchingObservedMember(
	doc: Journal,
	graph: ReferenceGraph,
	member: ReferenceGraph["members"][number],
) {
	const raw = doc.runs[member.run],
		run = raw ? decode<EnvironmentRun>(raw) : undefined;
	return run?.id === member.run &&
		run.owner === graph.owner &&
		run.batch === graph.batch &&
		digest(run.request) === graph.requestDigest &&
		digest(JSON.stringify(run.plan)) === member.planDigest
		? run
		: undefined;
}
/** Same native transaction as the state observation; never dispatches an effect.
 * Inspection may settle observations, but cannot restore an execution capability. */
export function refreshReferenceGraphs(doc: Journal, batch?: string) {
	const records = doc.referenceGraphs;
	const graphs =
		batch === undefined
			? values<ReferenceGraph>(records)
			: records && Object.hasOwn(records, batch)
				? [decode<ReferenceGraph>(records[batch])]
				: [];
	for (const graph of graphs) {
		if (batch !== undefined && graph.batch !== batch) continue;
		const members = new Map(
			graph.members.map((member) => [
				member.run,
				matchingObservedMember(doc, graph, member),
			]),
		);
		const next = {
			...graph,
			observation: observation([...members.values()]),
			roots: graph.roots.map((root) => ({
				...root,
				observation: observation(
					[root.run, ...root.resources].map((id) => members.get(id)),
				),
			})),
		};
		if (JSON.stringify(next) === JSON.stringify(graph)) continue;
		next.revision++;
		if (doc.referenceGraphs)
			doc.referenceGraphs[graph.batch] = JSON.stringify(next);
	}
}
function referenceGraphView(graph: ReferenceGraph) {
	return {
		protocol: graph.protocol,
		control: graph.control,
		batch: graph.batch,
		owner: graph.owner,
		requestDigest: graph.requestDigest,
		revision: graph.revision,
		createdAt: graph.createdAt,
		observation: graph.observation,
		roots: graph.roots.map(({ run, resources, observation }) => ({
			run,
			resources,
			observation,
		})),
		members: graph.members.map(({ run, app, kind, requires }) => ({
			run,
			app,
			kind,
			requires,
		})),
		authority:
			"Historical native state observations only; never live reference counts, attach, diagnostic, cleanup, restart or publication authority. Exited/inspected receipts are not independent proof of resource absence.",
		resources: graph.members
			.filter((member) => member.kind === "infrastructure")
			.map((member) => {
				const roots = graph.roots.filter((root) =>
					root.resources.includes(member.run),
				);
				return {
					run: member.run,
					app: member.app,
					applicationRequirements: roots.length,
					unsettledRequirements: roots.filter(
						(root) => root.observation !== "settled-observed",
					).length,
					interruptedRequirements: roots.filter(
						(root) => root.observation === "interrupted-observed",
					).length,
				};
			}),
	};
}

/** Keep all unsettled generations plus the newest 200 settled observations. */
export function referenceGraphHistory(
	records: Record<string, string> | undefined,
	app?: string,
) {
	const graphs = values<ReferenceGraph>(records).filter(
		(graph) => !app || graph.members.some((member) => member.app === app),
	);
	const recent = new Set(
		graphs
			.filter((graph) => graph.observation === "settled-observed")
			.slice(-200)
			.map((graph) => graph.batch),
	);
	return graphs
		.filter(
			(graph) =>
				graph.observation !== "settled-observed" || recent.has(graph.batch),
		)
		.map(referenceGraphView);
}
