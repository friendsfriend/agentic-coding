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
}
export interface ActionDefinitionList {
	version: number;
	actions: ActionDefinition[];
}
