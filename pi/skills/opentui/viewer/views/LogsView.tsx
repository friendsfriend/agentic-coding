/** @jsxImportSource @opentui/solid */
import { TextAttributes } from '@opentui/core';
import { createMemo } from 'solid-js';
import type { LogStore } from '../model/logStore';
import { HighlightedText } from '../components/Highlight';
import { SelectableList } from '../components/Selectable';
import { SearchHeader } from '../components/SearchHeader';
import { uiColors } from '../ui/colors';

const severityColor = (sev: string) => {
  if (sev === 'ERROR' || sev === 'FATAL') return uiColors.error;
  if (sev === 'WARN') return uiColors.warning;
  if (sev === 'INFO') return uiColors.success;
  return uiColors.textMuted;
};

export function LogsView(props: {
  store: LogStore;
  selectedIndex: () => number;
  onSelectIndex: (index: number) => void;
  onOpen: (index: number) => void;
}) {
  const logs = createMemo(() => props.store.getLogs());

  return <box flexDirection="column" width="100%" height="100%">
    <SearchHeader>
      <text fg={uiColors.textMuted} attributes={TextAttributes.BOLD}>Logs  ({props.store.filteredCount_})</text>
    </SearchHeader>
    {logs().length > 0 && <SelectableList items={logs()} selectedIndex={props.selectedIndex} renderItem={(log) =>
      <box height={1} flexDirection="row" paddingLeft={1} paddingRight={1}>
        <box width={6} flexShrink={0}><text fg={severityColor(log.severity)} attributes={TextAttributes.BOLD}>{log.severity.padEnd(5)}</text></box>
        <box width={20} flexShrink={0}><text fg={uiColors.textSecondary}>{new Date(Number(BigInt(log.timeUnixNano) / 1_000_000n)).toLocaleTimeString()}</text></box>
        <box width={14} flexShrink={0} overflow="hidden"><text fg={uiColors.textMuted}>{log.serviceName}</text></box>
        <box flexGrow={1} overflow="hidden"><text fg={uiColors.textPrimary}>{log.body.slice(0, 120)}</text></box>
      </box>
    } onSelect={(index) => { props.onSelectIndex(index); props.onOpen(index); }} />}
    {logs().length === 0 && <box paddingLeft={1}><text fg={uiColors.textMuted}>No logs loaded</text></box>}
  </box>;
}
