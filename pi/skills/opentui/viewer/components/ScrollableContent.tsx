/** @jsxImportSource @opentui/solid */
import type { ScrollBoxRenderable } from '@opentui/core';
import type { JSX } from 'solid-js';
import { uiColors } from '../ui/colors';

export function ScrollableContent(props: { children?: JSX.Element; onScrollBoxReady?: (scrollBox: ScrollBoxRenderable) => void; style?: Record<string, unknown> }) {
  return <scrollbox ref={(box: ScrollBoxRenderable) => props.onScrollBoxReady?.(box)} focusable={false} scrollY scrollbarOptions={{ showArrows: false, trackOptions: { backgroundColor: uiColors.bgSurface0, foregroundColor: uiColors.textMuted } }} style={{ flexGrow: 1, flexShrink: 1, minHeight: 0, ...props.style }}>
    {props.children}
  </scrollbox>;
}
