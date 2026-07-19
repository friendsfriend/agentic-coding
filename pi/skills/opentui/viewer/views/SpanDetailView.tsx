/** @jsxImportSource @opentui/solid */
import { TextAttributes } from '@opentui/core';
import type { TreeNode } from '../model/types';
import { ScrollableContent } from '../components/ScrollableContent';
import { HighlightedText } from '../components/Highlight';
import { uiColors } from '../ui/colors';

const duration = (node: TreeNode) => `${Math.max(0, Number((BigInt(node.span.endTimeUnixNano) - BigInt(node.span.startTimeUnixNano)) / 1_000_000n))}ms`;
const title = (key: string) => key === 'herdr.content.input' ? 'Message input' : key === 'herdr.content.output' ? 'Message output' : key === 'herdr.content.tool_input' ? 'Tool input' : key === 'herdr.content.tool_output' ? 'Tool output' : key;

export function SpanDetailView(props: { node: () => TreeNode | undefined }) {
  const node = () => props.node();
  return <box style={{ width: '100%', height: '100%', flexDirection: 'column' }}>
    <box height={2} flexShrink={0} flexDirection="column" paddingLeft={1}><HighlightedText text={node()?.span.name ?? 'Span'} attributes={TextAttributes.BOLD} /><text fg={uiColors.textMuted}>{node() ? `${node()!.span.serviceName} · ${duration(node()!)} · ${node()!.span.status.code === 2 ? 'ERROR' : 'OK'}` : 'No span selected'}</text></box>
    <ScrollableContent><box flexDirection="column" paddingLeft={1} paddingRight={1}>{node()?.span.attributes.map(attribute => <box flexDirection="column" paddingBottom={1}><text fg={uiColors.primary}>{title(attribute.key)}</text><text fg={uiColors.textSecondary}>{String(attribute.value)}</text></box>)}</box></ScrollableContent>
  </box>;
}
