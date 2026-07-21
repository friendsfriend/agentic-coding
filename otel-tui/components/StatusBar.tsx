/** @jsxImportSource @opentui/solid */
import { TextAttributes } from '@opentui/core';
import { For } from 'solid-js';
import { uiColors } from '../ui/colors';

export type Keybind = { key: string; action: string };
export function StatusBar(props: { prompt?: string; keybinds?: Keybind[] }) {
  const keys = () => [...(props.keybinds ?? [
    { key: 'j/k', action: 'nav' },
    { key: 'Tab', action: 'switch panel' },
    { key: 'Enter', action: 'select' },
    { key: '?', action: 'help' },
    { key: 'q', action: 'quit' },
  ]), { key: 'Shift+T', action: 'theme' }];
  return <box backgroundColor={uiColors.bgMantle} style={{ width: '100%', height: 1, flexDirection: 'row', paddingLeft: 1, paddingRight: 1 }}>
    <text fg={uiColors.textMuted}>{props.prompt ?? ''}</text>
    <For each={keys()}>{(item, index) => <text fg={uiColors.textMuted}><span style={{ fg: uiColors.primary, attributes: TextAttributes.BOLD }}>{item.key}</span> {item.action}{index() < keys().length - 1 ? '  •  ' : ''}</text>}</For>
  </box>;
}
