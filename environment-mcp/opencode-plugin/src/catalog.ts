import type { UiActionDescriptor } from "../../src/ui/capability-api.ts";
import { fieldsFromSchema, type UiField } from "../../src/ui/controller.ts";

export type ActionGroup = "Inspect" | "Operate" | "Observe" | "Other";

const GROUPS: readonly ActionGroup[] = [
	"Inspect",
	"Operate",
	"Observe",
	"Other",
];

const KNOWN: Readonly<Record<string, ActionGroup>> = {
	env_list: "Inspect",
	env_history: "Inspect",
	env_services: "Inspect",
	env_operation: "Inspect",
	env_status: "Inspect",
	env_prepare_dependencies: "Operate",
	env_execute: "Operate",
	env_run: "Operate",
	env_stop: "Operate",
	env_wait: "Observe",
	env_telemetry: "Observe",
	env_logs: "Observe",
};

export function groupFor(action: UiActionDescriptor): ActionGroup {
	const known = KNOWN[action.name];
	if (known) return known;
	if (/(execute|run|stop|prepare|build|start)/.test(action.name))
		return "Operate";
	if (/(wait|telemetry|logs|history|status|services)/.test(action.name))
		return "Observe";
	if (action.annotations.readOnlyHint) return "Inspect";
	return "Other";
}

/** Case-insensitive, whitespace-separated terms; every term must match. */
export function filterActions(
	actions: readonly UiActionDescriptor[],
	query: string,
): readonly UiActionDescriptor[] {
	const terms = query.trim().toLowerCase().split(/\s+/).filter(Boolean);
	if (terms.length === 0) return actions;
	return actions.filter((action) => {
		const haystack = [
			action.label,
			action.name,
			action.description,
			groupFor(action),
		]
			.join(" ")
			.toLowerCase();
		return terms.every((term) => haystack.includes(term));
	});
}

export type ActionGrouping = {
	readonly group: ActionGroup;
	readonly actions: readonly UiActionDescriptor[];
};

export function groupActions(
	actions: readonly UiActionDescriptor[],
): readonly ActionGrouping[] {
	return GROUPS.flatMap((group) => {
		const selected = actions.filter((action) => groupFor(action) === group);
		return selected.length ? [{ group, actions: selected }] : [];
	});
}

export type BadgeTone = "success" | "error" | "warning" | "muted";

export type ActionBadge = {
	readonly label: string;
	readonly tone: BadgeTone;
};

export function actionBadges(
	action: UiActionDescriptor,
): readonly ActionBadge[] {
	const badges: ActionBadge[] = [];
	if (action.annotations.readOnlyHint)
		badges.push({ label: "read-only", tone: "success" });
	if (action.annotations.destructiveHint)
		badges.push({ label: "destructive", tone: "error" });
	if (action.annotations.idempotentHint)
		badges.push({ label: "idempotent", tone: "muted" });
	if (action.annotations.openWorldHint)
		badges.push({ label: "open-world", tone: "warning" });
	return badges;
}

export type FieldPreview =
	| { readonly fields: readonly UiField[] }
	| { readonly error: string };

export function previewFields(action: UiActionDescriptor): FieldPreview {
	try {
		return { fields: fieldsFromSchema(action.inputSchema) };
	} catch (error) {
		return {
			error: error instanceof Error ? error.message : "unsupported-input",
		};
	}
}

export function fieldChoices(field: UiField): readonly string[] | undefined {
	if (field.enumValues?.length) return field.enumValues;
	if (field.kind === "boolean") return ["false", "true"];
	return undefined;
}

export function shortTraceId(traceId: string): string {
	return traceId.length > 12 ? traceId.slice(0, 12) : traceId;
}
