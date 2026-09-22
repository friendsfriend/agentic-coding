/** @jsxImportSource @opentui/solid */

import type { FilterParameterOption, SortParameterOption } from "@ui";
import {
	FilterModal as SharedFilterModal,
	SortModal as SharedSortModal,
} from "@ui";
import type {
	SortCriterion,
	SortField,
	StatusFilter,
} from "../model/traceStore.ts";

const sortFields: Array<{ field: SortField; label: string }> = [
	{ field: "received", label: "Received time" },
	{ field: "latency", label: "Latency" },
	{ field: "service", label: "Service" },
	{ field: "name", label: "Span name" },
];

export const statusOptions: Array<{ value: StatusFilter; label: string }> = [
	{ value: "all", label: "All" },
	{ value: "error", label: "Error" },
	{ value: "success", label: "Success" },
];

/** Human labels for the span (event) types a developer filters on. Every other
 * event name keeps its raw name, so an unknown telemetry event stays
 * filterable without a label catalog entry. */
const SPAN_TYPE_LABELS: Record<string, string> = {
	"runtime.tool": "Tool calls",
	"runtime.tool_start": "Tool starts",
	"runtime.message": "LLM messages",
	"runtime.turn": "Model turns",
	"runtime.turn_started": "Turn starts",
	"runtime.provider_response": "Provider responses",
	"runtime.usage": "Token usage",
	"runtime.compaction": "Compaction",
	"runtime.model_selected": "Model selection",
	"agent.operation": "Agent operation",
	"agent.handoff": "Agent handoff",
};
const spanTypeLabel = (name: string) => SPAN_TYPE_LABELS[name] ?? name;

type Workspace = { changeId: string; spanCount: number };

export function FilterModal(props: {
	pane: () => "criteria" | "values";
	criterion: () => number;
	statusIndex: () => number;
	workspaceIndex: () => number;
	spanTypeIndex: () => number;
	workspaces: () => Workspace[];
	spanTypes: () => string[];
}) {
	const workspaceValues = () => [
		{ changeId: "all", spanCount: 0 },
		...props.workspaces(),
	];
	const spanTypeValues = () => ["all", ...props.spanTypes()];
	const isStatus = () => props.criterion() === 0;
	const isWorkspace = () => props.criterion() === 1;
	const statusParameter = (): FilterParameterOption => ({
		key: "status",
		label: `Status (${statusOptions[props.statusIndex()]?.label ?? "All"})`,
		values: statusOptions.map((option) => ({
			value: option.value,
			label: option.label,
		})),
	});
	const workspaceParameter = (): FilterParameterOption => ({
		key: "workspace",
		label: `Workspace (${workspaceValues()[props.workspaceIndex()]?.changeId ?? "all"})`,
		values: workspaceValues().map((workspace) => ({
			value: workspace.changeId,
			label:
				workspace.changeId === "all"
					? "all workspaces"
					: `${workspace.changeId} (${workspace.spanCount})`,
		})),
	});
	const spanTypeParameter = (): FilterParameterOption => {
		const current = spanTypeValues()[props.spanTypeIndex()] ?? "all";
		return {
			key: "spanType",
			label: `Span type (${current === "all" ? "all" : spanTypeLabel(current)})`,
			values: spanTypeValues().map((name) => ({
				value: name,
				label: name === "all" ? "all span types" : spanTypeLabel(name),
			})),
		};
	};
	return (
		<SharedFilterModal
			// The shell marks the row under the cursor; its value is applied on Enter.
			mark="cursor"
			parameterHeading="Criteria"
			focusedPane={props.pane() === "criteria" ? "parameter" : "value"}
			selectedParameterIndex={props.criterion()}
			selectedValueIndex={
				isStatus()
					? props.statusIndex()
					: isWorkspace()
						? props.workspaceIndex()
						: props.spanTypeIndex()
			}
			parameters={[
				statusParameter(),
				workspaceParameter(),
				spanTypeParameter(),
			]}
			activeFilters={{}}
		/>
	);
}

export function SortModal(props: {
	selected: () => number;
	criteria: () => SortCriterion[];
}) {
	const parameters = (): SortParameterOption[] =>
		props.criteria().map((criterion) => ({
			key: criterion.field,
			label:
				sortFields.find((item) => item.field === criterion.field)?.label ??
				criterion.field,
			direction: criterion.mode,
		}));
	return (
		<SharedSortModal
			selectedIndex={props.selected()}
			parameters={parameters()}
			directionLabels={{ asc: "↑ ASC", desc: "↓ DESC", none: "— NONE" }}
		/>
	);
}
