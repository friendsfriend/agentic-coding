/** @jsxImportSource @opentui/solid */
import { TextAttributes } from '@opentui/core';
import { useTerminalDimensions } from '@opentui/solid';
import { createMemo } from 'solid-js';
import type { TreeNode } from '../model/types';
import { HighlightedText } from '../components/Highlight';
import { SelectableList } from '../components/Selectable';
import { uiColors } from '../ui/colors';

const durationMs = (node: TreeNode) => Math.max(0, Number((BigInt(node.span.endTimeUnixNano) - BigInt(node.span.startTimeUnixNano)) / 1_000_000n));
const duration = (node: TreeNode) => `${durationMs(node)}ms`;
const runtimeColor = (share: number) => {
  const stops = [[166, 227, 161], [249, 226, 175], [243, 139, 168]];
  const position = Math.max(0, Math.min(1, share)) * (stops.length - 1); const index = Math.floor(position); const amount = position - index;
  const from = stops[index]!; const to = stops[Math.min(index + 1, stops.length - 1)]!;
  const rgb = from.map((value, channel) => Math.round(value + (to[channel]! - value) * amount));
  return `#${rgb.map(value => value.toString(16).padStart(2, '0')).join('')}`;
};

type Item = { node: TreeNode; path: number[] };

export function TraceTreeView(props: {
  roots: () => TreeNode[];
  selectedIndex: () => number;
  onToggle: (node: TreeNode, path: number[]) => void;
  onSelect: (path: number[]) => void;
}) {
  const size = useTerminalDimensions();
  const barWidth = () => Math.max(4, size().width - 67);
  const data = createMemo(() => {
    const flatten = (nodes: TreeNode[], parents: number[]): Item[] => nodes.flatMap((node, index) => { const path = [...parents, index]; return [{ node, path }, ...(node.expanded ? flatten(node.children, path) : [])]; });
    const all = (nodes: TreeNode[], parents: number[]): Item[] => nodes.flatMap((node, index) => { const path = [...parents, index]; return [{ node, path }, ...all(node.children, path)]; });
    const items = flatten(props.roots(), []);
    const timeline = all(props.roots(), []).sort((a, b) => Number(BigInt(a.node.span.startTimeUnixNano) - BigInt(b.node.span.startTimeUnixNano)));
    const actual = timeline.filter(item => item.node.span.scope.name !== 'viewer');
    const start = BigInt(actual[0]?.node.span.startTimeUnixNano ?? 0);
    const end = actual.reduce((latest, item) => { const value = BigInt(item.node.span.endTimeUnixNano); return value > latest ? value : latest; }, start);
    const total = Math.max(1, Number((end - start) / 1_000_000n));
    const largest = Math.max(...timeline.map(item => durationMs(item.node) / total)) || 1;
    const offsets = new Map<string, { offset: number; share: number; color: string }>();
    for (const item of timeline) { const share = durationMs(item.node) / total; offsets.set(item.node.span.spanId, { offset: Number((BigInt(item.node.span.startTimeUnixNano) - start) / 1_000_000n) / total, share, color: runtimeColor(share / largest) }); }
    return { items, offsets };
  });

  return <box flexDirection="column" width="100%" height="100%">
    {data().items.length > 0 && <SelectableList items={data().items} selectedIndex={props.selectedIndex} onSelect={index => props.onSelect(data().items[index]!.path)} renderItem={(item, selected) => {
      const { node, path } = item; const childMark = node.children.length ? (node.expanded ? '▼' : '▶') : '·';
      const status = node.span.status.code === 2 ? 'negative' : node.span.status.code === 1 ? 'warning' : 'positive';
      const runtime = data().offsets.get(node.span.spanId)!; const offset = Math.round(runtime.offset * barWidth()); const width = runtime.share ? Math.max(1, Math.round(runtime.share * barWidth())) : 0;
      const bar = `${' '.repeat(offset)}${'━'.repeat(Math.min(width, barWidth() - offset))}`;
      return <box height={1} flexDirection="row">
        <box width={42} flexShrink={0} overflow="hidden" flexDirection="row" paddingLeft={node.depth * 2}><box width={2} flexShrink={0} onMouseUp={() => node.children.length > 0 && props.onToggle(node, path)}><HighlightedText text={childMark} highlight={node.children.length ? 'secondary' : 'primary'} /></box><HighlightedText text={node.span.name} highlight={selected ? 'primary' : 'secondary'} attributes={selected ? TextAttributes.BOLD : 0} /></box>
        <box width={1} flexShrink={0} />
        <box flexGrow={1} flexShrink={1} minWidth={0} overflow="hidden" flexDirection="row"><text fg={uiColors.textMuted}>{`${(runtime.share * 100).toFixed(1).padStart(5)}% `}</text><text fg={runtime.color}>{bar}</text></box>
        <box width={1} flexShrink={0} />
        <box width={12} flexShrink={0} justifyContent="flex-end"><text fg={status === 'negative' ? uiColors.error : status === 'warning' ? uiColors.warning : uiColors.success}>{duration(node)}</text></box>
      </box>;
    }} />}
    {data().items.length === 0 && <box paddingLeft={1}><text fg={uiColors.textMuted}>Select a trace to view tree</text></box>}
  </box>;
}
