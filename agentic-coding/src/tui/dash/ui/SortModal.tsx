/** @jsxImportSource @opentui/solid */
import { TextAttributes } from '@opentui/core';
import { For } from 'solid-js';
import { GenericModal } from './GenericModal';
import { uiColors } from './colors';

export function SortModal(props: {
  selectedIndex: number;
  options: string[];
  direction: 'asc' | 'desc';
}) {
  return (
    <GenericModal
      title="Order / Sort"
      widthPercent={0.6}
      heightPercent={0.55}
      help={[
        { key: 'j/k', action: 'Select' },
        { key: 'Space', action: 'Mode' },
        { key: 'Enter', action: 'Apply' },
        { key: 'Esc', action: 'Close' },
      ]}
    >
      <box style={{ width: '100%', flexDirection: 'column' }}>
        <box
          style={{ height: 1, flexDirection: 'row', paddingLeft: 1, paddingRight: 1 }}
        >
          <box style={{ width: 5 }}>
            <text fg={uiColors.textPrimary} attributes={TextAttributes.BOLD}>
              Prio
            </text>
          </box>
          <box style={{ width: '60%' }}>
            <text fg={uiColors.textPrimary} attributes={TextAttributes.BOLD}>
              Parameter
            </text>
          </box>
          <text fg={uiColors.textPrimary} attributes={TextAttributes.BOLD}>
            Mode
          </text>
        </box>
        <For each={props.options}>
          {(value, index) => (
            <box
              backgroundColor={
                index() === props.selectedIndex ? uiColors.bgSurface1 : undefined
              }
              style={{ height: 1, flexDirection: 'row', paddingLeft: 1, paddingRight: 1 }}
            >
              <box style={{ width: 5 }}>
                <text fg={uiColors.textMuted}>{index() + 1}</text>
              </box>
              <box style={{ width: '60%' }}>
                <text
                  fg={
                    index() === props.selectedIndex
                      ? uiColors.textPrimary
                      : uiColors.textSecondary
                  }
                >
                  {value}
                </text>
              </box>
              <text fg={uiColors.primary}>{props.direction === 'asc' ? '↑' : '↓'}</text>
            </box>
          )}
        </For>
      </box>
    </GenericModal>
  );
}
