/** @jsxImportSource @opentui/solid */
import { Show, createEffect, createSignal, onCleanup, onMount } from 'solid-js';
import { ListViewModal } from './ListViewModal';
import { GenericModal } from './GenericModal';
import { uiColors } from './colors';
import { ProgressModal } from './ProgressModal';
import { discoverChanges } from '../data';
import type { KeyEvent } from '@opentui/core';

export type NewWorkflowInput = { repo: string; ticket: string; change: string; task?: string; mode: string; worker: string; workflowType: string; sshPassphrase: string };
type Project = { name: string; path: string; openspec: boolean };
export function NewWorkflowModal(props: { projects: Project[]; models: string[]; sshPassphraseRequired: boolean; onCancel: () => void; onComplete: (input: NewWorkflowInput) => Promise<void>; onKeyReady: (handler: (key: KeyEvent) => boolean) => void }) {
  const [step, setStep] = createSignal(0);
  const [creating, setCreating] = createSignal(false);
  const [selected, setSelected] = createSignal(0);
  const [filter, setFilter] = createSignal('');
  const [filtering, setFiltering] = createSignal(false);
  const [values, setValues] = createSignal<NewWorkflowInput>({ repo: '', ticket: '', change: '', mode: '', worker: '', workflowType: 'standard', sshPassphrase: '' });
  const [showCustomRepo, setShowCustomRepo] = createSignal(false);
  const projects = () => props.projects.filter(project => project.name.toLowerCase().includes(filter().toLowerCase()));

  const fields = (): (keyof NewWorkflowInput)[] => {
    const base: (keyof NewWorkflowInput)[] = ['repo', 'workflowType', 'ticket', 'change', 'mode', 'worker', 'sshPassphrase'];
    if (values().workflowType === 'standard') {
      return ['repo', 'workflowType', 'ticket', 'change', 'task', 'mode', 'worker', 'sshPassphrase'];
    }
    return base;
  };

  const fieldLabels: Record<string, string> = {
    repo: 'Repository',
    workflowType: 'Workflow type',
    ticket: 'Ticket identifier (optional)',
    change: 'Change ID',
    task: 'Task',
    mode: 'Checkout mode',
    worker: 'Worker model',
    sshPassphrase: 'SSH key passphrase (optional)',
  };

  const workflowTypeChoices = ['standard', 'direct-apply', 'quick'];
  const workflowTypeDisplay: Record<string, string> = { standard: 'Standard', 'direct-apply': 'Apply', quick: 'Quick Implementation' };

  const choices = (): string[] => {
    const f = field();
    if (f === 'repo') return [...projects().map(p => `${p.openspec ? '●' : '○'} ${p.name}`), `Current Directory (${process.cwd().split('/').pop()})`, 'Custom path…'];
    if (f === 'workflowType') return workflowTypeChoices;
    if (f === 'change' && values().workflowType === 'direct-apply') return discoverChanges(values().repo);
    if (f === 'mode') return ['worktree', 'checkout'].filter(item => item.includes(filter().toLowerCase()));
    if (f === 'worker') return props.models.filter(item => item.toLowerCase().includes(filter().toLowerCase()));
    return [];
  };

  const listStep = () => {
    const f = field();
    return f === 'repo' || f === 'workflowType' || (f === 'change' && values().workflowType === 'direct-apply') || f === 'mode' || f === 'worker';
  };

  const confirmStep = () => step() === fields().length;
  const totalSteps = () => fields().length + 1;
  const field = () => fields()[step()];
  const summary = () => fields().map((key, index) => ({ label: fieldLabels[key], value: key === 'sshPassphrase' && values()[key] ? '••••••••' : values()[key] || '—' }));

  const updateCurrent = (value: string) => { const key = field(); if (!key) return; setValues(current => ({ ...current, [key]: value })); };
  const back = () => { if (step() === 0) props.onCancel(); else { setStep(i => Math.max(0, i - 1)); setSelected(0); setFilter(''); setFiltering(false); } };
  const next = (value: string) => { const key = field(); if (!key) return; setValues(current => ({ ...current, [key]: value })); setStep(i => Math.min(i + 1, fields().length)); setSelected(0); setFilter(''); setFiltering(false); };

  const submit = async () => {
    setCreating(true);
    try { await props.onComplete(values()); } finally { setCreating(false); }
  };

  const handler = (key: KeyEvent) => {
    if (creating()) return true;
    const name = key.name.toLowerCase();
    if (showCustomRepo()) {
      if (name === 'escape') { setShowCustomRepo(false); return true; }
      if (name === 'backspace') { setValues(v => ({ ...v, repo: v.repo.slice(0, -1) })); return true; }
      if (name === 'return' || name === 'enter') { setShowCustomRepo(false); setStep(1); setSelected(0); setFilter(''); setFiltering(false); return true; }
      if (key.sequence.length === 1 && key.sequence >= ' ') { setValues(v => ({ ...v, repo: v.repo + key.sequence })); return true; }
      return true;
    }
    if (name === 'escape') { back(); return true; }
    if (confirmStep()) {
      if (name === 'return' || name === 'enter') void submit();
      return true;
    }
    if (!listStep()) {
      const keyName = field();
      if (!keyName) return true;
      if (name === 'backspace') { setValues(current => ({ ...current, [keyName]: (current[keyName] as string)?.slice(0, -1) || '' })); return true; }
      if (name === 'return' || name === 'enter') { next((values()[keyName] as string) || ''); return true; }
      if (key.sequence.length === 1 && key.sequence >= ' ') { setValues(current => ({ ...current, [keyName]: ((current[keyName] as string) || '') + key.sequence })); return true; }
      return true;
    }
    const items = choices();
    if (name === '/') { setFiltering(true); setFilter(''); setSelected(0); return true; }
    if (filtering()) {
      if (name === 'backspace') { setFilter(value => value.slice(0, -1)); setSelected(0); return true; }
      if (name === 'return' || name === 'enter') { setFiltering(false); return true; }
      if (key.sequence.length === 1 && key.sequence >= ' ') { setFilter(value => value + key.sequence); setSelected(0); return true; }
    }
    if (name === 'j' || name === 'down') { setSelected(i => Math.min(i + 1, items.length - 1)); return true; }
    if (name === 'k' || name === 'up') { setSelected(i => Math.max(i - 1, 0)); return true; }
    if (name === 'd') { setSelected(i => Math.min(i + 8, items.length - 1)); return true; }
    if (name === 'u') { setSelected(i => Math.max(i - 8, 0)); return true; }
    if (name === 'return' || name === 'enter') {
      const choice = items[selected()];
      if (!choice) return true;
      if (step() === 0 && selected() === projects().length) { next(process.cwd()); return true; }
      if (step() === 0 && selected() === projects().length + 1) { setShowCustomRepo(true); return true; }
      if (choice) next(step() === 0 ? projects()[selected()]?.path ?? '' : choice);
      return true;
    }
    return true;
  };

  createEffect(() => {
    const maxIdx = fields().length;
    if (step() > maxIdx) setStep(maxIdx);
  });

  createEffect(() => { if (props.sshPassphraseRequired) setStep(fields().indexOf('sshPassphrase')); });
  onMount(() => props.onKeyReady(handler));
  onCleanup(() => props.onKeyReady(() => true));

  return <>
    <Show when={creating()}><ProgressModal message="Starting workspace and agents…" /></Show>
    <Show when={!creating() && showCustomRepo()}>
      <GenericModal title="New workflow" fieldLabel="Custom repository path"
        summary={summary()} step={0} total={totalSteps()}
        help={[{ key: 'Enter', action: 'Next' }, { key: 'Esc', action: 'Back' }]}>
        <input focused value={values().repo} placeholder="/absolute/path/to/repo"
          onInput={(v: string) => setValues(current => ({ ...current, repo: v }))}
          onSubmit={() => { setShowCustomRepo(false); setStep(1); setSelected(0); setFilter(''); setFiltering(false); }}
          onKeyDown={(event: KeyEvent) => { if (event.name.toLowerCase() === 'escape') setShowCustomRepo(false); }}
          focusedBackgroundColor={uiColors.bgBase} focusedTextColor={uiColors.textPrimary} />
      </GenericModal>
    </Show>
    <Show when={!creating()}><Show when={confirmStep()} fallback={
      <Show when={listStep()} fallback={
        <GenericModal title="New workflow" fieldLabel={fieldLabels[field()!]}
          summary={summary()} step={step()} total={totalSteps()}
          help={[{ key: 'Enter', action: 'Next' }, { key: 'Esc', action: 'Back' }]}>
          <Show when={field() === 'sshPassphrase'} fallback={
            <input focused value={values()[field()!] as string || ''}
              placeholder={field() === 'ticket' ? 'optional' : ''}
              onInput={updateCurrent} onSubmit={() => next(values()[field()!] as string || '')}
              onKeyDown={(event: KeyEvent) => { if (event.name.toLowerCase() === 'escape') back(); }}
              focusedBackgroundColor={uiColors.bgBase} focusedTextColor={uiColors.textPrimary} />
          }>
            <box height={1} flexDirection="row">
              <text fg={values().sshPassphrase ? uiColors.textPrimary : uiColors.textMuted}>{values().sshPassphrase ? '*'.repeat(values().sshPassphrase.length) : 'optional'}</text>
              <Show when={values().sshPassphrase}><text fg={uiColors.primary}>█</text></Show>
            </box>
          </Show>
        </GenericModal>
      }>
        <ListViewModal title="New workflow"
          fieldLabel={fieldLabels[field()!]}
          summary={summary()} items={choices()} selectedIndex={selected()}
          step={step()} total={totalSteps()}
          filterActive={filtering()} filterQuery={filter()}
          help={[{ key: 'j/k', action: 'Navigate' }, { key: '/', action: 'Filter' }, { key: 'Enter', action: 'Select' }, { key: 'Esc', action: 'Back' }]}
          renderItem={(item, active) => {
            const display = field() === 'workflowType' ? (workflowTypeDisplay[item] || item) : item;
            return <text fg={active ? uiColors.primary : uiColors.textSecondary}>{display}</text>;
          }} />
      </Show>
    }>
      <GenericModal title="Confirm workflow" summary={summary()} summaryOnly
        step={step()} total={totalSteps()}
        help={[{ key: 'Enter', action: 'Create workflow' }, { key: 'Esc', action: 'Back' }]}>
        <box />
      </GenericModal>
    </Show></Show>
  </>;
}
