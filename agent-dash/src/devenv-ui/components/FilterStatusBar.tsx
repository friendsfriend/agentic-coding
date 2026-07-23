/** @jsxImportSource @opentui/solid */
import { HighlightedText } from './Highlight';
import { uiColors } from '../colors';

export interface FilterStatusBarProps {
  filterSummary?: string;
  sortSummary?: string;
}

export function FilterStatusBar(props: FilterStatusBarProps) {
  const hasStatus = () => !!props.filterSummary || !!props.sortSummary;
  if (!hasStatus()) return null;

  return <box backgroundColor={uiColors.bgSurface2} style={{ width: '100%', height: 1, flexDirection: 'row', paddingLeft: 1, paddingRight: 1 }}>{[
    props.filterSummary ? <HighlightedText text={` ${props.filterSummary}`} highlight="highlight2" /> : null,
    <box style={{ width: 'auto', marginLeft: 'auto' }}>{props.sortSummary ? <HighlightedText text={`󰒺 ${props.sortSummary}`} highlight="highlight3" /> : null}</box>,
  ].filter(Boolean)}</box>;
}
