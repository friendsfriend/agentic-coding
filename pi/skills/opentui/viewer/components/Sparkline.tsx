/** @jsxImportSource @opentui/solid */
import { uiColors } from '../ui/colors';

const blocks = ['▁', '▂', '▃', '▄', '▅', '▆', '▇', '█'];

export function Sparkline(props: { values: number[]; width: number; color?: string }) {
  if (!props.values.length) return <text fg={uiColors.textMuted}>{'·'.repeat(props.width)}</text>;

  // Downsample to fit width
  const step = Math.max(1, Math.floor(props.values.length / props.width));
  const sampled: number[] = [];
  for (let i = 0; i < props.values.length && sampled.length < props.width; i += step) {
    sampled.push(props.values[i]!);
  }
  // Pad if too few
  while (sampled.length < props.width) sampled.push(0);

  const min = Math.min(...sampled);
  const max = Math.max(...sampled);
  const range = max - min || 1;

  const chars = sampled.map(v => {
    const normalized = (v - min) / range;
    const index = Math.min(blocks.length - 1, Math.floor(normalized * blocks.length));
    return blocks[index] ?? '▁';
  });

  return <text fg={props.color ?? uiColors.primary}>{chars.join('')}</text>;
}
