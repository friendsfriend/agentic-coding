/** @jsxImportSource @opentui/solid */

import { useRenderer, useTerminalDimensions } from '@opentui/solid';
import { TextAttributes, type KeyEvent } from '@opentui/core';
import type { Keymap } from '@opentui/keymap';
import { Show, createMemo, createSignal, onCleanup, onMount } from 'solid-js';
import { availableModels, discoverProjects, focusWorkflow, herdrAvailable, listWorkflows, notifyHerdrError, startWorkflow, type WorkflowOverview } from './data';
import { ErrorDialog } from './ui/ErrorDialog';
import { HelpModal, type HelpSection } from './ui/HelpModal';
import { NewWorkflowModal } from './ui/NewWorkflowModal';
import { Panel } from './ui/Panel';
import { StatusBar } from './ui/StatusBar';
import { uiColors } from './ui/colors';
import { ThemePickerModal } from './ui/ThemePickerModal';
import { applyTheme, saveThemeName, loadThemeName } from './theme-settings';
import { getActiveThemeName, themeNames } from './ui/theme';
import { invokeGlobalSelectionMouseUpHandler } from './selectionCopy';
import { NotificationOverlay } from './ui/Notification';
import { notify } from './notifications';
import { SelectableList } from './ui/Selectable';
import { FilterModal } from './ui/FilterModal';
import { SortModal } from './ui/SortModal';

export function Home(props: { keymap: Keymap<any, KeyEvent> }) {
  const renderer = useRenderer();
  const dimensions = useTerminalDimensions();
  const [models, setModels] = createSignal<string[]>([]);
  const [projects, setProjects] = createSignal<Array<{ name: string; path: string; openspec: boolean }>>([]);
  const [items, setItems] = createSignal<WorkflowOverview[]>([]);
  const [loading, setLoading] = createSignal(true);
  const [selected, setSelected] = createSignal(0);
  const [modal, setModal] = createSignal(false);
  const [modalHandler, setModalHandler] = createSignal<(event: KeyEvent) => boolean>();
  const [sshPassphraseRequired, setSshPassphraseRequired] = createSignal(false);
  const [message, setMessage] = createSignal('');
  const [error, setError] = createSignal<{ title: string; message: string }>();
  const [help, setHelp] = createSignal(false);
  const [helpOffset, setHelpOffset] = createSignal(0);
  let errorScroll: { scrollBy(dy: number): void } | undefined;
  const [themePicker, setThemePicker] = createSignal(false);
  const [themeIndex, setThemeIndex] = createSignal(Math.max(0, themeNames.indexOf(loadThemeName())));
  const [filterModal, setFilterModal] = createSignal(false);
  const [filterFocusedPane, setFilterFocusedPane] = createSignal<'parameter' | 'value'>('parameter');
  const [filterSelectedParameter, setFilterSelectedParameter] = createSignal(0);
  const [filterSelectedValue, setFilterSelectedValue] = createSignal(0);
  const [sortModal, setSortModal] = createSignal(false);
  const [sortSelectedIndex, setSortSelectedIndex] = createSignal(0);
  const [sortDirection, setSortDirection] = createSignal<'asc' | 'desc'>('asc');
  const filterParameters = ['Status', 'Phase', 'Agent'];
  const filterValues = ['Active', 'Archived'];
  const sortOptions = ['Name', 'Created', 'Updated', 'Status'];
  const visibleItems = createMemo(() => {
    const parameter = filterParameters[filterSelectedParameter()]!;
    const value = filterValues[filterSelectedValue()]!;
    const filtered = items().filter(item => parameter === 'Agent'
      ? value === 'Active' ? item.agents.some(agent => ['working', 'idle', 'done'].includes(agent.status)) : item.agents.every(agent => agent.status === 'closed')
      : value === 'Active' ? item.state.phase !== 'closed' : item.state.phase === 'closed');
    const option = sortOptions[sortSelectedIndex()]!;
    const direction = sortDirection() === 'asc' ? 1 : -1;
    const valueFor = (item: WorkflowOverview) => option === 'Name' ? item.state.changeId : option === 'Created' ? item.state.createdAt ?? '' : option === 'Updated' ? item.state.phaseStartedAt ?? '' : item.state.phase;
    return [...filtered].sort((left, right) => valueFor(left).localeCompare(valueFor(right)) * direction);
  });
  const helpSections: HelpSection[] = [{ title: 'Navigation', items: [{ key: 'j/k or ↑/↓', description: 'Select workspace' }] }, { title: 'Actions', items: [{ key: 'Enter', description: 'Switch active workspace' }, { key: 'n', description: 'New workflow' }, { key: 'f', description: 'Open filter modal' }, { key: 'o', description: 'Open sort modal' }, { key: 'r', description: 'Refresh' }, { key: 'q', description: 'Quit' }, { key: '?', description: 'Open help' }] }];
  const helpMaxOffset = () => Math.max(0, helpSections.reduce((count, section) => count + section.items.length + 1, 0) - Math.max(5, Math.floor(dimensions().height * .78) - 5));
  const closeError = () => { setError(undefined); props.keymap.setData('modal.active', modal() ? 'new-workflow' : 'none'); };
  const showError = (title: string, message: string) => { setError({ title, message }); props.keymap.setData('modal.active', 'error'); };
  const showHerdrUnavailable = (message = 'Herdr executable was not found. Install Herdr or add it to PATH.') => showError('Herdr unavailable', message);
  const refresh = () => { setItems(listWorkflows()); setSelected(index => Math.min(index, Math.max(0, items().length - 1))); };
  onMount(() => {
    const loadStartup = () => { setItems(listWorkflows()); setModels(availableModels()); setProjects(discoverProjects()); setLoading(false); };
    const startup = setTimeout(loadStartup, 0);
    const timer = setInterval(refresh, 5000);
    onCleanup(() => { clearTimeout(startup); clearInterval(timer); });
  });
  const handleKey = (key: KeyEvent) => {
    const name = key.name.toLowerCase();
    if (modal()) return;
    if (name === 't' && key.shift) { setThemePicker(true); props.keymap.setData('modal.active', 'theme'); }
    else if (name === '?') { setHelp(true); setHelpOffset(0); props.keymap.setData('modal.active', 'help'); }
    else if (name === 'q') renderer.destroy();
    else if (name === 'n') { setSshPassphraseRequired(false); setModal(true); props.keymap.setData('modal.active', 'new-workflow'); }
    else if (name === 'r') refresh();
    else if (name === 'f') { setFilterModal(true); setFilterFocusedPane('parameter'); setFilterSelectedParameter(0); setFilterSelectedValue(0); props.keymap.setData('modal.active', 'filter'); }
    else if (name === 'o') { setSortModal(true); setSortSelectedIndex(0); props.keymap.setData('modal.active', 'sort'); }
    else if (name === 'j' || name === 'down') setSelected(index => Math.min(index + 1, visibleItems().length - 1));
    else if (name === 'k' || name === 'up') setSelected(index => Math.max(index - 1, 0));
    else if (name === 'enter' || name === 'return') { const item = visibleItems()[selected()]; if (item?.workspaceOpen && item.state.phase !== 'closed') { try { focusWorkflow(item); } catch (error) { const message = error instanceof Error ? error.message : String(error); if (!notifyHerdrError(message)) showError(herdrAvailable() ? 'Workspace switch failed' : 'Herdr unavailable', message); } } }
  };
  onMount(() => {
    props.keymap.setData('app.view', 'home');
    props.keymap.setData('modal.active', 'none');
    const modalKeys = ['escape', 'return', 'enter', 'backspace', 'delete', 'up', 'down', 'j', 'k', 'd', 'u', '/', ...'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789-_=+[]{};:\\|,.<>`~!@#$%^&*() '.split('').map(key => key === ' ' ? 'space' : key)];
    const disposeModal = props.keymap.registerLayer({ name: 'new-workflow', priority: 1000, activeModal: 'new-workflow',
      commands: [{ name: 'new-workflow.handle', run: ({ event }) => modalHandler()?.(event) ?? true }],
      bindings: modalKeys.map(key => ({ key, cmd: 'new-workflow.handle' })),
    });
    const disposeTheme = props.keymap.registerLayer({ name: 'theme-home', priority: 1100, activeModal: 'theme', commands: [{ name: 'theme.handle', run: ({ event }) => { const key = event.name.toLowerCase(); if (key === 'escape') { setThemePicker(false); props.keymap.setData('modal.active', 'none'); } else if (key === 'j' || key === 'down') { const next = Math.min(themeNames.length - 1, themeIndex() + 1); setThemeIndex(next); applyTheme(themeNames[next]!); } else if (key === 'k' || key === 'up') { const next = Math.max(0, themeIndex() - 1); setThemeIndex(next); applyTheme(themeNames[next]!); } else if (key === 'enter' || key === 'return') { saveThemeName(themeNames[themeIndex()]!); setThemePicker(false); props.keymap.setData('modal.active', 'none'); } return true; } }], bindings: ['escape', 'enter', 'return', 'j', 'k', 'up', 'down'].map(key => ({ key, cmd: 'theme.handle' })) });
    const disposeHelp = props.keymap.registerLayer({ name: 'help', priority: 1100, activeModal: 'help', commands: [{ name: 'help.close', run: ({ event }) => { const key = event.name.toLowerCase(); if (key === 'escape') { setHelp(false); props.keymap.setData('modal.active', 'none'); } else if (key === 'j' || key === 'down') setHelpOffset(value => Math.min(helpMaxOffset(), value + 1)); else if (key === 'k' || key === 'up') setHelpOffset(value => Math.max(0, value - 1)); return true; } }], bindings: ['escape', 'j', 'k', 'up', 'down'].map(key => ({ key, cmd: 'help.close' })) });
    const disposeError = props.keymap.registerLayer({ name: 'error', priority: 1100, activeModal: 'error',
      commands: [{ name: 'error.handle', run: ({ event }) => {
        const key = event.name.toLowerCase();
        if (key === 'escape' || key === 'enter' || key === 'return') { closeError(); return true; }
        if ((key === 'j' || key === 'down') && errorScroll) { errorScroll.scrollBy(1); return true; }
        if ((key === 'k' || key === 'up') && errorScroll) { errorScroll.scrollBy(-1); return true; }
        return true;
      } }],
      bindings: ['escape', 'enter', 'return', 'j', 'k', 'up', 'down'].map(key => ({ key, cmd: 'error.handle' })),
    });
    const disposeFilter = props.keymap.registerLayer({ name: 'filter', priority: 1100, activeModal: 'filter',
      commands: [{ name: 'filter.handle', run: ({ event }) => {
        const key = event.name.toLowerCase();
        if (key === 'escape') { setFilterModal(false); props.keymap.setData('modal.active', 'none'); return true; }
        if (key === 'enter' || key === 'return') { setSelected(0); notify('Filter applied', 'info'); setFilterModal(false); props.keymap.setData('modal.active', 'none'); return true; }
        if (key === 'h' || key === 'left') { setFilterFocusedPane('parameter'); return true; }
        if (key === 'l' || key === 'right') { setFilterFocusedPane('value'); return true; }
        if (key === 'j' || key === 'down') {
          if (filterFocusedPane() === 'parameter') setFilterSelectedParameter(i => Math.min(filterParameters.length - 1, i + 1));
          else setFilterSelectedValue(i => Math.min(filterValues.length - 1, i + 1));
          return true;
        }
        if (key === 'k' || key === 'up') {
          if (filterFocusedPane() === 'parameter') setFilterSelectedParameter(i => Math.max(0, i - 1));
          else setFilterSelectedValue(i => Math.max(0, i - 1));
          return true;
        }
        if (key === 'space') { notify(`Toggled ${filterFocusedPane()} filter`, 'info'); return true; }
        return true;
      } }],
      bindings: ['escape', 'enter', 'return', 'h', 'l', 'j', 'k', 'up', 'down', 'left', 'right', 'space'].map(key => ({ key, cmd: 'filter.handle' })),
    });
    const disposeSort = props.keymap.registerLayer({ name: 'sort', priority: 1100, activeModal: 'sort',
      commands: [{ name: 'sort.handle', run: ({ event }) => {
        const key = event.name.toLowerCase();
        if (key === 'escape') { setSortModal(false); props.keymap.setData('modal.active', 'none'); return true; }
        if (key === 'enter' || key === 'return') { notify('Sort applied', 'info'); setSortModal(false); props.keymap.setData('modal.active', 'none'); return true; }
        if (key === 'space') { setSortDirection(direction => direction === 'asc' ? 'desc' : 'asc'); return true; }
        if (key === 'j' || key === 'down') setSortSelectedIndex(i => Math.min(sortOptions.length - 1, i + 1));
        if (key === 'k' || key === 'up') setSortSelectedIndex(i => Math.max(0, i - 1));
        return true;
      } }],
      bindings: ['escape', 'enter', 'return', 'space', 'j', 'k', 'up', 'down'].map(key => ({ key, cmd: 'sort.handle' })),
    });
    const disposeHome = props.keymap.registerLayer({ name: 'home', priority: 100, appView: 'home', activeModal: 'none',
      commands: [{ name: 'home.handle', run: ({ event }) => { handleKey(event); return true; } }],
      bindings: ['q', 'n', 'r', 'f', 'o', '?', 'shift+t', 'j', 'k', 'up', 'down', 'enter', 'return'].map(key => ({ key, cmd: 'home.handle' })), 
    });
    onCleanup(() => { disposeModal(); disposeTheme(); disposeHelp(); disposeError(); disposeFilter(); disposeSort(); disposeHome(); });
  });
  return (
    <box backgroundColor={uiColors.bgBase} style={{ width: '100%', height: '100%', flexDirection: 'column', padding: 1, gap: 1 }} onMouseUp={() => invokeGlobalSelectionMouseUpHandler()}>
      <box style={{ height: 2, flexDirection: 'column' }}>
        <box style={{ width: '100%', flexDirection: 'row' }}>
          <text fg={uiColors.primary} attributes={TextAttributes.BOLD}>AGT DASHBOARD</text>
          <box style={{ flexGrow: 1 }} />
          <text fg={uiColors.textMuted}>{items().length} workspaces</text>
        </box>
        <text fg={uiColors.textMuted}>All managed OpenSpec workspaces · auto-refresh 5s</text>
      </box>
      <Panel title="Workspaces" active style={{ flexGrow: 1, minHeight: 0 }}>
        <Show when={loading()} fallback={<Show when={items().length > 0} fallback={<text fg={uiColors.textMuted}>No workflows found in ~/development</text>}>
          <SelectableList items={visibleItems()} selectedIndex={selected()} renderItem={(item, active) => <box height={2} flexDirection="column" paddingLeft={1}>
            <text fg={active ? uiColors.textPrimary : uiColors.textSecondary}>{item.state.changeId}  <span style={{ fg: uiColors.primary }}>{item.state.phase}</span></text>
            <text fg={uiColors.textMuted}>{(item.state.workflowModules ?? ['plan','plan-approval','apply-verify','developer-approval','archive'])[0] === 'plan' ? 'standard' : 'direct-apply'} · {item.tasks[0]}/{item.tasks[1]} tasks · planner:{item.agents.find(agent => agent.role === 'planner')?.status ?? 'not started'} · {item.agents.filter(agent => agent.status === 'working' || agent.status === 'done' || agent.status === 'idle').length}/{item.agents.length} agents active</text>
          </box>} />
        </Show>}>
          <text fg={uiColors.textMuted}>Loading workspaces…</text>
        </Show>
      </Panel>
      <StatusBar prompt={`${items().length} workspaces`} approval={false} keybinds={[{ key: 'Enter', action: 'switch workspace' }, { key: 'n', action: 'new workflow' }, { key: 'f', action: 'filter' }, { key: 'o', action: 'sort' }, { key: 'r', action: 'refresh' }, { key: '?', action: 'help' }, { key: 'Shift+T', action: 'theme' }, { key: 'q', action: 'quit' }]} />
      <NotificationOverlay />
      <Show when={themePicker()}><ThemePickerModal selected={themeIndex()} active={getActiveThemeName()} themes={themeNames} query="" filtering={false} /></Show>
      <Show when={modal()}><NewWorkflowModal projects={projects()} models={models()} sshPassphraseRequired={sshPassphraseRequired()} onKeyReady={handler => setModalHandler(() => handler)} onCancel={() => { setModal(false); props.keymap.setData('modal.active', 'none'); setModalHandler(undefined); }} onComplete={async (input) => { if (!herdrAvailable()) { showHerdrUnavailable(); return; } setSshPassphraseRequired(false); setMessage('Starting workflow…'); try { setMessage(await startWorkflow({ ...input, workflowType: input.workflowType ?? 'standard' })); setModal(false); props.keymap.setData('modal.active', 'none'); setModalHandler(undefined); refresh(); } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        if (/permission denied \(publickey\)/i.test(message)) { setSshPassphraseRequired(true); return; }
        showError('Workflow execution failed', message);
      } }} /></Show>
      <Show when={help()}><HelpModal title="Workspace overview keybindings" sections={helpSections} offset={helpOffset()} lines={Math.max(5, Math.floor(dimensions().height * .78) - 5)} /></Show>
      <Show when={filterModal()}><FilterModal focusedPane={filterFocusedPane()} selectedParameter={filterSelectedParameter()} selectedValue={filterSelectedValue()} parameters={filterParameters} values={filterValues} /></Show>
      <Show when={sortModal()}><SortModal selectedIndex={sortSelectedIndex()} options={sortOptions} direction={sortDirection()} /></Show>
      <Show when={error()}>{current => <ErrorDialog title={current().title} message={current().message} onClose={closeError} onScrollBoxReady={ref => { errorScroll = ref; }} />}</Show>
    </box>
  );
}
