/** @jsxImportSource @opentui/solid */
import { TextAttributes } from '@opentui/core';
import { useTerminalDimensions } from '@opentui/solid';
import { For, createMemo } from 'solid-js';
import type { TreeNode } from '../model/types';
import { HighlightedText } from '../components/Highlight';
import { Selectable } from '../components/Selectable';
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
const spanKey = (node: TreeNode) => `${node.span.traceId}:${node.span.spanId}`;

export function treeWindow(count: number, selected: number, rows: number) {
  if (count <= 0) return { start: 0, end: 0 };
  const size = Math.min(count, Math.max(1, rows));
  const index = Math.max(0, Math.min(count - 1, selected));
  const start = Math.min(Math.max(0, index - Math.floor(size / 2)), count - size);
  return { start, end: start + size };
}

export function TraceTreeView(props: {
  roots: () => TreeNode[];
  selectedIndex: () => number;
  onToggle: (node: TreeNode, path: number[]) => void;
  onSelect: (path: number[]) => void;
}) {
  const size = useTerminalDimensions();
  const barWidth = () => Math.max(4, size().width - 67);
  const data = createMemo(() => {
    const parentShares = new Map<string, number>();
    const items: Item[] = [];
    const timeline: Item[] = [];
    const visit = (nodes: TreeNode[], parents: number[], parent?: TreeNode, visible = true) => {
      for (const [index, node] of nodes.entries()) {
        const path = [...parents, index];
        const item = { node, path };
        timeline.push(item);
        if (visible) items.push(item);
        parentShares.set(spanKey(node), parent ? durationMs(node) / Math.max(1, durationMs(parent)) : 1);
        visit(node.children, path, node, visible && node.expanded);
      }
    };
    visit(props.roots(), []);
    timeline.sort((a, b) => Number(BigInt(a.node.span.startTimeUnixNano) - BigInt(b.node.span.startTimeUnixNano)));
    const actual = timeline.filter(item => item.node.span.scope.name !== 'viewer');
    if (!actual.length) return { items: [], offsets: new Map<string, { offset: number; share: number; parentShare: number; color: string }>() };
    const start = BigInt(actual[0].node.span.startTimeUnixNano);
    const end = actual.reduce((latest, item) => { const value = BigInt(item.node.span.endTimeUnixNano); return value > latest ? value : latest; }, start);
    const total = Math.max(1, Number((end - start) / 1_000_000n));
    const offsets = new Map<string, { offset: number; share: number; parentShare: number; color: string }>();
    for (const item of timeline) {
      const share = durationMs(item.node) / total;
      const parentShare = parentShares.get(spanKey(item.node)) ?? 1;
      const root = item.path.length === 1;
      offsets.set(spanKey(item.node), {
        offset: Number((BigInt(item.node.span.startTimeUnixNano) - start) / 1_000_000n) / total,
        share,
        parentShare,
        color: root ? uiColors.success : runtimeColor(parentShare),
      });
    }
    return { items, offsets };
  });
  const rows = createMemo(() => {
    const { items } = data();
    const window = treeWindow(items.length, props.selectedIndex(), size().height - 8);
    return { ...window, items: items.slice(window.start, window.end) };
  });

  return <box flexDirection="column" width="100%" height="100%">
    {data().items.length > 0 && <box flexGrow={1} minHeight={0} overflow="hidden" flexDirection="column"><For each={rows().items}>{(item, index) => {
      const fullIndex = () => rows().start + index();
      const selected = () => fullIndex() === props.selectedIndex();
      const { node, path } = item; const childMark = node.children.length ? (node.expanded ? '▼' : '▶') : '·';
      const status = node.span.status.code === 2 ? 'negative' : node.span.status.code === 1 ? 'warning' : 'positive';
      const runtime = data().offsets.get(spanKey(node)) ?? { offset: 0, share: 0, parentShare: 0, color: uiColors.textMuted }; const offset = Math.max(0, Math.min(barWidth(), Math.round(runtime.offset * barWidth()))); const width = runtime.share ? Math.max(1, Math.round(runtime.share * barWidth())) : 0;
      const bar = `${' '.repeat(offset)}${'━'.repeat(Math.min(width, Math.max(0, barWidth() - offset)))}`;
      return <Selectable selected={selected()} height={1} onMouseUp={() => props.onSelect(path)}><box height={1} flexDirection="row">
        <box width={42} flexShrink={0} overflow="hidden" flexDirection="row" paddingLeft={node.depth * 2}><box width={2} flexShrink={0} onMouseUp={() => node.children.length > 0 && props.onToggle(node, path)}><HighlightedText text={childMark} highlight={node.children.length ? 'secondary' : 'primary'} /></box><HighlightedText text={node.span.name} highlight={selected() ? 'primary' : 'secondary'} attributes={selected() ? TextAttributes.BOLD : 0} /></box>
        <box width={1} flexShrink={0} />
        <box flexGrow={1} flexShrink={1} minWidth={0} overflow="hidden" flexDirection="row"><text fg={uiColors.textMuted}>{`${(runtime.parentShare * 100).toFixed(1).padStart(5)}% `}</text><text fg={runtime.color}>{bar}</text></box>
        <box width={1} flexShrink={0} />
        <box width={12} flexShrink={0} justifyContent="flex-end"><text fg={status === 'negative' ? uiColors.error : status === 'warning' ? uiColors.warning : uiColors.success}>{duration(node)}</text></box>
      </box></Selectable>;
    }}</For></box>}
    {data().items.length === 0 && <box paddingLeft={1}><text fg={uiColors.textMuted}>Select a trace to view tree</text></box>}
  </box>;
}
