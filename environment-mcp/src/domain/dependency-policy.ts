/** Adapted from v1 actions/target-compile.ts (default shared) and runtime/leases.ts
 * (only owned cleanup). This decides intent, never proves resource identity. */
export type DependencyLifecycle = "shared" | "external" | "owned";
export type DependencyObservation =
	| { state: "absent" | "unknown" }
	| {
			state: "ready" | "unready";
			identityMatches: boolean;
			ownedByController: boolean;
	  };

export function decideDependencyUse(
	lifecycle: DependencyLifecycle,
	observation: DependencyObservation,
) {
	const cleanup = lifecycle === "owned" ? "when-unreferenced" : "never";
	if (observation.state === "unknown")
		return {
			action: "refuse",
			reason: "observation-unavailable",
			cleanup: "never",
		} as const;
	if (observation.state === "absent")
		return lifecycle === "external"
			? ({
					action: "refuse",
					reason: "external-unavailable",
					cleanup: "never",
				} as const)
			: ({ action: "start", cleanup } as const);
	if (!("identityMatches" in observation) || !observation.identityMatches)
		return {
			action: "refuse",
			reason: "identity-mismatch",
			cleanup: "never",
		} as const;
	if (lifecycle === "owned" && !observation.ownedByController)
		return {
			action: "refuse",
			reason: "foreign-owned-resource",
			cleanup: "never",
		} as const;
	return {
		action: observation.state === "ready" ? "reuse" : "wait",
		cleanup,
	} as const;
}
