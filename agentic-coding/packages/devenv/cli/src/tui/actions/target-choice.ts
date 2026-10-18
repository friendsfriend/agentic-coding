// Which target one developer-facing app action builds, tests or runs
// (`fix-default-target-after-promotion`).
//
// The bug: pressing Build in the Environments UI picked a target by *picker
// order* (index 0), so after an `env-setup` promotion the live Dockerfile was
// built although the gate had validated the promoted shell target beside it. The
// server now marks the authoritative default on the definitions it returns
// (`default`, `defaultTargetId`, `defaultReason`, `defaultAmbiguous`, from the
// same resolver the agent tools and the smoke check use), and this is the one
// rule the UI applies to that marking:
//
//   1. one available candidate — nothing to choose;
//   2. a candidate marked as the default — run it, whatever the order;
//   3. several candidates and no default — never preselect: refuse and name the
//      candidates and how to resolve it, or let the developer pick.
import type { ActionDefinition } from "@devenv/types";

/** The action the UI is about to perform. */
export type ActionChoice = "build" | "test" | "run";

export interface ActionTargetChoice {
	/** The target to run without asking. */
	readonly target?: ActionDefinition;
	/** Several candidates and no usable default: the caller must refuse (or
	 * ask), naming these and `reason`. */
	readonly ambiguous?: ActionDefinition[];
	/** One sentence explaining an ambiguity, when the server supplied one. */
	readonly reason?: string;
}

/**
 * Resolve the target the UI should run for one action. A definition marked
 * `default: true` always wins; without one, only a single available candidate is
 * run silently, and anything else is reported instead of picked.
 */
export function selectActionTarget(
	definitions: readonly ActionDefinition[],
	action: ActionChoice,
): ActionTargetChoice {
	const ofAction = definitions.filter(
		(definition) => definition.type === action,
	);
	if (ofAction.length === 0) return {};
	const available = ofAction.filter(
		(definition) => definition.availability.available,
	);
	// A declared default that cannot run now is still the default: silently
	// running a different family instead would repeat exactly the defect.
	const marked = ofAction.find((definition) => definition.default === true);
	if (marked) {
		if (marked.availability.available) return { target: marked };
		return {
			ambiguous: available,
			reason: `the default ${action} target ${marked.id} is unavailable (${marked.availability.reason ?? "no reason reported"}); declare another default in apps/defaults/<app>.json`,
		};
	}
	if (available.length === 0) return {};
	if (available.length === 1) return { target: available[0] };
	const ambiguous = available.filter(
		(definition) => definition.defaultAmbiguous === true,
	);
	if (ambiguous.length > 0)
		return {
			ambiguous,
			reason:
				ambiguous.find((definition) => definition.defaultReason)
					?.defaultReason ??
				`${ambiguous
					.map((definition) => definition.id)
					.join(
						", ",
					)} are default-profile ${action} targets of different runtime families; declare the default in apps/defaults/<app>.json`,
		};
	// Several candidates, nothing declared: the developer chooses. An empty
	// answer is the picker, never a preselected index.
	return {};
}
