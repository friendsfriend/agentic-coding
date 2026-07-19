/** @jsxImportSource @opentui/solid */
import { For } from 'solid-js';
import type { SortCriterion, SortField, StatusFilter } from '../model/traceStore';
import { uiColors } from '../ui/colors';
import { GenericModal } from './GenericModal';

const sortFields: Array<{ field: SortField; label: string }> = [
  { field: 'received', label: 'Received time' },
  { field: 'latency', label: 'Latency' },
  { field: 'service', label: 'Service' },
  { field: 'name', label: 'Span name' },
];

export const statusOptions: Array<{ value: StatusFilter; label: string }> = [
  { value: 'all', label: 'All' },
  { value: 'error', label: 'Error' },
  { value: 'success', label: 'Success' },
];

type Workspace = { changeId: string; spanCount: number };

export function FilterModal(props: {
  pane: () => 'criteria' | 'values'; criterion: () => number; statusIndex: () => number; workspaceIndex: () => number;
  workspaces: () => Workspace[];
}) {
  const workspaceValues = () => [{ changeId: 'all', spanCount: 0 }, ...props.workspaces()];
  const isStatus = () => props.criterion() === 0;
  const selectedValue = () => isStatus() ? props.statusIndex() : props.workspaceIndex();
  const criteria = () => [
    `Status (${statusOptions[props.statusIndex()]?.label ?? 'All'})`,
    `Workspace (${workspaceValues()[props.workspaceIndex()]?.changeId ?? 'all'})`,
  ];
  return <GenericModal title="Filter" widthPercent={.7} heightPercent={.65} help={[{ key: 'h/l', action: 'Focus' }, { key: 'j/k', action: 'Move' }, { key: 'Enter', action: 'Apply' }, { key: 'x', action: 'Reset' }, { key: 'Esc', action: 'Cancel' }]}>
    <box style={{ width: '100%', height: '100%', flexDirection: 'row', gap: 2 }}>
      <box style={{ width: '35%', flexDirection: 'column' }}>
        <text fg={props.pane() === 'criteria' ? uiColors.primary : uiColors.textPrimary}>Criteria</text>
        <For each={criteria()}>{(criterion, index) => <box height={1} backgroundColor={index() === props.criterion() ? uiColors.bgSurface1 : uiColors.bgMantle} style={{ paddingLeft: 1 }}><text fg={index() === props.criterion() ? uiColors.primary : uiColors.textSecondary}>{criterion}</text></box>}</For>
      </box>
      <box style={{ width: '65%', flexDirection: 'column' }}>
        <text fg={props.pane() === 'values' ? uiColors.primary : uiColors.textPrimary}>{isStatus() ? 'Status' : 'Workspace'}</text>
        {isStatus() ? <For each={statusOptions}>{(option, index) => <box height={1} backgroundColor={index() === selectedValue() ? uiColors.bgSurface1 : uiColors.bgMantle} style={{ flexDirection: 'row', paddingLeft: 1 }}><text fg={index() === selectedValue() ? uiColors.success : uiColors.textMuted}>{index() === selectedValue() ? '● ' : '○ '}</text><text fg={index() === selectedValue() ? uiColors.textPrimary : uiColors.textSecondary}>{option.label}</text></box>}</For> : <For each={workspaceValues()}>{(workspace, index) => <box height={1} backgroundColor={index() === selectedValue() ? uiColors.bgSurface1 : uiColors.bgMantle} style={{ flexDirection: 'row', paddingLeft: 1 }}><text fg={index() === selectedValue() ? uiColors.success : uiColors.textMuted}>{index() === selectedValue() ? '● ' : '○ '}</text><text fg={index() === selectedValue() ? uiColors.textPrimary : uiColors.textSecondary}>{workspace.changeId}{workspace.changeId === 'all' ? ' workspaces' : ` (${workspace.spanCount})`}</text></box>}</For>}
      </box>
    </box>
  </GenericModal>;
}

export function SortModal(props: { selected: () => number; criteria: () => SortCriterion[] }) {
  const label = (field: SortCriterion['field']) => sortFields.find(item => item.field === field)?.label ?? field;
  const mode = (value: SortCriterion['mode']) => value === 'asc' ? '↑ ASC' : value === 'desc' ? '↓ DESC' : '— NONE';
  return <GenericModal title="Order / Sort" widthPercent={.6} heightPercent={.55} help={[{ key: 'j/k', action: 'Select' }, { key: 'Space', action: 'Mode' }, { key: 'Shift+J/K', action: 'Priority' }, { key: 'Enter', action: 'Apply' }, { key: 'Esc', action: 'Cancel' }]}>
    <box style={{ width: '100%', flexDirection: 'column', paddingTop: 1 }}>
      <box height={1} flexDirection="row" paddingLeft={1}><box width={5}><text fg={uiColors.textPrimary}>Prio</text></box><box style={{ width: '60%' }}><text fg={uiColors.textPrimary}>Parameter</text></box><text fg={uiColors.textPrimary}>Mode</text></box>
      <For each={props.criteria()}>{(item, index) => <box height={1} backgroundColor={index() === props.selected() ? uiColors.bgSurface1 : uiColors.bgMantle} style={{ flexDirection: 'row', paddingLeft: 1 }}><box width={5}><text fg={uiColors.textMuted}>{index() + 1}</text></box><box style={{ width: '60%' }}><text fg={index() === props.selected() ? uiColors.textPrimary : uiColors.textSecondary}>{label(item.field)}</text></box><text fg={item.mode === 'none' ? uiColors.textMuted : uiColors.primary}>{mode(item.mode)}</text></box>}</For>
    </box>
  </GenericModal>;
}

