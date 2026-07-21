/** @jsxImportSource @opentui/solid */
import { TextAttributes } from '@opentui/core';
import { For, createMemo } from 'solid-js';
import type { MetricStore } from '../model/metricStore';
import { HighlightedText } from '../components/Highlight';
import { ScrollableContent } from '../components/ScrollableContent';
import { SearchHeader } from '../components/SearchHeader';
import { AutoscalingSparkline } from '../components/AutoscalingSparkline';
import { uiColors } from '../ui/colors';

const barChars = ['░', '▒', '▓', '█'];

export function MetricDetailView(props: {
  store: MetricStore;
  name: string;
  serviceName: string;
  onBack: () => void;
}) {
  const stream = createMemo(() => props.store.getStream(props.name, props.serviceName));
  const agg = createMemo(() => props.store.aggregate(stream()!));

  return <box style={{ width: '100%', height: '100%', flexDirection: 'column' }}>
    <SearchHeader><HighlightedText text={props.name} attributes={TextAttributes.BOLD} /></SearchHeader>
    <box height={1} flexShrink={0} paddingLeft={1}>
      <text fg={uiColors.textMuted}>{props.serviceName} · {stream()?.type} · {stream()?.unit || 'no unit'}</text>
    </box>
    <box height={3} flexDirection="row" paddingLeft={1} paddingRight={1}>
      <box style={{ width: '25%', flexDirection: 'column' }}>
        <text fg={uiColors.textMuted}>Avg</text>
        <text fg={uiColors.textPrimary}>{agg().avg.toFixed(2)}</text>
      </box>
      <box style={{ width: '25%', flexDirection: 'column' }}>
        <text fg={uiColors.textMuted}>Min</text>
        <text fg={uiColors.success}>{agg().min.toFixed(2)}</text>
      </box>
      <box style={{ width: '25%', flexDirection: 'column' }}>
        <text fg={uiColors.textMuted}>Max</text>
        <text fg={uiColors.error}>{agg().max.toFixed(2)}</text>
      </box>
      <box style={{ width: '25%', flexDirection: 'column' }}>
        <text fg={uiColors.textMuted}>Data points</text>
        <text fg={uiColors.textPrimary}>{agg().count}</text>
      </box>
    </box>
    <box height={3} paddingLeft={1} paddingRight={1}><AutoscalingSparkline values={stream()?.dataPoints.map(dp => dp.value) ?? []} /></box>

    {/* Histogram bar chart (if histogram) */}
    {stream()?.type === 'histogram' && stream()!.dataPoints[0]?.bucketCounts && <box height={4} flexDirection="column">
      <SearchHeader><HighlightedText text="Bucket distribution" highlight="secondary" /></SearchHeader>
      <box height={3} flexDirection="row" alignItems="flex-end" paddingLeft={1} paddingRight={1}>
        <For each={stream()!.dataPoints[0]!.bucketCounts}>{(count, index) => {
          const maxCount = Math.max(...(stream()!.dataPoints[0]!.bucketCounts ?? [1]));
          const barHeight = maxCount > 0 ? Math.max(1, Math.round((count / maxCount) * 3)) : 1;
          const label = stream()!.dataPoints[0]!.explicitBounds?.[index()]?.toFixed(0) ?? '';
          return <box style={{ flexDirection: 'column', alignItems: 'center', width: Math.max(3, 60 / (stream()!.dataPoints[0]!.bucketCounts?.length ?? 1)) }}>
            <text fg={uiColors.primary}>{barChars[barHeight - 1] ?? '█'.repeat(barHeight)}</text>
            <text fg={uiColors.textMuted}>{label}</text>
          </box>;
        }}</For>
      </box>
    </box>}

    {/* Data point table */}
    <SearchHeader><HighlightedText text="Data points" highlight="secondary" /></SearchHeader>
    <ScrollableContent>
      <For each={stream()?.dataPoints ?? []}>{(dp, index) =>
        <box height={1} flexShrink={0} flexDirection="row" paddingLeft={1} paddingRight={1}>
          <box style={{ width: 4, flexShrink: 0 }}><text fg={uiColors.textMuted}>{String(index() + 1).padEnd(3)}</text></box>
          <box style={{ width: 25, flexShrink: 0 }} overflow="hidden"><text fg={uiColors.textSecondary}>{new Date(Number(BigInt(dp.timeUnixNano) / 1_000_000n)).toISOString()}</text></box>
          <box style={{ width: 12, flexShrink: 0 }} justifyContent="flex-end"><text fg={uiColors.textPrimary}>{dp.value.toFixed(2)}</text></box>
          <box style={{ flexGrow: 1, minWidth: 0 }} overflow="hidden"><text fg={uiColors.textMuted}>{dp.attributes.map(a => `${a.key}=${a.value}`).join(' ')}</text></box>
        </box>
      }</For>
    </ScrollableContent>
  </box>;
}
