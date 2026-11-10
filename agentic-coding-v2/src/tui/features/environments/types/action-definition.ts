export type ActionStepKind =
	| "composite"
	| "command"
	| "process"
	| "readiness"
	| "operation"
	| "cleanup";
export type ActionValueScope = "action" | "composite" | "step";
export type ActionValueVisibility =
	| "public"
	| "internal"
	| "secret"
	| "ephemeral";
export interface ActionResourceRef {
	kind: string;
	id: string;
}
export interface ActionAvailability {
	available: boolean;
	reason?: string;
}
export interface ActionValuePort {
	key: string;
	type: string;
	scope: ActionValueScope;
	visibility: ActionValueVisibility;
	required?: boolean;
}
export interface ActionInputDefinition extends ActionValuePort {
	label?: string;
	description?: string;
	default?: unknown;
}
export interface ActionStepDefinition {
	id: string;
	executionKey?: string;
	kind: ActionStepKind;
	label: string;
	children?: ActionStepDefinition[];
	condition?: "always" | "on-success" | "on-failure";
	failurePolicy?: "stop" | "continue" | "always-run";
	consumes?: ActionValuePort[];
	produces?: ActionValuePort[];
	handler?: string;
	configuration?: Record<string, unknown>;
}
export interface ActionDefinition {
	id: string;
	owner: ActionResourceRef;
	type: string;
	runtime: string;
	label: string;
	inputs: ActionInputDefinition[];
	availability: ActionAvailability;
	root: ActionStepDefinition;
	/** The authoritative default of this action, marked by the server
	 * (`fix-default-target-after-promotion`): the one target every consumer
	 * agrees on — declared in `apps/defaults/<app>.json`, or the only runtime
	 * family on offer. The UI runs this one instead of preselecting a picker. */
	default?: boolean;
	/** The discovered target id the default resolves to, so a consumer can name
	 * the same target the build/run actually ran. */
	defaultTargetId?: string;
	/** Why this target is the default (declared / only candidate / preference). */
	defaultReason?: string;
	/** No default could be decided: several runtime families are live and nothing
	 * declares which one wins. An interactive consumer must not guess. */
	defaultAmbiguous?: boolean;
}
export interface ActionDefinitionList {
	version: number;
	actions: ActionDefinition[];
}
