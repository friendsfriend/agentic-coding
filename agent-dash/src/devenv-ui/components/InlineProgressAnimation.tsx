/** @jsxImportSource @opentui/solid */
import { BoxRenderable, RGBA, TextAttributes, type OptimizedBuffer } from '@opentui/core';
import { useTimeline } from '@opentui/solid';
import { uiColors } from '../colors';
import type { Highlight } from './Highlight';
import {
  auroraColor,
  createAuroraPalette,
  createTonePalette,
  DEFAULT_ANIMATION_HIGHLIGHTS,
  type AnimationHighlights,
} from './animationColors';

export type InlineProgressHighlights = AnimationHighlights;
export const DEFAULT_INLINE_PROGRESS_HIGHLIGHTS = DEFAULT_ANIMATION_HIGHLIGHTS;

export interface InlineProgressAnimationProps {
  text: string;
  highlights?: InlineProgressHighlights;
  tone?: Highlight;
  backgroundColor?: string;
  duration?: number;
}

export function InlineProgressAnimation(props: InlineProgressAnimationProps) {
  const text = Array.from(props.text);
  const width = Math.max(1, text.length);
  const palette = props.tone
    ? createTonePalette(props.tone)
    : createAuroraPalette(props.highlights ?? DEFAULT_INLINE_PROGRESS_HIGHLIGHTS);
  const state = { progress: 0 };

  const timeline = useTimeline({ duration: props.duration ?? 1600, loop: true });
  timeline.add(state, { progress: 1, duration: props.duration ?? 1600, ease: 'linear' });

  const renderAfter = function renderAfter(this: BoxRenderable, buffer: OptimizedBuffer) {
    const background = RGBA.fromHex(props.backgroundColor ?? uiColors.bgMantle);
    text.forEach((character, index) => {
      buffer.setCell(
        this.screenX + index,
        this.screenY,
        character,
        auroraColor(palette, index / Math.max(1, text.length), state.progress),
        background,
        TextAttributes.BOLD,
      );
    });
  };

  return <box backgroundColor={props.backgroundColor ?? uiColors.bgMantle} renderAfter={renderAfter} style={{ width, height: 1, flexShrink: 0 }} />;
}
