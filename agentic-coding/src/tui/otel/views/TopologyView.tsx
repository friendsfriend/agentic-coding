/** @jsxImportSource @opentui/solid */
import { createMemo, Show } from 'solid-js';
import type { TopologyStore } from '../model/topologyStore';
import { TopologyGraph } from '../components/TopologyGraph';
import { ScrollableContent } from '../components/ScrollableContent';
import { uiColors } from '../ui/colors';

export function TopologyView(props: {
  store: TopologyStore;
  selectedService: () => string | undefined;
  onSelect: (id: string) => void;
}) {
  const services = createMemo(() => props.store.getServices());
  const layout = createMemo(() => props.store.getLayout());
  const adjacency = createMemo(() => props.store.getAdjacencyList());
  const degraded = () => services().length > 50;

  return <box flexDirection="column" width="100%" height="100%">
    {degraded() && <box height={1} paddingLeft={1}><text fg={uiColors.warning}>&gt;50 services: adjacency list</text></box>}
    <Show when={services().length > 0} fallback={
      <box paddingLeft={1}><text fg={uiColors.textMuted}>No services found — load trace data first</text></box>
    }>
      <Show when={!degraded()} fallback={
        <ScrollableContent>
          {adjacency().map(line => <box height={1} paddingLeft={1}><text fg={uiColors.textSecondary}>{line}</text></box>)}
        </ScrollableContent>
      }>
        <TopologyGraph layout={layout} selected={props.selectedService} onSelect={props.onSelect} />
      </Show>
    </Show>
  </box>;
}
