/** @jsxImportSource @opentui/solid */
import { TextAttributes } from '@opentui/core';
import { For, createMemo } from 'solid-js';
import type { LogStore } from '../model/logStore';
import { HighlightedText } from '../components/Highlight';
import { ScrollableContent } from '../components/ScrollableContent';
import { SearchHeader } from '../components/SearchHeader';
import { uiColors } from '../ui/colors';

export function LogDetailView(props: {
  store: LogStore;
  index: number;
  onBack: () => void;
  onTraceLink?: (traceId: string) => void;
}) {
  const log = createMemo(() => props.store.getLogs()[props.index]);

  return <box style={{ width: '100%', height: '100%', flexDirection: 'column' }}>
    <SearchHeader><HighlightedText text={`${log()?.severity ?? 'UNKNOWN'}: ${log()?.body.slice(0, 60) ?? ''}`} attributes={TextAttributes.BOLD} /></SearchHeader>
    <box height={1} flexShrink={0} paddingLeft={1}>
      <text fg={uiColors.textMuted}>{log()?.serviceName} · {log()?.timeUnixNano ? new Date(Number(BigInt(log()!.timeUnixNano) / 1_000_000n)).toLocaleString() : '—'}</text>
    </box>

    {/* Body */}
    <box height={3} flexShrink={0} paddingLeft={1} paddingRight={1} flexDirection="column">
      <text fg={uiColors.textMuted} attributes={TextAttributes.BOLD}>Body</text>
      <text fg={uiColors.textPrimary}>{log()?.body ?? ''}</text>
    </box>

    {/* Trace/span link */}
    {log()?.traceId && <box height={1} flexDirection="row" paddingLeft={1} onMouseUp={() => {}}>
      <text fg={uiColors.primary} attributes={TextAttributes.BOLD}>Trace: </text>
      <text fg={uiColors.accent}>{log()!.traceId}</text>
      {log()?.spanId && <><text fg={uiColors.primary}>  Span: </text><text fg={uiColors.accent}>{log()!.spanId}</text></>}
    </box>}

    {/* Attributes */}
    <SearchHeader><HighlightedText text="Attributes" highlight="secondary" /></SearchHeader>
    <ScrollableContent>
      <For each={log()?.attributes ?? []}>{(attr) =>
        <box height={1} flexShrink={0} flexDirection="row" paddingLeft={1} paddingRight={1}>
          <box style={{ width: 24, flexShrink: 0 }} overflow="hidden"><text fg={uiColors.primary}>{attr.key}</text></box>
          <box style={{ flexGrow: 1, minWidth: 0 }} overflow="hidden"><text fg={uiColors.textSecondary}>{attr.value}</text></box>
        </box>
      }</For>
    </ScrollableContent>
  </box>;
}
