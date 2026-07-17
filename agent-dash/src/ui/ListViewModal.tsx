/** @jsxImportSource @opentui/solid */
import { Show, type JSX } from 'solid-js';
import { GenericModal, type HelpEntry, type SummaryEntry } from './GenericModal';
import { uiColors } from './colors';
import { SelectableList } from './Selectable';

export function ListViewModal<T>(props: { title: string; fieldLabel?: string; items: T[]; selectedIndex: number; renderItem: (item: T, selected: boolean) => JSX.Element; help: HelpEntry[]; summary?: SummaryEntry[]; step?: number; total?: number; filterQuery?: string; filterActive?: boolean; heightPercent?: number }) {
  return <GenericModal title={props.title} fieldLabel={props.fieldLabel} step={props.step} total={props.total} summary={props.summary} search={props.filterActive ? props.filterQuery ?? '' : undefined} help={props.help} heightPercent={props.heightPercent ?? 0.6}>
    <Show when={props.items.length} fallback={<text fg={uiColors.textMuted}>No matching values</text>}>
      <SelectableList items={props.items} selectedIndex={props.selectedIndex} renderItem={(item, selected) => <box width="100%" height={1} flexShrink={0} overflow="hidden">{props.renderItem(item, selected)}</box>} />
    </Show>
  </GenericModal>;
}
