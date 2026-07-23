/** @jsxImportSource @opentui/solid */
import { For } from 'solid-js';
import { uiColors } from '../colors';

export function splitMatches(text: string, query: string): Array<{ text: string; isMatch: boolean }> {
  if (!query) return [{ text, isMatch: false }];
  const lower = text.toLowerCase();
  const q = query.toLowerCase();
  const segments: Array<{ text: string; isMatch: boolean }> = [];
  let pos = 0;
  while (pos < text.length) {
    const idx = lower.indexOf(q, pos);
    if (idx === -1) {
      segments.push({ text: text.slice(pos), isMatch: false });
      break;
    }
    if (idx > pos) segments.push({ text: text.slice(pos, idx), isMatch: false });
    segments.push({ text: text.slice(idx, idx + q.length), isMatch: true });
    pos = idx + q.length;
  }
  return segments;
}

export interface MatchedTextProps {
  text: string;
  query?: string;
  fg: string;
  attributes?: number;
}

export function MatchedText(props: MatchedTextProps) {
  const query = () => props.query ?? '';
  return (
    <text fg={props.fg} attributes={props.attributes as number | undefined}>
      <For each={splitMatches(props.text, query())}>
        {(segment) => (
          <span style={segment.isMatch ? { fg: uiColors.bgBase, bg: uiColors.warning } : { fg: props.fg }}>
            {segment.text}
          </span>
        )}
      </For>
    </text>
  );
}
