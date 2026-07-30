// Herdr terminal tab/pane layout — the workflow's BSP verification-layout module.
// Owns tab/pane creation, closing, and the geometry that groups verifier roles into
// a shared "verification" tab. Placement bookkeeping (order/spare pane) is kept only
// on the in-memory state object during a single dispatch; state.ts strips it before
// every disk write (see state.ts LAYOUT_FIELDS), so it is never durable — it is
// reconstructed each launch from live `panes`/`tabs` when absent.
import type { Context } from './effects.ts';
import * as prompts from './prompts.ts';
import type { WorkflowState } from './state.ts';
import * as tiering from './tiering.ts';

const PANE_READY_TIMEOUT_SECONDS = 5;
export const VERIFICATION_TAB_ROLES: readonly string[] = ['triage', ...tiering.VERIFIER_ROLES, tiering.TEST_VERIFIER];

export async function waitForPaneReady(ctx: Context, paneId: string): Promise<void> {
  const deadline = ctx.clock.monotonic() + PANE_READY_TIMEOUT_SECONDS;
  while (ctx.clock.monotonic() < deadline) {
    const process = ctx.herdr.call('pane', 'process-info', '--pane', paneId).process_info ?? {};
    if (process.foreground_processes?.length) {
      await ctx.clock.sleep(0.25);
      return;
    }
    await ctx.clock.sleep(0.1);
  }
  throw new Error(`pane shell did not become ready: ${paneId}`);
}

export function createTab(ctx: Context, workspace: string, label: string, role?: string, change?: string): { pane_id: string; tab_id: string } {
  const args = ['tab', 'create', '--workspace', workspace];
  if (role && change) args.push(...prompts.roleEnv(role, change));
  args.push('--label', label);
  return ctx.herdr.call(...args).root_pane;
}

export function hasRolePane(state: WorkflowState, role: string): boolean {
  return (state.panes ?? {})[role] != null;
}

/** Close stale grouped pane or standalone role tab. */
export function closeOldPane(ctx: Context, state: WorkflowState, role: string): void {
  const old = (state.panes ?? {})[role];
  if (VERIFICATION_TAB_ROLES.includes(role)) {
    if (old) {
      try {
        ctx.herdr.call('pane', 'close', old);
      } catch {
        /* already gone */
      }
    }
    return;
  }
  let oldTab = (state.tabs ?? {})[role];
  if (old) {
    try {
      oldTab = ctx.herdr.call('pane', 'get', old).pane?.tab_id ?? oldTab;
    } catch {
      /* pane already gone */
    }
  }
  if (oldTab) {
    try {
      ctx.herdr.call('tab', 'close', oldTab);
      return;
    } catch {
      /* fall through to pane close */
    }
  }
  if (old) {
    try {
      ctx.herdr.call('pane', 'close', old);
    } catch {
      /* already gone */
    }
  }
}

export function liveVerificationTarget(ctx: Context, state: WorkflowState, role: string, candidates?: Iterable<string>): [string, string] | null {
  const tab = (state.tabs ?? {}).verification;
  const standaloneTabs = new Set(Object.entries(state.tabs ?? {}).filter(([key]) => !VERIFICATION_TAB_ROLES.includes(key) && key !== 'verification').map(([, value]) => value as string));
  if (!tab || standaloneTabs.has(tab)) return null;
  for (const sibling of candidates ?? VERIFICATION_TAB_ROLES) {
    const pane = (state.panes ?? {})[sibling];
    if (sibling === role || !pane || (state.tabs ?? {})[sibling] !== tab) continue;
    try {
      const agent = ctx.herdr.call('agent', 'get', pane).agent;
      if (agent?.pane_id === pane) return [tab, pane];
    } catch {
      continue;
    }
  }
  return null;
}

export function launchLabel(role: string): string {
  if (VERIFICATION_TAB_ROLES.includes(role)) return 'verification';
  return ({ planner: 'explore', worker: 'apply' } as Record<string, string>)[role] ?? role.replace(/-verifier$/, '');
}

export interface PanePlacement {
  targetTab: string;
  launchPane: string;
  createdTab: boolean;
  createdSparePane: string | null;
  usedSpare: boolean;
  order: string[];
  spareRole: string | null;
}

function currentOrder(state: WorkflowState): string[] {
  return (
    state.verificationPaneOrder ??
    VERIFICATION_TAB_ROLES.filter(sibling => (state.panes ?? {})[sibling] && (state.tabs ?? {})[sibling] === (state.tabs ?? {}).verification)
  );
}

/** Compute (and perform) the tab/pane creation for launching `role`, mirroring the
 * two-row BSP grouping: first two verification roles split left|right on row one,
 * remaining roles split into row two beneath the first pane. */
export function placeLaunchPane(ctx: Context, state: WorkflowState, role: string, workspace: string, worktree: string, change: string): PanePlacement {
  const target = VERIFICATION_TAB_ROLES.includes(role) ? liveVerificationTarget(ctx, state, role) : null;
  const createdTab = target === null;
  let createdSparePane: string | null = null;
  let usedSpare = false;
  let spareRole: string | null = null;
  const order = currentOrder(state);
  const position = order.includes(role) ? order.indexOf(role) : order.length;
  let targetTab: string;
  let launchPane: string;

  if (createdTab) {
    const pane = ctx.herdr.call('tab', 'create', '--workspace', workspace, '--cwd', worktree, ...prompts.roleEnv(role, change), '--label', launchLabel(role), '--no-focus').root_pane;
    targetTab = pane.tab_id;
    launchPane = pane.pane_id;
  } else {
    const [tab, initialSibling] = target!;
    targetTab = tab;
    let siblingPane = initialSibling;
    if (position === 1 && order.length === 1) {
      // Split bottom first so BSP layout becomes (first | second) / third — but only
      // when a third role is already known and launching in this same dispatch batch.
      // The eventual test-verifier (which always runs later, after verifiers pass) is
      // not "known soon": reserving space for it here would leave an empty pane sitting
      // idle for the verifier's whole run. Let it split in lazily when it actually starts.
      const selected: string[] = state.verificationRoles ?? [];
      const selectedIndex = selected.indexOf(role);
      const nextRole = selectedIndex + 1 < selected.length ? selected[selectedIndex + 1] : null;
      if (nextRole) {
        spareRole = nextRole;
        createdSparePane = ctx.herdr.call('pane', 'split', siblingPane, '--direction', 'down', '--cwd', worktree, ...prompts.roleEnv(spareRole, change), '--no-focus').pane.pane_id;
      }
    }
    if (position >= 2 && state.verificationSecondRowPane && state.verificationSecondRowRole === role) {
      launchPane = state.verificationSecondRowPane;
      usedSpare = true;
    } else {
      const rowCandidates = position >= 2 ? [...order.slice(2)].reverse() : [...order.slice(0, 2)].reverse();
      const rowTarget = liveVerificationTarget(ctx, state, role, rowCandidates);
      siblingPane = (rowTarget ?? target)![1];
      const direction = position >= 2 && !rowTarget ? 'down' : 'right';
      launchPane = ctx.herdr.call('pane', 'split', siblingPane, '--direction', direction, '--cwd', worktree, ...prompts.roleEnv(role, change), '--no-focus').pane.pane_id;
    }
  }

  return { targetTab, launchPane, createdTab, createdSparePane, usedSpare, order, spareRole };
}

/** Record the transient verification-tab bookkeeping onto state after a successful launch. */
export function recordVerificationPlacement(state: WorkflowState, role: string, placement: PanePlacement, tabId: string): void {
  if (!VERIFICATION_TAB_ROLES.includes(role)) return;
  state.tabs = { ...(state.tabs ?? {}), verification: tabId };
  let order = placement.order;
  if (placement.createdTab) {
    order = [role];
    delete state.verificationSecondRowPane;
  } else if (!order.includes(role)) {
    order = [...order, role];
  }
  state.verificationPaneOrder = order;
  if (placement.createdSparePane) {
    state.verificationSecondRowPane = placement.createdSparePane;
    state.verificationSecondRowRole = placement.spareRole;
  } else if (placement.usedSpare) {
    delete state.verificationSecondRowPane;
    delete state.verificationSecondRowRole;
  }
}
