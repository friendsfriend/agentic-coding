/** @jsxImportSource @opentui/solid */
import type { ScrollBoxRenderable } from '@opentui/core';
import type { JSX } from 'solid-js';
import { SCROLLBAR_OPTIONS } from '../colors';

export type ScrollAxis = 'x' | 'y';

export interface ScrollableContentProps {
  children?: JSX.Element;
  /** Rendered scroll axes. Defaults to vertical-only. */
  axes?: ScrollAxis[];
  /** Axes that parent keyboard handlers are allowed to scroll. */
  keyboardAxes?: ScrollAxis[];
  onScrollBoxReady?: (scrollBox: ScrollBoxRenderable) => void;
  scrollbarOptions?: typeof SCROLLBAR_OPTIONS;
  viewportCulling?: boolean;
  stickyScroll?: boolean;
  stickyStart?: 'top' | 'bottom';
  style?: Record<string, unknown>;
}

export function allowsKeyboardAxis(props: Pick<ScrollableContentProps, 'keyboardAxes'>, axis: ScrollAxis) {
  return (props.keyboardAxes ?? []).includes(axis);
}

export function ScrollableContent(props: ScrollableContentProps) {
  const axes = () => props.axes ?? ['y'];

  return (
    <scrollbox
      ref={(r: ScrollBoxRenderable) => props.onScrollBoxReady?.(r)}
      scrollbarOptions={props.scrollbarOptions ?? SCROLLBAR_OPTIONS}
      scrollX={axes().includes('x')}
      scrollY={axes().includes('y')}
      viewportCulling={props.viewportCulling}
      stickyScroll={props.stickyScroll}
      stickyStart={props.stickyStart}
      style={{ flexGrow: 1, flexShrink: 1, minHeight: 0, ...props.style }}
    >
      {props.children}
    </scrollbox>
  );
}
