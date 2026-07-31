/** @jsxImportSource @opentui/solid */
import { TextAttributes } from '@opentui/core';
import { For } from 'solid-js';
import { GenericModal } from './GenericModal';
import { uiColors } from './colors';

export function FilterModal(props: {
  focusedPane: 'parameter' | 'value';
  selectedParameter: number;
  selectedValue: number;
  parameters: string[];
  values: string[];
}) {
  return (
    <GenericModal
      title="Filter"
      widthPercent={0.7}
      heightPercent={0.65}
      help={[
        { key: 'h/l', action: 'Focus' },
        { key: 'j/k', action: 'Move' },
        { key: 'Space', action: 'Toggle' },
        { key: 'Enter', action: 'Apply' },
        { key: 'Esc', action: 'Close' },
      ]}
    >
      <box style={{ width: '100%', height: '100%', flexDirection: 'row', gap: 2 }}>
        <box style={{ width: '35%', flexDirection: 'column' }}>
          <text
            fg={props.focusedPane === 'parameter' ? uiColors.primary : uiColors.textPrimary}
            attributes={TextAttributes.BOLD}
          >
            Parameter
          </text>
          <For each={props.parameters}>
            {(parameter, index) => (
              <box
                backgroundColor={index() === props.selectedParameter ? uiColors.bgSurface1 : undefined}
                style={{ height: 1, paddingLeft: 1 }}
              >
                <text
                  fg={index() === props.selectedParameter ? uiColors.primary : uiColors.textSecondary}
                >
                  {parameter}
                  {index() === props.selectedParameter ? ` (${index() + 1})` : ''}
                </text>
              </box>
            )}
          </For>
        </box>
        <box style={{ width: '65%', flexDirection: 'column' }}>
          <text
            fg={props.focusedPane === 'value' ? uiColors.primary : uiColors.textPrimary}
            attributes={TextAttributes.BOLD}
          >
            Values
          </text>
          <For each={props.values}>
            {(value, index) => (
              <box
                backgroundColor={index() === props.selectedValue ? uiColors.bgSurface1 : undefined}
                style={{ height: 1, paddingLeft: 1, flexDirection: 'row' }}
              >
                <text fg={index() === props.selectedValue ? uiColors.success : uiColors.textMuted}>
                  {index() === props.selectedValue ? '● ' : '○ '}
                </text>
                <text
                  fg={
                    index() === props.selectedValue ? uiColors.textPrimary : uiColors.textSecondary
                  }
                >
                  {value}
                </text>
              </box>
            )}
          </For>
        </box>
      </box>
    </GenericModal>
  );
}
