import type { EnvironmentOwner } from "./model.ts";

export interface InstanceVariableContext {
	readonly owner: EnvironmentOwner;
	readonly appDir: string;
}

/**
 * Values passed to Compose or a script. An app runs once at a time with its own
 * static names and ports, so the owner and checkout directory are the only
 * values the definition needs: nothing is templated per instance.
 */
export function resolveInstanceVariables(
	context: InstanceVariableContext,
): Record<string, string> {
	return {
		AC_OWNER: context.owner,
		AC_APP_DIR: context.appDir,
	};
}
