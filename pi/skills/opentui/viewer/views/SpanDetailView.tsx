/** @jsxImportSource @opentui/solid */
import { TextAttributes } from '@opentui/core';
import type { TreeNode } from '../model/types';
import { ScrollableContent } from '../components/ScrollableContent';
import { HighlightedText } from '../components/Highlight';
import { SearchHeader } from '../components/SearchHeader';
import { uiColors } from '../ui/colors';

const duration = (node: TreeNode) => `${Math.max(0, Number((BigInt(node.span.endTimeUnixNano) - BigInt(node.span.startTimeUnixNano)) / 1_000_000n))}ms`;
const title = (key: string) => key === 'herdr.content.input' ? 'Message input' : key === 'herdr.content.output' ? 'Message output' : key === 'herdr.content.tool_input' ? 'Tool input' : key === 'herdr.content.tool_output' ? 'Tool output' : key;

export function SpanDetailView(props: { node: () => TreeNode | undefined }) {
  const node = () => props.node();
  return <box style={{ width: '100%', height: '100%', flexDirection: 'column' }}>
    <SearchHeader><HighlightedText text={node()?.span.name ?? 'Span'} attributes={TextAttributes.BOLD} /></SearchHeader>
    <box height={1} flexShrink={0} paddingLeft={1}>
      <text fg={uiColors.textMuted}>{node() ? `${node()!.span.serviceName} · ${duration(node()!)} · ${node()!.span.status.code === 2 ? 'ERROR' : 'OK'}` : 'No span selected'}</text>
    </box>
    <SearchHeader><HighlightedText text="Attributes" highlight="secondary" /></SearchHeader>
    <ScrollableContent>
      {(node()?.span.attributes ?? []).map(attribute => <box height={1} flexShrink={0} flexDirection="row" paddingLeft={1} paddingRight={1}>
        <box style={{ width: 24, flexShrink: 0 }} overflow="hidden"><text fg={uiColors.primary}>{title(attribute.key)}</text></box>
        <box style={{ flexGrow: 1, minWidth: 0 }} overflow="hidden"><text fg={uiColors.textSecondary}>{String(attribute.value)}</text></box>
      </box>)}
    </ScrollableContent>
  </box>;
}
