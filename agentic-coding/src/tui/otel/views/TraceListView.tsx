/** @jsxImportSource @opentui/solid */
import { TextAttributes } from '@opentui/core';
import type { TraceSummary } from '../model/types';
import { Badge } from '../components/Badge';
import { HighlightedText } from '../components/Highlight';
import { SelectableList } from '../components/Selectable';
import { SearchHeader } from '../components/SearchHeader';
import { uiColors } from '../ui/colors';

const duration = (ms: number) => ms >= 1000 ? `${(ms / 1000).toFixed(1)}s` : `${ms}ms`;
const time = (ns: bigint) => new Date(Number(ns / 1_000_000n)).toLocaleTimeString();
const attribute = (span: TraceSummary['rootSpans'][number] | undefined, key: string) => String(span?.attributes.find(attribute => attribute.key === key)?.value ?? '—');

export function TraceListView(props: {
  summaries: () => TraceSummary[];
  selectedIndex: () => number;
  onSelect: (index: number) => void;
  searchMode: () => boolean;
  searchQuery: () => string;
  resultCount: () => number;
}) {
  return <box flexDirection="column" width="100%" height="100%">
    <SearchHeader searchMode={props.searchMode} searchQuery={props.searchQuery} resultCount={props.resultCount}><text fg={uiColors.textMuted} attributes={TextAttributes.BOLD}>Traces</text></SearchHeader>
    {props.summaries().length > 0 && <SelectableList items={props.summaries()} selectedIndex={props.selectedIndex} onSelect={props.onSelect} renderItem={(summary, selected) => {
      const root = summary.rootSpans[0];
      const workspace = attribute(root, 'herdr.change.id');
      const agent = summary.agents.join(', ') || attribute(root, 'herdr.role');
      return <box height={2} flexDirection="column" paddingLeft={1} paddingRight={1}> 
        <box height={1} flexDirection="row">
          <HighlightedText text={workspace} highlight={selected ? 'primary' : 'secondary'} attributes={TextAttributes.BOLD} />
          <text fg={uiColors.textMuted}>  {agent} · {root?.name ?? summary.traceId.slice(0, 16)}</text>
          <box style={{ flexGrow: 1 }} />
          <Badge text={summary.errorCount ? `${summary.errorCount} error` : 'ok'} highlight={summary.errorCount ? 'negative' : 'positive'} />
        </box>
        <box height={1} flexDirection="row">
          <HighlightedText text={duration(summary.durationMs)} highlight="warning" />
          <text fg={uiColors.textMuted}>  {summary.spanCount} spans · {time(summary.startTime)} · {summary.traceId.slice(0, 12)}</text>
        </box>
      </box>;
    }} />}
    {props.summaries().length === 0 && <box paddingLeft={1}><text fg={uiColors.textMuted}>No traces loaded — waiting for data</text></box>}
  </box>;
}
