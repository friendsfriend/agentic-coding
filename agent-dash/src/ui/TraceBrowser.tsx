/** @jsxImportSource @opentui/solid */
import { Show, createMemo } from 'solid-js';
import { duration, traces, tree, type TraceSpan } from '../traces';
import { uiColors } from './colors';

export function TraceBrowser(props: { spans: TraceSpan[]; filter?: string; change?: string }) {
  const visible = createMemo(() => traces(props.spans.filter(span => !props.change || span.attributes['herdr.change.id'] === props.change), props.filter));
  return <box flexDirection="column" width="100%" height="100%">
    <Show when={visible().length} fallback={<text fg={uiColors.textMuted}>No traces yet</text>}>
      <text fg={uiColors.textMuted}>{visible().length} traces · {props.spans.length} spans</text>
      {visible().slice(0, 20).map(trace => <box flexDirection="column" marginTop={1}>
        <text fg={uiColors.primary}>{trace.id}</text>
        {tree(trace.spans).map(row => <box flexDirection="column"><text fg={row.span.status === 'ERROR' ? uiColors.error : uiColors.textSecondary}>{'  '.repeat(row.depth)}{row.span.name} · {duration(row.span)}{row.span.status ? ` · ${row.span.status}` : ''}</text><text fg={uiColors.textMuted}>{'  '.repeat(row.depth + 1)}{String(row.span.attributes['service.name'] ?? 'unknown')} · {Object.entries(row.span.attributes).map(([key, value]) => `${key}=${value}`).join(' · ').slice(0, 240)}</text></box>)}
      </box>)}
    </Show>
  </box>;
}
