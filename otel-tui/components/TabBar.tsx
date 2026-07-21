/** @jsxImportSource @opentui/solid */
import { TextAttributes } from '@opentui/core';
import { For } from 'solid-js';
import { uiColors } from '../ui/colors';

export interface TabProps { id: string; label: string; count?: number; active: boolean; onSelect?: () => void; }
/** Exact Devenv main-table tab visual: 3 lines tall, surface-active / mantle-idle. */
export function Tab(props: TabProps) {
  return <box backgroundColor={props.active ? uiColors.bgSurface0 : uiColors.bgMantle} onMouseUp={props.onSelect} style={{ paddingLeft: 2, paddingRight: 2, height: 3, flexShrink: 0, alignItems: 'center', justifyContent: 'center' }}>
    <text fg={props.active ? uiColors.primary : uiColors.textMuted} attributes={props.active ? TextAttributes.BOLD : undefined}>{props.label}{props.count !== undefined ? ` (${props.count})` : ''}</text>
  </box>;
}

export function TabBar(props: { tabs: Array<Omit<TabProps, 'active' | 'onSelect'>>; activeId: string; onSelect?: (id: string) => void }) {
  return <box backgroundColor={uiColors.bgBase} style={{ width: '100%', height: 3, flexShrink: 0, flexDirection: 'row', gap: 1 }}>
    <For each={props.tabs}>{tab => <Tab {...tab} active={tab.id === props.activeId} onSelect={() => props.onSelect?.(tab.id)} />}</For>
  </box>;
}
