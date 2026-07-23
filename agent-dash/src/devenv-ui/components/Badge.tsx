/** @jsxImportSource @opentui/solid */
import { BoxRenderable, RGBA, TextAttributes, parseColor, type OptimizedBuffer } from '@opentui/core';
import { useTimeline } from '@opentui/solid';
import { createEffect, createMemo, createSignal, on, onCleanup, onMount } from 'solid-js';
import { uiColors } from '../colors';
import { highlightColor, type Highlight } from './Highlight';
import { auroraColor, createAuroraPalette, createTonePalette, type AnimationHighlights } from './animationColors';

export interface BadgeProps {
  text: string | number;
  highlight?: Highlight;
  /** Last-resort color escape hatch. Prefer highlight. */
  color?: string;
  textColor?: string;
  /** Toggle reactively to wipe between plain text and badge presentation. */
  appearance?: 'text' | 'badge';
  /** Opt-in Aurora shell colors. Static semantic badges should keep highlight instead. */
  animatedHighlights?: AnimationHighlights;
  /** Opt-in semantic tone animation with a neutral foreground peak. */
  animatedTone?: Highlight;
  attributes?: number;
  /** Stable identity used to continue wipes when list reconciliation remounts this badge. */
  transitionKey?: string;
  transitionDuration?: number;
}

interface BadgeSnapshot {
  text: string;
  color: RGBA;
  textColor: RGBA;
  appearance: 'text' | 'badge';
  attributes: number;
}

const transitionSnapshots = new Map<string, BadgeSnapshot>();
const rememberSnapshot = (key: string, snapshot: BadgeSnapshot) => {
  transitionSnapshots.delete(key);
  transitionSnapshots.set(key, snapshot);
  if (transitionSnapshots.size > 1000) transitionSnapshots.delete(transitionSnapshots.keys().next().value!);
};
const sameSnapshot = (left: BadgeSnapshot, right: BadgeSnapshot) => left.text === right.text
  && left.color.equals(right.color)
  && left.textColor.equals(right.textColor)
  && left.appearance === right.appearance
  && left.attributes === right.attributes;

const clamp = (value: number) => Math.max(0, Math.min(1, value));
const mix = (from: RGBA, to: RGBA, amount: number) => RGBA.fromValues(
  from.r + (to.r - from.r) * amount,
  from.g + (to.g - from.g) * amount,
  from.b + (to.b - from.b) * amount,
  1,
);

export function Badge(props: BadgeProps) {
  let root: BoxRenderable | undefined;
  const snapshot = (): BadgeSnapshot => ({
    text: String(props.text),
    color: parseColor(props.color ?? highlightColor(props.highlight ?? 'highlight')),
    textColor: parseColor(props.textColor ?? uiColors.bgBase),
    appearance: props.appearance ?? 'badge',
    attributes: props.attributes ?? TextAttributes.BOLD,
  });
  const initial = snapshot();
  const cached = props.transitionKey ? transitionSnapshots.get(props.transitionKey) : undefined;
  const [current, setCurrent] = createSignal(initial);
  const [previous, setPrevious] = createSignal(cached ?? initial);
  const wipe = { progress: cached && !sameSnapshot(cached, initial) ? 0 : 1 };
  const wipeTimeline = useTimeline({ autoplay: false, duration: Number.MAX_SAFE_INTEGER });
  const startWipe = () => {
    wipeTimeline.pause();
    wipeTimeline.items.length = 0;
    wipe.progress = 0;
    wipeTimeline.once(wipe, {
      progress: 1,
      duration: props.transitionDuration ?? 450,
      ease: 'inOutSine',
      onComplete: () => {
        setPrevious(current());
        wipeTimeline.pause();
        root?.requestRender();
      },
    });
    wipeTimeline.play();
    root?.requestRender();
  };

  createEffect(on(
    () => `${String(props.text)}\0${props.color ?? highlightColor(props.highlight ?? 'highlight')}\0${props.textColor ?? uiColors.bgBase}\0${props.appearance ?? 'badge'}\0${props.attributes ?? TextAttributes.BOLD}`,
    () => {
      const next = snapshot();
      setPrevious(current());
      setCurrent(next);
      if (props.transitionKey) rememberSnapshot(props.transitionKey, next);
      startWipe();
    },
    { defer: true },
  ));

  onMount(() => {
    if (props.transitionKey) rememberSnapshot(props.transitionKey, current());
    if (cached && !sameSnapshot(cached, current())) startWipe();
  });
  onCleanup(() => {
    if (props.transitionKey) rememberSnapshot(props.transitionKey, current());
  });

  const aurora = { progress: 0 };
  const auroraTimeline = useTimeline({ autoplay: false, duration: 1600, loop: true });
  auroraTimeline.add(aurora, { progress: 1, duration: 1600, ease: 'linear' });
  const palette = createMemo(() => props.animatedTone
    ? createTonePalette(props.animatedTone)
    : props.animatedHighlights
      ? createAuroraPalette(props.animatedHighlights)
      : undefined);
  createEffect(() => {
    if (props.animatedTone || props.animatedHighlights) {
      auroraTimeline.play();
    } else {
      auroraTimeline.pause();
      aurora.progress = 0;
      root?.requestRender();
    }
  });
  const snapshotWidth = (badge: BadgeSnapshot) => badge.text.length + (badge.appearance === 'badge' ? 4 : 0);
  const width = () => Math.max(snapshotWidth(previous()), snapshotWidth(current()));

  const renderAfter = function renderAfter(this: BoxRenderable, buffer: OptimizedBuffer) {
    const oldBadge = previous();
    const nextBadge = current();
    const badgeWidth = width();

    for (let x = 0; x < badgeWidth; x++) {
      const local = clamp(wipe.progress * (badgeWidth + 2) - x);
      const badge = local >= 0.5 ? nextBadge : oldBadge;
      const colors = palette();
      const shellColor = colors
        ? auroraColor(colors, x / badgeWidth, aurora.progress)
        : badge.color;

      if (badge.appearance === 'text') {
        buffer.drawText(badge.text[x] ?? ' ', this.screenX + x, this.screenY, shellColor, undefined, badge.attributes);
        continue;
      }

      const matrixWidth = badge.text.length + 4;
      if (x >= matrixWidth) continue;
      if (x === 0 || x === matrixWidth - 1) {
        buffer.drawText(x === 0 ? '' : '', this.screenX + x, this.screenY, shellColor);
        continue;
      }

      const textIndex = x - 2;
      const character = textIndex >= 0 && textIndex < badge.text.length ? badge.text[textIndex]! : ' ';
      const foreground = mix(shellColor, badge.textColor, Math.abs(local - 0.5) * 2);
      buffer.setCell(this.screenX + x, this.screenY, character, foreground, shellColor, badge.attributes);
    }
  };

  return <box ref={(element: BoxRenderable) => (root = element)} renderAfter={renderAfter} style={{ width: width(), height: 1, flexShrink: 0 }} />;
}
