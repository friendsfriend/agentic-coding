/** @jsxImportSource @opentui/solid */
import { GenericModal } from './GenericModal';
import { uiColors } from './colors';
import { Badge } from './Badge';
import { SelectableList } from './Selectable';

export type VerificationEntry = { role: string; status: string; durationSeconds?: number; model?: string; cost?: number; providerErrors: number; fallback: boolean };
export function VerificationTimelineModal(props: { startedAt?: string; entries: VerificationEntry[]; selected: number }) {
  const started = () => props.startedAt ? new Date(props.startedAt).toLocaleString() : 'not started';
  return <GenericModal title="Verification timeline" widthPercent={0.72} heightPercent={0.78} help={[{ key: 'j/k', action: 'Select' }, { key: 'Enter', action: 'View result' }, { key: 'Esc', action: 'Close' }]}>
    <box flexDirection="column" width="100%" height={1}><text fg={uiColors.textMuted}>Started {started()}</text></box>
    <SelectableList items={props.entries} selectedIndex={props.selected} renderItem={(entry, selected) => {
      const color = () => entry.status === 'PASS' ? 'positive' as const : entry.status === 'FAIL' ? 'negative' as const : entry.status === 'RUN' ? 'highlight2' as const : 'secondary' as const;
      return <box width="100%" height={2} flexDirection="column" paddingLeft={1} paddingRight={1}>
        <box height={1} flexDirection="row"><box flexGrow={1} overflow="hidden"><text fg={uiColors.textPrimary}>{entry.role}</text></box><Badge text={entry.status} highlight={color()} /></box>
        <box height={1} flexDirection="row"><box flexGrow={1} overflow="hidden"><text fg={uiColors.textMuted}>{entry.model ?? 'default'}</text></box><text fg={uiColors.textMuted}>{entry.durationSeconds !== undefined ? `${entry.durationSeconds}s` : ''}{entry.cost ? ` · $${entry.cost.toFixed(2)}` : ''}</text></box>
      </box>;
    }} />
  </GenericModal>;
}
