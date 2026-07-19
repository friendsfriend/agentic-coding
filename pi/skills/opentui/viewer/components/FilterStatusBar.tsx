/** @jsxImportSource @opentui/solid */
import { uiColors } from '../ui/colors';

export function FilterStatusBar(props: { filterSummary?: string; sortSummary?: string }) {
  if (!props.filterSummary && !props.sortSummary) return null;
  return <box backgroundColor={uiColors.bgSurface1} style={{ width: '100%', height: 1, flexDirection: 'row', paddingLeft: 1, paddingRight: 1 }}>
    {props.filterSummary ? <text fg={uiColors.accent}>Filter: {props.filterSummary}</text> : null}
    <box style={{ flexGrow: 1 }} />
    {props.sortSummary ? <text fg={uiColors.primary}>Sort: {props.sortSummary}</text> : null}
  </box>;
}
