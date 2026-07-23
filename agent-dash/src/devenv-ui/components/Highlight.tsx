/** @jsxImportSource @opentui/solid */
import { TextAttributes } from '@opentui/core';
import { uiColors } from '../colors';

export type Highlight =
  | 'primary'
  | 'secondary'
  | 'positive'
  | 'negative'
  | 'warning'
  /** Backward-compatible alias for highlight1. */
  | 'highlight'
  | 'highlight1'
  | 'highlight2'
  | 'highlight3';

export function highlightForIndex(index: number): Highlight {
  const highlights: Highlight[] = ['highlight1', 'highlight2', 'highlight3'];
  return highlights[Math.max(0, index) % highlights.length];
}

export function highlightColor(highlight?: Highlight): string {
  switch (highlight) {
    case 'primary': return uiColors.textPrimary;
    case 'secondary': return uiColors.textMuted;
    case 'positive': return uiColors.success;
    case 'negative': return uiColors.error;
    case 'warning': return uiColors.warning;
    case 'highlight':
    case 'highlight1': return uiColors.highlight;
    case 'highlight2': return uiColors.primary;
    case 'highlight3': return uiColors.info;
    default: return uiColors.textPrimary;
  }
}

export interface HighlightedTextProps {
  text: string | number;
  highlight?: Highlight;
  attributes?: number;
}

export function HighlightedText(props: HighlightedTextProps) {
  return <text fg={highlightColor(props.highlight)} attributes={props.attributes}>{String(props.text)}</text>;
}
