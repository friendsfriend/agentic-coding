import { declaredInfrastructure } from "./dependencies.ts";
import { referencedRoot } from "./lifetime.ts";
import type { EnvironmentProcess } from "./process.ts";
import type { EnvironmentRun } from "./state.ts";

/** The exact root generation a diagnostic was approved for, with the declared
 * prerequisite generations of that one acquisition. Never a sibling fallback. */
export type ReferenceScope = { run: string; resources: string[] };

function sameAcquisition(a: EnvironmentRun, b: EnvironmentRun) {
	return (
		a.owner === b.owner &&
		a.batch === b.batch &&
		a.plan.workspace === b.plan.workspace
	);
}
/** `undefined` for default coupled runs: their diagnostics keep their existing
 * whole-batch semantics and gain no new descriptor. */
export function referenceScope(
	root: EnvironmentRun,
	members: readonly EnvironmentRun[],
): ReferenceScope | undefined {
	if (!referencedRoot(root.plan)) return undefined;
	const context = members.filter((member) => sameAcquisition(root, member)),
		plans = declaredInfrastructure(
			root.plan,
			context.map((member) => member.plan),
		);
	return {
		run: root.id,
		resources: plans
			.map((plan) => {
				const member = context.find((item) => item.plan === plan);
				if (!member)
					throw new Error(
						"Referenced diagnostic prerequisite generation is unavailable",
					);
				return member.id;
			})
			.sort((left, right) => (left < right ? -1 : left > right ? 1 : 0)),
	};
}
/** Closing generations are an admission fence for diagnostics: every approved
 * generation must still be the original live ready handle without retention or
 * uncertain cleanup, and no other run may substitute for it. */
export function requireScopeLive(
	scope: ReferenceScope,
	members: readonly EnvironmentRun[],
	live: ReadonlyMap<string, EnvironmentProcess>,
) {
	for (const id of [scope.run, ...scope.resources]) {
		const run = members.find((member) => member.id === id),
			process = run ? live.get(run.id) : undefined;
		if (
			run?.state !== "running" ||
			run.ready !== true ||
			run.cleanupRetention !== undefined ||
			!process ||
			process.outcome ||
			process.cleanupFailed
		)
			throw new Error(
				"Referenced diagnostic root or prerequisite generation is closing or unavailable; no dispatch and no fallback to another run",
			);
	}
}
