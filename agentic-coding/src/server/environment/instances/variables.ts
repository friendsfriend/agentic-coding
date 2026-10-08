import type { EnvironmentOwner } from "./model.ts";

export interface InstanceVariableContext {
	readonly instanceId: string;
	readonly owner: EnvironmentOwner;
	readonly appDir: string;
	readonly ports?: Readonly<Record<string, number>>;
}

/** Values passed to Compose or a script; user ports remain unset for :-defaults. */
export function resolveInstanceVariables(
	context: InstanceVariableContext,
): Record<string, string> {
	const values: Record<string, string> = {
		AC_INSTANCE: context.instanceId,
		AC_OWNER: context.owner,
		AC_APP_DIR: context.appDir,
		AC_IMAGE_TAG: context.owner === "user" ? "latest" : context.instanceId,
	};
	if (context.owner !== "user") {
		for (const [name, port] of Object.entries(context.ports ?? {})) {
			values[`AC_PORT_${name}`] = String(port);
		}
	}
	return values;
}
