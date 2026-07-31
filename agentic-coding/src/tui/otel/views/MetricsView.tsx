/** @jsxImportSource @opentui/solid */
import { TextAttributes } from '@opentui/core';
import { createMemo, For } from 'solid-js';
import type { MetricStore } from '../model/metricStore';
import { AutoscalingSparkline } from '../components/AutoscalingSparkline';
import { HighlightedText } from '../components/Highlight';
import { ScrollableContent } from '../components/ScrollableContent';
import { SearchHeader } from '../components/SearchHeader';
import { uiColors } from '../ui/colors';

const metricColor = (type: string) => type === 'histogram' ? uiColors.accent : type === 'sum' ? uiColors.success : uiColors.primary;

export function MetricsView(props: {
  store: MetricStore;
  selectedIndex: () => number;
  onSelectIndex: (index: number) => void;
  onOpen: (name: string, serviceName: string) => void;
}) {
  const streams = createMemo(() => props.store.getStreams());

  return <box flexDirection="column" width="100%" height="100%">
    <SearchHeader>
      <text fg={uiColors.textMuted} attributes={TextAttributes.BOLD}>Metrics  ({props.store.filteredCount_})</text>
    </SearchHeader>
    {streams().length > 0 && <ScrollableContent>
      <For each={streams()}>{(stream, index) => {
        const selected = () => index() === props.selectedIndex();
        const agg = props.store.aggregate(stream);
        return <box
          height={3}
          width="100%"
          flexShrink={0}
          flexDirection="row"
          backgroundColor={selected() ? uiColors.bgSurface1 : uiColors.bgMantle}
          onMouseUp={() => {
            props.onSelectIndex(index());
            props.onOpen(stream.name, stream.serviceName);
          }}
        >
          <box width={1} height={3} flexShrink={0} backgroundColor={selected() ? uiColors.accent : uiColors.bgMantle} />
          <box height={3} flexGrow={1} minWidth={0} flexDirection="column" paddingRight={1}>
            <box height={1} width="100%" flexDirection="row">
              <box width="60%" flexShrink={0} overflow="hidden">
                <HighlightedText text={stream.name} highlight={selected() ? 'primary' : 'secondary'} />
              </box>
              <box width="40%" flexShrink={0} overflow="hidden">
                <text fg={uiColors.textMuted}>{stream.serviceName} · {stream.type} · {stream.unit || '—'} · {agg.avg.toFixed(2)}</text>
              </box>
            </box>
            <box height={2} width="100%">
              <AutoscalingSparkline values={stream.dataPoints.map(point => point.value)} color={metricColor(stream.type)} backgroundColor={selected() ? uiColors.bgSurface1 : uiColors.bgMantle} />
            </box>
          </box>
        </box>;
      }}</For>
    </ScrollableContent>}
    {streams().length === 0 && <box paddingLeft={1}><text fg={uiColors.textMuted}>No metrics loaded</text></box>}
  </box>;
}
