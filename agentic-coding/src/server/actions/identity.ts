// Stable environment-action identity (`port-action-execution-to-bun`, task 1.2).
//
// Ported from `server/pkg/actiondef/descriptor.go` (`StableID`) and the id
// compositions used by `pkg/actionregistry` and `pkg/resources`. Identity is
// configuration-derived and never includes display labels, array order or
// checkout paths: a compiled action id, its root/step ids and the resolved
// `ActionTarget.ID` are what history, the TUI and the run tree key on, so
// recomputing them differently after a reload would silently re-point history
// at a different action.
//
// Every composition the Go compilers perform has exactly one builder here.
// Compilation code must call these rather than joining strings itself.

/** Joins non-empty, `/`-trimmed parts with `/`. */
export function stableId(...parts: readonly string[]): string {
	const clean: string[] = [];
	for (const part of parts) {
		const trimmed = part.trim().replace(/^\/+|\/+$/g, "");
		if (trimmed !== "") clean.push(trimmed);
	}
	return clean.join("/");
}

/**
 * Compiles one action id for a resource-owned action: `<kind>/<id>/action/
 * <action>/<runtime>/<profile>` with the profile defaulting to `default`.
 *
 * The Go compilers spell this composition once per producer (git, compose
 * lifecycle, container target, infrastructure, kubernetes cluster, generic
 * operation); they all reduce to this shape.
 */
export function resourceActionId(
	resourceKind: string,
	resourceId: string,
	action: string,
	runtime: string,
	profile = "default",
): string {
	return stableId(resourceKind, resourceId, "action", action, runtime, profile);
}

/** `<actionId>/step/<...parts>`. */
export function stepId(actionId: string, ...parts: string[]): string {
	return stableId(actionId, "step", ...parts);
}

/** `stableId(targetStepId, ...parts)` — a nested child under a semantic step. */
export function nestedStepId(parentStepId: string, ...parts: string[]): string {
	return stableId(parentStepId, ...parts);
}

/**
 * `ActionTarget.ID`: the client-visible, configuration-derived identity of a
 * discovered build/test/run target. Ported from `actionTargetID`
 * (`pkg/resources/action_targets.go`).
 */
export function actionTargetId(
	appIdent: string,
	action: string,
	runtime: string,
	profile: string,
): string {
	if (appIdent === "") {
		return profile === ""
			? `${action}:${runtime}`
			: `${action}:${runtime}:${profile}`;
	}
	return profile === ""
		? `app/${appIdent}/${action}/${runtime}`
		: `app/${appIdent}/${action}/${runtime}/${profile}`;
}
