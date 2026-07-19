/** @jsxImportSource @opentui/solid */
import { createMemo, For } from 'solid-js';
import type { TopologyStore } from '../model/topologyStore';
import { HighlightedText } from '../components/Highlight';
import { SearchHeader } from '../components/SearchHeader';
import { ScrollableContent } from '../components/ScrollableContent';
import { uiColors } from '../ui/colors';

export function ServiceDetailView(props: { store: TopologyStore; id: string }) {
  const service = createMemo(() => props.store.getServices().find(s => s.id === props.id));
  const rows = () => [
    ['Spans', String(service()?.spanCount ?? 0)],
    ['Errors', String(service()?.errorCount ?? 0)],
    ['Avg duration', `${(service()?.avgDurationMs ?? 0).toFixed(1)}ms`],
  ];
  const dependencyRows = () => service()?.parentIds ?? [];
  const dependentRows = () => service()?.childIds ?? [];

  return <box width="100%" height="100%" flexDirection="column">
    <SearchHeader><HighlightedText text={props.id} highlight="primary" /></SearchHeader>
    <box height={1} flexShrink={0} paddingLeft={1}><text fg={uiColors.textMuted}>Service details</text></box>
    <ScrollableContent>
      <For each={rows()}>{([label, value]) => <box height={1} flexDirection="row" paddingLeft={1} paddingRight={1}>
        <box style={{ width: 16, flexShrink: 0 }}><HighlightedText text={label} highlight="secondary" /></box>
        <text fg={label === 'Errors' && Number(value) > 0 ? uiColors.error : uiColors.textPrimary}>{value}</text>
      </box>}</For>
      <SearchHeader><HighlightedText text="Dependencies" highlight="secondary" /></SearchHeader>
      <For each={dependencyRows()} fallback={<box paddingLeft={1}><text fg={uiColors.textMuted}>No upstream dependencies</text></box>}>
        {(id) => <box height={1} paddingLeft={1}><text fg={uiColors.textSecondary}>{id}</text></box>}
      </For>
      <SearchHeader><HighlightedText text="Dependents" highlight="secondary" /></SearchHeader>
      <For each={dependentRows()} fallback={<box paddingLeft={1}><text fg={uiColors.textMuted}>No downstream dependents</text></box>}>
        {(id) => <box height={1} paddingLeft={1}><text fg={uiColors.textSecondary}>{id}</text></box>}
      </For>
    </ScrollableContent>
  </box>;
}
