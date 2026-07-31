/** @jsxImportSource @opentui/solid */
// Merged terminal UI shell: one TabBar with Workflow (dashboard/home) and
// Observability (traces/logs/metrics/topology) tabs. The observability stores
// and receiver live at shell level, so spans keep flowing while the workflow
// tab is active. Tab switch: Ctrl+1 / Ctrl+2.
import { createSignal, onCleanup, onMount, Show } from 'solid-js';
import type { KeyEvent, Renderable } from '@opentui/core';
import type { Keymap } from '@opentui/keymap';
import { KeymapProvider } from '@opentui/keymap/solid';
import { useRenderer } from '@opentui/solid';
import { TabBar } from './otel/components/TabBar';
import { App as DashApp } from './dash/App';
import { Home as DashHome } from './dash/Home';
import { App as OtelApp } from './otel/app/App';
import type { TraceDb } from './otel/model/db';
import type { TraceStore } from './otel/model/traceStore';
import type { MetricStore } from './otel/model/metricStore';
import type { LogStore } from './otel/model/logStore';
import type { TopologyStore } from './otel/model/topologyStore';
import { uiColors } from './otel/ui/colors';

export type ShellMode = 'home' | 'dash';

export function Shell(props: {
  mode: ShellMode;
  repo?: string;
  change?: string;
  profile?: string;
  keymap: Keymap<Renderable, KeyEvent>;
  repos: string[];
  db: TraceDb;
  traceStore: TraceStore;
  metricStore: MetricStore;
  logStore: LogStore;
  topologyStore: TopologyStore;
  tracesOnly?: boolean;
}) {
  const renderer = useRenderer();
  const [tab, setTab] = createSignal<'workflow' | 'observability'>('workflow');

  onMount(() => {
    const handleKey = (event: KeyEvent) => {
      if (!event.ctrl) return;
      const key = event.name.toLowerCase();
      if (key === '1') setTab('workflow');
      else if (key === '2') setTab('observability');
    };
    renderer.keyInput.on('keypress', handleKey);
    onCleanup(() => renderer.keyInput.off('keypress', handleKey));
  });

  return (
    <KeymapProvider keymap={props.keymap}>
      <box style={{ width: '100%', height: '100%', flexDirection: 'column' }}>
        <TabBar
          tabs={[
            { id: 'workflow', label: props.mode === 'home' ? 'Workflows' : 'Workflow' },
            { id: 'observability', label: 'Observability' },
          ]}
          activeId={tab()}
          onSelect={id => setTab(id as 'workflow' | 'observability')}
        />
        <box style={{ flexGrow: 1, flexShrink: 1, minHeight: 0, flexDirection: 'column' }}>
          <Show when={tab() === 'workflow'} fallback={
            <OtelApp
              repos={props.repos}
              db={props.db}
              traceStore={props.traceStore}
              metricStore={props.metricStore}
              logStore={props.logStore}
              topologyStore={props.topologyStore}
              tracesOnly={props.tracesOnly}
            />
          }>
            {props.mode === 'home' ? (
              <DashHome keymap={props.keymap} />
            ) : (
              <DashApp repo={props.repo!} change={props.change!} profile={props.profile as 'test' | undefined} keymap={props.keymap} />
            )}
          </Show>
        </box>
        <text fg={uiColors.textMuted} style={{ height: 1, paddingLeft: 1 }}>Ctrl+1 Workflow · Ctrl+2 Observability · q quits (twice in observability)</text>
      </box>
    </KeymapProvider>
  );
}
