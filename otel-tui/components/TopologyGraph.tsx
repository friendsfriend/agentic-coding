/** @jsxImportSource @opentui/solid */
import { TextAttributes } from '@opentui/core';
import { For, createMemo } from 'solid-js';
import type { LayoutNode } from '../model/topologyStore';
import { HighlightedText } from './Highlight';
import { ScrollableContent } from './ScrollableContent';
import { uiColors } from '../ui/colors';

const cardWidth = 24;
const cardHeight = 3;

export function TopologyGraph(props: {
  layout: () => LayoutNode[];
  selected: () => string | undefined;
  onSelect: (id: string) => void;
}) {
  const layers = createMemo(() => {
    const map = new Map<number, LayoutNode[]>();
    for (const node of props.layout()) {
      const layer = map.get(node.layer) ?? [];
      layer.push(node);
      map.set(node.layer, layer);
    }
    return [...map.entries()].sort(([a], [b]) => a - b);
  });
  const graphHeight = () => Math.max(6, Math.max(...layers().map(([, nodes]) => nodes.length), 1) * (cardHeight + 1) + 1);

  return <ScrollableContent>
    <box style={{ minWidth: Math.max(60, layers().length * (cardWidth + 3)), height: graphHeight(), flexDirection: 'row', padding: 1 }}>
      <For each={layers()}>{([layer, nodes], index) => <>
        <box style={{ width: cardWidth, flexShrink: 0, flexDirection: 'column' }}>
          <box height={1} backgroundColor={uiColors.bgSurface1} paddingLeft={1}>
            <text fg={uiColors.textMuted} attributes={TextAttributes.BOLD}>Layer {layer}</text>
          </box>
          <For each={nodes}>{(ln) => {
            const selected = () => props.selected() === ln.id;
            return <box
              height={cardHeight}
              width={cardWidth}
              flexShrink={0}
              flexDirection="column"
              backgroundColor={selected() ? uiColors.bgSurface1 : uiColors.bgMantle}
              onMouseUp={() => props.onSelect(ln.id)}
            >
              <box width={1} height={cardHeight} position="absolute" backgroundColor={selected() ? uiColors.accent : uiColors.border} />
              <box paddingLeft={2} paddingRight={1} overflow="hidden"><HighlightedText text={ln.id} highlight={selected() ? 'primary' : 'secondary'} attributes={TextAttributes.BOLD} /></box>
              <box paddingLeft={2} paddingRight={1} flexDirection="row">
                <text fg={uiColors.textMuted}>{ln.node.spanCount} spans · {ln.node.avgDurationMs.toFixed(1)}ms</text>
              </box>
              <box paddingLeft={2}><text fg={ln.node.errorCount ? uiColors.error : uiColors.success}>{ln.node.errorCount ? `${ln.node.errorCount} errors` : 'healthy'}</text></box>
            </box>;
          }}</For>
        </box>
        {index() < layers().length - 1 && <box width={3} height={graphHeight()} flexShrink={0} justifyContent="center">
          <text fg={uiColors.textMuted}>──▶</text>
        </box>}
      </>}</For>
    </box>
  </ScrollableContent>;
}
