/** @jsxImportSource @opentui/solid */
import { uiColors } from '../ui/colors';

export type Highlight = 'primary' | 'secondary' | 'positive' | 'negative' | 'warning' | 'accent';

export function highlightColor(value: Highlight = 'primary') {
  return value === 'positive' ? uiColors.success
    : value === 'negative' ? uiColors.error
    : value === 'warning' ? uiColors.warning
    : value === 'secondary' ? uiColors.textMuted
    : value === 'accent' ? uiColors.accent
    : uiColors.primary;
}

export function HighlightedText(props: { text: string | number; highlight?: Highlight; attributes?: number }) {
  return <text fg={highlightColor(props.highlight)} attributes={props.attributes ?? 0}>{String(props.text)}</text>;
}
