/** @jsxImportSource @opentui/solid */
import { Show } from 'solid-js';
import { GenericModal } from './GenericModal';
import { SelectableList } from './Selectable';
import { uiColors } from './colors';

export type TraceEvent = { at: string; event: string; role?: string; model?: string; cost?: number; status?: number; tier?: string; roles?: string[]; reports?: string[]; fallback?: string };
const label = (event: TraceEvent) => ({ pi_agent_start: 'Agent started', pi_agent_end: 'Agent completed', pi_agent_settled: 'Agent waiting', model_usage: 'Model usage', provider_response: 'Provider response', verification_started: 'Verification started', verification_failed: 'Verification failed', provider_launch_fallback: 'Model fallback' }[event.event] ?? event.event.replaceAll('_', ' '));
export function EventsModal(props: { events: TraceEvent[]; selected: number }) {
  return <GenericModal title={`Traces · ${props.events.length}`} widthPercent={0.72} heightPercent={0.78} help={[{ key: 'j/k', action: 'Scroll' }, { key: 'Esc', action: 'Close' }]}>
    <SelectableList items={props.events} selectedIndex={props.selected} backgroundColor={event => event.event === 'verification_failed' ? uiColors.bgSurface1 : undefined} renderItem={event => <box width="100%" flexDirection="column" paddingLeft={1} paddingRight={1}>
      <box flexDirection="row"><text fg={event.event.includes('failed') || (event.status ?? 200) >= 400 ? uiColors.error : uiColors.primary}>{label(event)}</text><text fg={uiColors.textMuted}>{event.role ? ` · ${event.role}` : ' · workflow'}</text><box flexGrow={1} /><text fg={uiColors.textMuted}>{event.at}</text></box>
      <Show when={event.event === 'model_usage'}><text fg={uiColors.textSecondary}>{event.role ?? 'agent'} · {event.model ?? 'default'} · ${event.cost?.toFixed(4) ?? '0.0000'}</text></Show>
      <Show when={event.event === 'provider_response'}><text fg={uiColors.textSecondary}>{event.role ?? 'agent'} · {event.model ?? 'default'} · HTTP {event.status ?? 'unknown'}</text></Show>
      <Show when={event.event === 'pi_agent_start'}><text fg={uiColors.textSecondary}>{event.role ?? 'agent'} · {event.model ?? 'default'}</text></Show>
      <Show when={event.event === 'verification_started'}><text fg={uiColors.textSecondary}>Tier {event.tier ?? 'default'} · {(event.roles ?? []).join(', ')}</text></Show>
      <Show when={event.event === 'verification_failed'}><text fg={uiColors.error}>{(event.reports ?? []).length} blocking report(s)</text></Show>
      <Show when={event.event === 'provider_launch_fallback'}><text fg={uiColors.warning}>{event.role ?? 'agent'} → {event.fallback ?? 'fallback model'}</text></Show>
    </box>} />
  </GenericModal>;
}
