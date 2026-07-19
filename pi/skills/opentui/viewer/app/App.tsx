/** @jsxImportSource @opentui/solid */
import { TextAttributes, type KeyEvent } from '@opentui/core';
import { useRenderer } from '@opentui/solid';
import { createMemo, createSignal, onCleanup, onMount } from 'solid-js';
import { Badge } from '../components/Badge';
import { HighlightedText } from '../components/Highlight';
import { NotificationOverlay } from '../components/Notification';
import { StatusBar } from '../components/StatusBar';
import { FilterModal, SortModal, statusOptions } from '../components/TraceModals';
import { TraceDb } from '../model/db';
import { TraceStore, type SortCriterion } from '../model/traceStore';
import type { TreeNode } from '../model/types';
import { uiColors } from '../ui/colors';
import { TraceListView } from '../views/TraceListView';
import { TraceTreeView } from '../views/TraceTreeView';
import { SpanDetailView } from '../views/SpanDetailView';
import { copyText } from './clipboard';
import { createNavigation } from './navigation';
import { notify } from './notifications';
import { applyTheme, loadThemeName, themeNames } from './theme';
type Workspace = { changeId: string; path: string; spanCount: number };

export function App(props: { repo: string }) {
  const renderer = useRenderer();
  const nav = createNavigation();
  const db = new TraceDb();
  const store = new TraceStore();
  const [selectedListIndex, setSelectedListIndex] = createSignal(0);
  const [selectedTraceId, setSelectedTraceId] = createSignal<string>();
  const [treeRoots, setTreeRoots] = createSignal<TreeNode[]>([]);
  const [treeIndex, setTreeIndex] = createSignal(0);
  const [selectedSpan, setSelectedSpan] = createSignal<TreeNode>();
  const [activeWorkspace, setActiveWorkspace] = createSignal<string>();
  const [workspaces, setWorkspaces] = createSignal<Workspace[]>([]);
  const [spanCount, setSpanCount] = createSignal(0);
  const [filteredCount, setFilteredCount] = createSignal(0);
  const [themeIndex, setThemeIndex] = createSignal(Math.max(0, themeNames.indexOf(loadThemeName())));
  const [lastQuit, setLastQuit] = createSignal(0);
  const [dataVersion, setDataVersion] = createSignal(0);
  const [filterPane, setFilterPane] = createSignal<'criteria' | 'values'>('criteria');
  const [filterCriterion, setFilterCriterion] = createSignal(0);
  const [filterStatusIndex, setFilterStatusIndex] = createSignal(0);
  const [filterWorkspaceIndex, setFilterWorkspaceIndex] = createSignal(0);
  const [sortIndex, setSortIndex] = createSignal(0);
  const [sortDraft, setSortDraft] = createSignal<SortCriterion[]>(store.sortCriteria_);
  const [searchMode, setSearchMode] = createSignal(false);
  const [searchQuery, setSearchQuery] = createSignal('');
  let searchPrevious = ''; 

  db.scanAllWorkspaces(props.repo);
  db.cleanupOlderThan();
  setWorkspaces(db.getWorkspaces());
  store.loadFile(db.loadSpans());
  setSpanCount(store.spanCount_);
  setFilteredCount(store.filteredCount_);

  const summaries = createMemo(() => { dataVersion(); return store.getTraceSummaries(); });
  const flatTree = () => {
    const walk = (nodes: TreeNode[], parents: number[]): Array<{ node: TreeNode; path: number[] }> => nodes.flatMap((node, index) => {
      const path = [...parents, index];
      return [{ node, path }, ...(node.expanded ? walk(node.children, path) : [])];
    });
    return walk(treeRoots(), []);
  };
  const refresh = () => { setDataVersion(version => version + 1); setSpanCount(store.spanCount_); setFilteredCount(store.filteredCount_); };

  function selectTrace(index: number) {
    const trace = summaries()[index];
    if (!trace) return;
    setSelectedListIndex(index);
    setSelectedTraceId(trace.traceId);
    const roots = store.getSpanTree(trace.traceId);
    setTreeRoots(roots);
    setTreeIndex(0);
    setSelectedSpan(flattenFirst(roots));
    nav.pushView('detail');
  }

  function flattenFirst(roots: TreeNode[]) {
    return roots[0];
  }

  function selectTree(path: number[]) {
    const index = flatTree().findIndex(item => item.path.join('.') === path.join('.'));
    if (index < 0) return;
    setTreeIndex(index);
    setSelectedSpan(flatTree()[index]!.node);
  }

  function setNodeExpanded(path: number[], expanded: boolean) {
    let node: TreeNode | undefined;
    let nodes = treeRoots();
    for (const index of path) { node = nodes[index]; if (!node) return; nodes = node.children; }
    if (!node) return;
    node.expanded = expanded;
    setTreeRoots([...treeRoots()]);
    const current = flatTree()[Math.min(treeIndex(), Math.max(0, flatTree().length - 1))];
    if (current) setSelectedSpan(current.node);
  }

  function switchWorkspace(changeId?: string) {
    setActiveWorkspace(changeId);
    store.loadFile(db.loadSpans(changeId));
    setSelectedListIndex(0);
    setSelectedTraceId(undefined);
    setTreeRoots([]);
    setSelectedSpan(undefined);
    nav.popView();
    refresh();
  }

  onMount(() => {
    const prune = () => {
      const removed = db.cleanupOlderThan();
      if (!removed) return;
      setWorkspaces(db.getWorkspaces());
      store.loadFile(db.loadSpans(activeWorkspace()));
      setSelectedListIndex(0);
      refresh();
      notify(`Pruned ${removed} spans older than 30 days`, 'info');
    };
    const dailyPrune = setInterval(prune, 86_400_000);
    const stop = db.watchWorkspaces(props.repo, (changeId, spans) => {
      setWorkspaces(db.getWorkspaces());
      if (!activeWorkspace() || activeWorkspace() === changeId) {
        store.loadFile(db.loadSpans(activeWorkspace()));
        refresh();
      }
      notify(`${changeId}: ${spans.length} new spans`, 'info');
    });
    onCleanup(() => { clearInterval(dailyPrune); stop(); db.close(); });
  });

  const copySelection = (reportEmpty = false) => {
    const text = renderer.getSelection()?.getSelectedText() ?? '';
    if (!text) { if (reportEmpty) notify('No selection to copy', 'warning'); return; }
    const copied = copyText(text);
    notify(copied ? 'Copied selection' : 'Copy failed', copied ? 'success' : 'error');
    renderer.clearSelection();
  };

  const handleKey = (event: KeyEvent) => {
    const key = event.name.toLowerCase();
    if ((event.meta && key === 'c') || (event.ctrl && event.shift && key === 'c')) { copySelection(true); return; }
    if (key === 'escape' && nav.esc()) return;
    if (nav.modal() === 'filter') {
      if (key === 'x') { store.applyFilter(''); store.setStatusFilter('all'); setSearchQuery(''); setFilterPane('criteria'); setFilterCriterion(0); setFilterStatusIndex(0); setFilterWorkspaceIndex(0); switchWorkspace(); refresh(); }
      else if (key === 'h' || key === 'left') setFilterPane('criteria');
      else if (key === 'l' || key === 'right') setFilterPane('values');
      else if (filterPane() === 'criteria' && (key === 'j' || key === 'down')) setFilterCriterion(index => Math.min(1, index + 1));
      else if (filterPane() === 'criteria' && (key === 'k' || key === 'up')) setFilterCriterion(index => Math.max(0, index - 1));
      else if (filterPane() === 'values' && filterCriterion() === 0 && (key === 'j' || key === 'down')) setFilterStatusIndex(index => Math.min(statusOptions.length - 1, index + 1));
      else if (filterPane() === 'values' && filterCriterion() === 0 && (key === 'k' || key === 'up')) setFilterStatusIndex(index => Math.max(0, index - 1));
      else if (filterPane() === 'values' && filterCriterion() === 1 && (key === 'j' || key === 'down')) setFilterWorkspaceIndex(index => Math.min(workspaces().length, index + 1));
      else if (filterPane() === 'values' && filterCriterion() === 1 && (key === 'k' || key === 'up')) setFilterWorkspaceIndex(index => Math.max(0, index - 1));
      else if (key === 'enter' || key === 'return') { store.setStatusFilter(statusOptions[filterStatusIndex()]!.value); switchWorkspace(filterWorkspaceIndex() === 0 ? undefined : workspaces()[filterWorkspaceIndex() - 1]?.changeId); setSelectedListIndex(0); refresh(); nav.popModal(); }
      return;
    }
    if (nav.modal() === 'sort') {
      const shifted = event.shift || (event.name.length === 1 && event.name >= 'A' && event.name <= 'Z');
      if (key === 'space') setSortDraft(criteria => criteria.map((criterion, index) => index === sortIndex() ? { ...criterion, mode: criterion.mode === 'asc' ? 'desc' : criterion.mode === 'desc' ? 'none' : 'asc' } : criterion));
      else if (key === 'j' && shifted) setSortDraft(criteria => { const index = sortIndex(); if (index >= criteria.length - 1) return criteria; const copy = [...criteria]; [copy[index], copy[index + 1]] = [copy[index + 1]!, copy[index]!]; setSortIndex(index + 1); return copy; })
      else if (key === 'k' && shifted) setSortDraft(criteria => { const index = sortIndex(); if (index === 0) return criteria; const copy = [...criteria]; [copy[index], copy[index - 1]] = [copy[index - 1]!, copy[index]!]; setSortIndex(index - 1); return copy; })
      else if (key === 'j' || key === 'down') setSortIndex(index => Math.min(sortDraft().length - 1, index + 1));
      else if (key === 'k' || key === 'up') setSortIndex(index => Math.max(0, index - 1));
      else if (key === 'enter' || key === 'return') { store.setSortCriteria(sortDraft()); setSelectedListIndex(0); refresh(); nav.popModal(); }
      return;
    }
    if (searchMode()) {
      if (key === 'escape') { store.applyFilter(searchPrevious); setSearchQuery(searchPrevious); refresh(); setSearchMode(false); }
      else if (key === 'backspace') { const query = searchQuery().slice(0, -1); setSearchQuery(query); store.applyFilter(query); setSelectedListIndex(0); refresh(); }
      else if (key === 'enter' || key === 'return') setSearchMode(false);
      else if (key.length === 1 && !event.ctrl && !event.meta) { const query = searchQuery() + key; setSearchQuery(query); store.applyFilter(query); setSelectedListIndex(0); refresh(); }
      return;
    }
    const shifted = event.shift || (event.name.length === 1 && event.name >= 'A' && event.name <= 'Z');
    if (key === '/') { searchPrevious = store.filterQuery_; setSearchQuery(searchPrevious); setSearchMode(true); }
    else if (key === 'f' && shifted) { setFilterPane('criteria'); setFilterCriterion(0); setFilterStatusIndex(Math.max(0, statusOptions.findIndex(option => option.value === store.statusFilter_))); setFilterWorkspaceIndex(Math.max(0, workspaces().findIndex(workspace => workspace.changeId === activeWorkspace()) + 1)); nav.pushModal('filter'); }
    else if (key === 'o' && shifted) { setSortDraft(store.sortCriteria_); setSortIndex(0); nav.pushModal('sort'); }
    else if (key === 'q') {
      const now = Date.now();
      if (lastQuit() && now - lastQuit() < 1000) (globalThis as any).__renderer?.destroy();
      else { setLastQuit(now); notify('Press q again to quit', 'info'); }
    } else if (event.shift && key === 't') {
      const next = (themeIndex() + 1) % themeNames.length;
      setThemeIndex(next); applyTheme(themeNames[next]!); notify(`Theme: ${themeNames[next]}`, 'info');
    } else if (key === '?') notify(nav.view() === 'selection' ? 'j/k select · Enter trace · w workspaces · q quit' : 'j/k span · h/l collapse · Esc back · q quit', 'info');
    else if (key === 'w') { switchWorkspace(); notify('All workspaces', 'info'); }
    else if (nav.view() === 'selection') {
      if (key === 'j' || key === 'down') setSelectedListIndex(index => Math.min(summaries().length - 1, index + 1));
      else if (key === 'k' || key === 'up') setSelectedListIndex(index => Math.max(0, index - 1));
      else if (key === 'enter' || key === 'return') selectTrace(selectedListIndex());
      else if (key === 's' && event.ctrl) { store.setSort('latency'); refresh(); }
    } else {
      const items = flatTree();
      if (key === 'escape' || key === 'b') nav.popView();
      else if (key === 'j' || key === 'down') { const index = Math.min(items.length - 1, treeIndex() + 1); setTreeIndex(index); setSelectedSpan(items[index]?.node); }
      else if (key === 'k' || key === 'up') { const index = Math.max(0, treeIndex() - 1); setTreeIndex(index); setSelectedSpan(items[index]?.node); }
      else if (key === 'g' && event.shift) { const index = Math.max(0, items.length - 1); setTreeIndex(index); setSelectedSpan(items[index]?.node); }
      else if (key === 'g') { setTreeIndex(0); setSelectedSpan(items[0]?.node); }
      else if (key === 'h') { const item = items[treeIndex()]; if (item) setNodeExpanded(item.path, false); }
      else if (key === 'l') { const item = items[treeIndex()]; if (item) setNodeExpanded(item.path, true); }
      else if (key === 'enter' || key === 'return') { if (selectedSpan()) nav.pushView('span'); }
    }
  };
  renderer.keyInput.on('keypress', handleKey);
  onCleanup(() => renderer.keyInput.off('keypress', handleKey));

  return <box backgroundColor={uiColors.bgBase} width="100%" height="100%" onMouseUp={() => copySelection()}>
    <box backgroundColor={uiColors.bgBase} style={{ width: '100%', height: '100%', flexDirection: 'column', padding: 1, gap: 1 }}>
    <box style={{ height: 1, flexDirection: 'row' }}>
      <HighlightedText text="OTEL TRACE VIEWER" attributes={TextAttributes.BOLD} />
      <text fg={uiColors.textMuted}>  {spanCount()} spans · {filteredCount()} filtered</text>
      <box style={{ flexGrow: 1 }} />
      <Badge text={nav.view() === 'selection' ? 'SELECT' : 'TRACE'} highlight={nav.view() === 'selection' ? 'accent' : 'positive'} />
    </box>
    <box backgroundColor={uiColors.bgMantle} style={{ flexGrow: 1, minHeight: 0, flexDirection: 'column' }}>
      {nav.view() === 'selection' && <TraceListView summaries={summaries} selectedIndex={selectedListIndex} searchMode={searchMode} searchQuery={searchQuery} resultCount={filteredCount} onSelect={selectTrace} />}
      {nav.view() === 'detail' && <box style={{ flexGrow: 1, minHeight: 0, flexDirection: 'column' }}>
        <box height={2} paddingLeft={1} flexShrink={0} flexDirection="column">
          <box height={1} flexDirection="row"><HighlightedText text="Span tree" attributes={TextAttributes.BOLD} /><box style={{ flexGrow: 1 }} /><text fg={uiColors.textMuted}>{flatTree().length} visible</text></box>
          <text fg={uiColors.textMuted}>{selectedSpan() ? `${selectedSpan()!.span.serviceName} · ${selectedSpan()!.span.spanId}` : 'Select a span'}</text>
        </box>
        <box style={{ flexGrow: 1, minHeight: 0 }}><TraceTreeView roots={treeRoots} selectedIndex={treeIndex} onToggle={(node, path) => setNodeExpanded(path, !node.expanded)} onSelect={selectTree} /></box>
      </box>}
      {nav.view() === 'span' && <SpanDetailView node={selectedSpan} />}
    </box>
    <StatusBar keybinds={nav.view() === 'selection' ? [{ key: 'j/k', action: 'select' }, { key: 'Enter', action: 'open trace' }, { key: '/', action: 'search' }, { key: 'Shift+F', action: 'filter' }, { key: 'Shift+O', action: 'sort' }, { key: '⌘C/Ctrl+Shift+C', action: 'copy' }, { key: 'q', action: 'quit' }] : nav.view() === 'detail' ? [{ key: 'j/k', action: 'span' }, { key: 'h/l', action: 'collapse' }, { key: 'Enter', action: 'details' }, { key: 'Esc', action: 'back' }] : [{ key: 'Esc', action: 'back' }, { key: '⌘C/Ctrl+Shift+C', action: 'copy' }]} />
    </box>
    <NotificationOverlay />
    {nav.modal() === 'filter' && <FilterModal pane={filterPane} criterion={filterCriterion} statusIndex={filterStatusIndex} workspaceIndex={filterWorkspaceIndex} workspaces={workspaces} />}
    {nav.modal() === 'sort' && <SortModal selected={sortIndex} criteria={sortDraft} />}
  </box>;
}
