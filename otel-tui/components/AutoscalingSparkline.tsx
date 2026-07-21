/** @jsxImportSource @opentui/solid */
import { RGBA, type BoxRenderable, type OptimizedBuffer } from '@opentui/core';
import { createSignal } from 'solid-js';
import { uiColors } from '../ui/colors';

const dots = [[0x01, 0x08], [0x02, 0x10], [0x04, 0x20], [0x40, 0x80]];
const clamp = (n: number, min: number, max: number) => Math.max(min, Math.min(max, n));

function rows(values: number[], width: number, height: number): string[] {
  const display = values.length > width ? values.slice(-width) : values;
  const points = [...Array(Math.max(0, width - display.length)).fill(NaN), ...display];
  const real = points.filter(Number.isFinite);
  if (!real.length) return Array(height).fill(' '.repeat(width));
  let min = Math.min(...real), max = Math.max(...real);
  const pad = max === min ? .5 : (max - min) * .08;
  min -= pad; max += pad;
  const masks = Array.from({ length: height }, () => Array(width).fill(0));
  for (let x = 0; x < width * 2; x++) {
    const pos = x / 2, left = Math.floor(pos), right = Math.min(points.length - 1, left + 1);
    const a = points[left], b = points[right];
    if (!Number.isFinite(a)) continue;
    const value = !Number.isFinite(b) ? a : a + (b - a) * (pos - left);
    const y = height * 4 - 1 - Math.round(clamp((value - min) / (max - min || 1), 0, 1) * (height * 4 - 1));
    masks[Math.floor(y / 4)]![Math.floor(x / 2)]! |= dots[y % 4]![x % 2]!;
  }
  return masks.map(row => row.map(mask => mask ? String.fromCharCode(0x2800 + mask) : ' ').join(''));
}

export function AutoscalingSparkline(props: { values: number[]; color?: string; backgroundColor?: string }) {
  let box: BoxRenderable | undefined;
  const [size, setSize] = createSignal({ width: 0, height: 0 });
  const updateSize = () => {
    if (!box) return;
    const next = { width: Math.max(1, box.width ?? 0), height: Math.max(1, box.height ?? 0) };
    if (next.width !== size().width || next.height !== size().height) setSize(next);
  };
  const renderAfter = function(this: BoxRenderable, buffer: OptimizedBuffer) {
    const width = Math.max(1, this.width ?? 0), height = Math.max(1, this.height ?? 0);
    const fg = RGBA.fromHex(props.color ?? uiColors.primary), bg = RGBA.fromHex(props.backgroundColor ?? uiColors.bgMantle);
    buffer.fillRect(this.screenX, this.screenY, width, height, bg);
    rows(props.values, width, height).forEach((line, y) => buffer.drawText(line, this.screenX, this.screenY + y, fg, bg));
  };
  return <box ref={(r: BoxRenderable) => { box = r; queueMicrotask(updateSize); }} onSizeChange={updateSize} renderAfter={renderAfter} backgroundColor={props.backgroundColor ?? uiColors.bgMantle} style={{ flexGrow: 1, minWidth: 1, height: '100%', overflow: 'hidden' }} />;
}
