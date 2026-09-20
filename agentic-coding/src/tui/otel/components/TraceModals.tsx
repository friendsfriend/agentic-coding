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

type Workspace = { changeId: string; spanCount: number };

export function FilterModal(props: {
	pane: () => "criteria" | "values";
	criterion: () => number;
	statusIndex: () => number;
	workspaceIndex: () => number;
	workspaces: () => Workspace[];
}) {
	const workspaceValues = () => [
		{ changeId: "all", spanCount: 0 },
		...props.workspaces(),
	];
	const isStatus = () => props.criterion() === 0;
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
	return (
		<SharedFilterModal
			// The shell marks the row under the cursor; its value is applied on Enter.
			mark="cursor"
			parameterHeading="Criteria"
			focusedPane={props.pane() === "criteria" ? "parameter" : "value"}
			selectedParameterIndex={props.criterion()}
			selectedValueIndex={
				isStatus() ? props.statusIndex() : props.workspaceIndex()
			}
			parameters={[statusParameter(), workspaceParameter()]}
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
