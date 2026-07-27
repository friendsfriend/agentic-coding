// Workflow state object: load/save/phase bookkeeping, path helpers.
import fs from 'node:fs';
import path from 'node:path';

export type WorkflowState = Record<string, any>;

// ponytail: layout fields never leave this module — kept in-memory during a single
// process run (e.g. sequential launch_role calls in cmd_dispatch_verifiers) but
// stripped before every disk write, so persisted state.json never carries terminal
// geometry. Legacy files that still contain them simply load as extra ignored keys.
const LAYOUT_FIELDS = ['verificationSecondRowPane', 'verificationSecondRowRole', 'verificationPaneOrder'];

export function statePath(repo: string, change: string): string {
  return path.join(repo, '.herdr-workflow', change, 'state.json');
}

export function loadState(repo: string, change: string): WorkflowState {
  const p = statePath(repo, change);
  if (!fs.existsSync(p)) throw new Error(`workflow not found: ${p}`);
  return JSON.parse(fs.readFileSync(p, 'utf8'));
}

export function setPhase(state: WorkflowState, phase: string): void {
  state.phase = phase;
  state.phaseStartedAt = new Date().toISOString();
}

export function saveState(state: WorkflowState): string {
  const persisted = { ...state };
  for (const field of LAYOUT_FIELDS) delete persisted[field];
  const paths = new Set([statePath(state.worktree, state.changeId), statePath(state.repository, state.changeId)]);
  for (const p of paths) {
    fs.mkdirSync(path.dirname(p), { recursive: true });
    const tmp = p.replace(/\.json$/, '.tmp');
    fs.writeFileSync(tmp, JSON.stringify(persisted, null, 2) + '\n');
    fs.renameSync(tmp, p);
  }
  return statePath(state.worktree, state.changeId);
}

export function workflowDir(state: WorkflowState): string {
  return path.join(state.worktree, '.herdr-workflow', state.changeId);
}
