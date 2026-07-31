/** @jsxImportSource @opentui/solid */
import { TextAttributes } from '@opentui/core';
import { uiColors } from '../colors';

export interface CenteredStateProps {
  message: string;
  color?: string;
  bold?: boolean;
  italic?: boolean;
  height?: number | 'auto' | `${number}%`;
  style?: Record<string, unknown>;
}

export function CenteredState(props: CenteredStateProps) {
  return (
    <box
      style={{
        width: '100%',
        height: props.height ?? '100%',
        justifyContent: 'center',
        alignItems: 'center',
        ...props.style,
      }}
    >
      <text
        fg={props.color ?? uiColors.textMuted}
        attributes={
          props.bold
            ? TextAttributes.BOLD
            : props.italic
              ? TextAttributes.ITALIC
              : undefined
        }
      >
        {props.message}
      </text>
    </box>
  );
}
