/** @jsxImportSource @opentui/solid */
import { TextAttributes } from '@opentui/core';
import { highlightColor, type Highlight } from './Highlight';
import { uiColors } from '../ui/colors';

export function Badge(props: { text: string | number; highlight?: Highlight; color?: string; textColor?: string }) {
  const color = props.color ?? highlightColor(props.highlight ?? 'accent');
  return <box backgroundColor={color} style={{ height: 1, width: String(props.text).length + 2, flexShrink: 0 }}>
    <text fg={props.textColor ?? uiColors.bgBase} attributes={TextAttributes.BOLD}> {String(props.text)} </text>
  </box>;
}
