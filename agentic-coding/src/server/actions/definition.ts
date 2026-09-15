// Immutable environment-action definitions and their validation
// (`port-action-execution-to-bun`, task 1.3).
//
// Ported from `server/pkg/actiondef/{types,descriptor,validate}.go`.
//
// The definition model is the wire model: `GET /api/action-definition` returns
// a definition verbatim and `GET /api/apps/{ident}/actions` returns a list of
// them, so the compiler output, the registry snapshot and the route payload are
// one shape — reusing the client's `ActionDefinition` types rather than a
// second server-internal model. Immutability is by construction: `newAction`
// deep-copies what it is given, so a registry snapshot can never be mutated
// through a caller's reference.
import type {
	ActionDefinition,
	ActionInputDefinition,
	ActionResourceRef,
	ActionStepDefinition,
	ActionValuePort,
} from "@devenv/types";

/** Step kinds that execute nothing themselves. */
export const COMPOSITE_KIND = "composite";

/**
 * Rejects definitions that cannot execute deterministically. Mirrors the Go
 * walk order exactly: a definition that fails validation must fail with the
 * same diagnostic, because the message is logged and surfaced as the registry
 * status error.
 */
export function validateAction(
	action: ActionDefinition,
	handlers?: { has(kind: string): boolean },
): void {
	if (action.id === "") throw new Error("action id is required");
	if (action.owner.id === "") {
		throw new Error(`action ${action.id}: owner id is required`);
	}
	if (!action.root) {
		throw new Error(`action ${action.id}: root step is required`);
	}

	// Go ranges over a nil slice happily, and a definition that came off the
	// wire carries `null` rather than `[]`.
	const available = new Map<string, ActionValuePort>();
	for (const input of action.inputs ?? []) {
		if (input.key === "" || input.type === "") {
			throw new Error(`action ${action.id}: input key and type are required`);
		}
		if (available.has(input.key)) {
			throw new Error(`action ${action.id}: duplicate input ${input.key}`);
		}
		available.set(input.key, input);
	}

	const seen = new Set<string>();
	const visiting = new Set<string>();
	const walk = (step: ActionStepDefinition): void => {
		if (step.id === "") {
			throw new Error(`action ${action.id}: step id is required`);
		}
		if (visiting.has(step.id)) {
			throw new Error(`action ${action.id}: cycle at step ${step.id}`);
		}
		if (seen.has(step.id)) {
			throw new Error(`action ${action.id}: duplicate step id ${step.id}`);
		}
		seen.add(step.id);
		visiting.add(step.id);
		try {
			// A definition read from a request body can carry a missing kind even
			// though the model requires one, which is why Go checks it too.
			const kind: string = step.kind;
			if (kind === "") {
				throw new Error(`step ${step.id}: kind is required`);
			}
			if (
				kind !== COMPOSITE_KIND &&
				handlers !== undefined &&
				!handlers.has(kind)
			) {
				throw new Error(`step ${step.id}: no handler for kind ${kind}`);
			}
			for (const input of step.consumes ?? []) {
				const producer = available.get(input.key);
				if (!producer && input.required) {
					throw new Error(`step ${step.id}: missing producer for ${input.key}`);
				}
				if (producer && producer.type !== input.type) {
					throw new Error(
						`step ${step.id}: value ${input.key} type ${producer.type} does not match ${input.type}`,
					);
				}
			}
			for (const output of step.produces ?? []) {
				const previous = available.get(output.key);
				if (previous && output.scope !== "step") {
					throw new Error(
						`step ${step.id}: duplicate output ${output.key} previously ${previous.type}`,
					);
				}
				if (
					previous &&
					previous.visibility === "secret" &&
					output.visibility === "public"
				) {
					throw new Error(
						`step ${step.id}: secret value ${output.key} cannot become public`,
					);
				}
				available.set(output.key, output);
			}
			for (const child of step.children ?? []) walk(child);
		} finally {
			visiting.delete(step.id);
		}
	};
	walk(action.root);
}

function copyStep(step: ActionStepDefinition): ActionStepDefinition {
	return {
		...step,
		...(step.children ? { children: step.children.map(copyStep) } : {}),
		...(step.consumes
			? { consumes: step.consumes.map((p) => ({ ...p })) }
			: {}),
		...(step.produces
			? { produces: step.produces.map((p) => ({ ...p })) }
			: {}),
		...(step.configuration ? { configuration: { ...step.configuration } } : {}),
	};
}

/** A definition whose arrays and configuration belong to no caller. */
export function newAction(action: ActionDefinition): ActionDefinition {
	return {
		...action,
		owner: { ...action.owner },
		inputs: (action.inputs ?? []).map((input) => ({ ...input })),
		availability: { ...action.availability },
		root: copyStep(action.root),
	};
}

export type {
	ActionDefinition,
	ActionInputDefinition,
	ActionResourceRef,
	ActionStepDefinition,
	ActionValuePort,
};
