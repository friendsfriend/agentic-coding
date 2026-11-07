import { declaredInfrastructure } from "./dependencies.ts";
import { referencedRoot, sameApprovedPlan, sharedRoot } from "./lifetime.ts";
import type { Plan } from "./model.ts";
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
	approved?: readonly Plan[],
): ReferenceScope | undefined {
	if (!referencedRoot(root.plan)) return undefined;
	// Attached shared acquisitions approve prerequisites without starting a second
	// copy. Their live prerequisite lives in another batch, so the same-batch
	// closure below cannot resolve it. When the exact approved batch plans are
	// supplied, resolve against those and require exact plan identity for every
	// reused generation; never adopt by app name.
	if (approved) {
		const rootApproved = approved.find((plan) => plan.app === root.plan.app);
		if (!rootApproved || !sameApprovedPlan(rootApproved, root.plan))
			throw new Error(
				"Referenced diagnostic root generation changed; no fallback to another run",
			);
		const closure = declaredInfrastructure(rootApproved, [...approved]);
		const resolve = (expected: Plan): EnvironmentRun => {
			const context = members.filter((member) => sameAcquisition(root, member)),
				local = context.filter(
					(member) =>
						member.plan.app === expected.app &&
						sameApprovedPlan(member.plan, expected),
				);
			if (local.length === 1 && local[0]) return local[0];
			if (local.length > 1)
				throw new Error(
					"Shared diagnostic prerequisite generation is ambiguous or unavailable",
				);
			if (!sharedRoot(root.plan))
				throw new Error(
					"Referenced diagnostic prerequisite generation is unavailable",
				);
			const shared = members.filter(
				(member) =>
					member.owner === root.owner &&
					member.plan.workspace === root.plan.workspace &&
					sharedRoot(member.plan) &&
					member.plan.app === expected.app &&
					sameApprovedPlan(member.plan, expected) &&
					member.state === "running",
			);
			const only = shared[0];
			if (!only || shared.length !== 1)
				throw new Error(
					"Shared diagnostic prerequisite generation is ambiguous or unavailable",
				);
			return only;
		};
		return {
			run: root.id,
			resources: closure
				.map((expected) => resolve(expected).id)
				.sort((left, right) => (left < right ? -1 : left > right ? 1 : 0)),
		};
	}
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
				if (member) return member.id;
				if (!sharedRoot(root.plan))
					throw new Error(
						"Referenced diagnostic prerequisite generation is unavailable",
					);
				// A shared lifetime reuses one live generation of its prerequisite, and
				// only while it is still the generation this root's plan declared.
				const shared = members.filter(
					(item) =>
						item.owner === root.owner &&
						sharedRoot(item.plan) &&
						item.plan.app === plan.app &&
						sameApprovedPlan(item.plan, plan) &&
						item.state === "running",
				);
				const only = shared[0];
				if (!only || shared.length !== 1)
					throw new Error(
						"Shared diagnostic prerequisite generation is ambiguous or unavailable",
					);
				return only.id;
			})
			.sort((left, right) => (left < right ? -1 : left > right ? 1 : 0)),
	};
}
/** A referenced prerequisite has no activity clock of its own: a diagnostic on
 * it belongs to the one live root that declares it. Ambiguity is refused rather
 * than silently selecting a root or renewing every dependent. */
export function requiringRoots(
	run: EnvironmentRun,
	members: readonly EnvironmentRun[],
): EnvironmentRun[] {
	if (!referencedRoot(run.plan) || run.plan.projectKind === "app") return [];
	const live = members.filter(
		(member) =>
			member.owner === run.owner &&
			member.state === "running" &&
			member.plan.projectKind === "app" &&
			referencedRoot(member.plan) &&
			sharedRoot(member.plan) === sharedRoot(run.plan) &&
			(member.plan.requires ?? []).includes(run.plan.app),
	);
	const only = live[0];
	// A shared generation is read by every live root that declares it, and each of
	// those roots is what the read renews; ambiguity is refused elsewhere.
	if (live.length === 1 && only) return [only];
	if (sharedRoot(run.plan) && live.length) return live;
	throw new Error(
		"Referenced prerequisite diagnostics must name exactly one live requiring root; ambiguity is refused rather than renewing every dependent",
	);
}
export function batchApproved(
	waits: Record<string, string> | undefined,
	batch: string,
	owner: number,
): Plan[] | undefined {
	if (!waits) return undefined;
	for (const raw of Object.values(waits)) {
		try {
			const receipt = JSON.parse(raw) as {
				batch?: unknown;
				owner?: unknown;
				plans?: unknown;
				state?: unknown;
			};
			if (
				receipt.batch !== batch ||
				receipt.owner !== owner ||
				receipt.state !== "acquired" ||
				!Array.isArray(receipt.plans)
			)
				continue;
			return receipt.plans as Plan[];
		} catch {}
	}
	return undefined;
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
