// Archive and git-operations completion: OpenSpec archiving, commit/push, and
// the phase transitions that finish a workflow. Role launching stays in
// roles.ts; this module sequences the terminal steps of the lifecycle.
import fs from 'node:fs';
import path from 'node:path';
import type { Context } from './effects.ts';
import type { Args } from './orchestration.ts';
import * as git from './git.ts';
import * as quality from './quality.ts';
import * as roles from './roles.ts';
import * as stateMod from './state.ts';
import type { WorkflowState } from './state.ts';
import * as telemetry from './telemetry.ts';
import * as tiering from './tiering.ts';

/** Return true iff this change directory exists under openspec/changes/ and needs archiving. */
function hasOpenspecChange(state: WorkflowState): boolean {
  const p = path.join(state.worktree, 'openspec', 'changes', state.changeId);
  return fs.existsSync(p) && fs.statSync(p).isDirectory();
}

function writeArchiveContext(ctx: Context, state: WorkflowState): void {
  const results: Record<string, unknown> = {};
  for (const [role, result] of Object.entries(state.verificationResults ?? {})) results[role] = (result as any).verdict;
  const p = path.join(stateMod.workflowDir(state), 'reviews', 'archive-context.md');
  const baseStatus = git.baseStatus(ctx, state);
  let rebaseNote = '';
  if (baseStatus.moved) {
    const oldBase = state.baseCommit;
    state.baseCommit = baseStatus.current!;
    stateMod.saveState(state);
    telemetry.telemetry(ctx, state, 'archive_base_moved', { base: baseStatus.base, from: oldBase, to: baseStatus.current });
    rebaseNote = `\n**${git.rebaseInstruction(baseStatus, oldBase, 'archiving or committing')}**\n`;
  }
  const instruction =
    state.workflowType === 'no-openspec'
      ? 'No OpenSpec project in this workflow; validate only and do NOT run `openspec archive`.'
      : `Run \`openspec archive ${state.changeId} --yes\` to move \`openspec/changes/${state.changeId}/\` into \`openspec/changes/archive/\`, then validate.`;
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, `# Archive context\n\nChange: ${state.changeId}\nBranch: ${state.branch}\nTicket: ${state.ticketNumber ?? '(none)'}\nVerification: ${JSON.stringify(results)}\n${rebaseNote}\n${instruction} Leave a clean, stageable working tree, do not commit or push, then start git operations.\n`);
}

/** Close built-in planner, triage, worker, verifier, and test-verifier panes; custom roles stay open. */
function closeCompletedRolePanes(ctx: Context, state: WorkflowState): void {
  for (const role of ['planner', 'triage', 'worker', ...tiering.VERIFIER_ROLES, tiering.TEST_VERIFIER]) {
    const pane = state.panes?.[role];
    if (pane) {
      try {
        ctx.herdr.call('pane', 'close', pane);
      } catch {
        /* already gone */
      }
    }
  }
}

/** Launch archive agent with its native Pi initial prompt. */
async function startArchive(ctx: Context, state: WorkflowState): Promise<void> {
  closeCompletedRolePanes(ctx, state);
  writeArchiveContext(ctx, state);
  await roles.launchRole(ctx, state, 'archive');
  state.developerApproval = true;
  telemetry.changePhase(ctx, state, 'archive', { reason: 'developer_approved' });
  telemetry.telemetry(ctx, state, 'archive_started');
}

function completeGitOperations(ctx: Context, state: WorkflowState, commit?: string, pushed?: boolean): void {
  git.ensureWorkflowBranch(ctx, state);
  const dirty = ctx.git.run(['status', '--porcelain'], state.worktree);
  if (dirty) throw new Error('working tree is dirty after git operations; commit or clean first');
  // No pane closing here: the archive pane runs this very command, and all panes
  // (including lazygit) are cleaned up by the workspace close on completion.
  telemetry.telemetry(ctx, state, 'git_operations_completed', { commit, pushed });
  telemetry.changePhase(ctx, state, 'completed');
  telemetry.finalizeWorkspaceTrace(ctx, state);
}

/** Stage, commit, push, and complete workflow changes without an agent. */
function startGitOperations(ctx: Context, state: WorkflowState): void {
  const previousPhase = state.phase;
  const previousPhaseStartedAt = state.phaseStartedAt;
  try {
    telemetry.changePhase(ctx, state, 'committing', { reason: 'archive_completed' });
    telemetry.telemetry(ctx, state, 'git_operations_started');
    const lazygitPane = state.panes?.git;
    if (lazygitPane) {
      try {
        ctx.herdr.call('pane', 'close', lazygitPane);
      } catch {
        /* already gone */
      }
    }

    git.ensureWorkflowBranch(ctx, state);
    git.ensureBaseFresh(ctx, state);
    const root = state.worktree;
    ctx.git.run(['add', '-A'], root);
    if (ctx.git.run(['diff', '--cached', '--name-only'], root)) {
      ctx.git.run(['commit', '-m', `Apply ${state.changeId}`], root);
    }
    const localHead = ctx.git.run(['rev-parse', 'HEAD'], root);
    const remote = ctx.config.workflow.remote;
    let remoteMatches: boolean;
    try {
      remoteMatches = ctx.git.run(['rev-parse', `${remote}/${state.branch}`], root) === localHead;
    } catch {
      remoteMatches = false;
    }
    const pushed = !remoteMatches;
    if (pushed) ctx.git.run(['push', '--set-upstream', remote, state.branch], root);
    telemetry.telemetry(ctx, state, 'git_operations_pushed', { commit: localHead, pushed });
    completeGitOperations(ctx, state, localHead, pushed);
  } catch (error) {
    if (state.phase === 'completed') {
      // completeGitOperations already committed/pushed and saved "completed";
      // a later failure (e.g. finalizeWorkspaceTrace) must not roll that back.
      telemetry.telemetry(ctx, state, 'git_operations_rollback_skipped', { error: String((error as Error).message ?? error), spanStatus: 'ERROR' });
      throw error;
    }
    stateMod.setPhase(state, previousPhase);
    if (previousPhaseStartedAt === undefined) delete state.phaseStartedAt;
    else state.phaseStartedAt = previousPhaseStartedAt;
    stateMod.saveState(state);
    telemetry.telemetry(ctx, state, 'git_operations_failed', { error: String((error as Error).message ?? error), spanStatus: 'ERROR' });
    telemetry.telemetry(ctx, state, 'phase_changed', { source: 'committing', target: previousPhase, reason: 'git_operations_failed', spanStatus: 'ERROR' });
    throw error;
  }
}

export function cmdGitOperations(ctx: Context, args: Args): void {
  const state = stateMod.loadState(args.repo!, args.change!);
  if (state.phase !== 'archive') throw new Error(`git-operations requires archive phase, found ${state.phase}`);
  startGitOperations(ctx, state);
  console.log('git operations started');
}

/** Advance an approved developer review into archive or git operations. */
export async function approveDeveloperReview(ctx: Context, state: WorkflowState): Promise<string> {
  telemetry.telemetry(ctx, state, 'developer_review_approved', { workflow_type: state.workflowType });
  if (hasOpenspecChange(state)) {
    quality.ensureTasksComplete(state);
    await startArchive(ctx, state);
    return 'archive started';
  }
  closeCompletedRolePanes(ctx, state);
  state.developerApproval = true;
  startGitOperations(ctx, state);
  return 'git operations started';
}

export async function cmdArchive(ctx: Context, args: Args): Promise<void> {
  const state = stateMod.loadState(args.repo!, args.change!);
  if (state.phase === 'developer-review') {
    console.log(await approveDeveloperReview(ctx, state));
    return;
  }
  if (state.phase === 'archive') {
    telemetry.telemetry(ctx, state, 'archive_completed');
    startGitOperations(ctx, state);
    console.log('git operations started');
    return;
  }
  if (state.phase === 'committing') {
    try {
      completeGitOperations(ctx, state);
    } catch (error) {
      if (String((error as Error).message).includes('working tree is dirty')) throw error;
      // Clean tree (already committed/pushed) but completion step failed after that check — advance anyway.
      telemetry.changePhase(ctx, state, 'completed');
    }
    console.log('archive complete');
    return;
  }
  throw new Error(`archive requires developer-review, archive, or committing phase, found ${state.phase}`);
}

export function cmdPreflightArchive(ctx: Context, args: Args): void {
  const state = stateMod.loadState(args.repo!, args.change!);
  if (!['archive', 'committing'].includes(state.phase)) throw new Error(`archive preflight requires archive or committing phase, found ${state.phase}`);
  git.ensureWorkflowBranch(ctx, state);
  console.log(`archive preflight passed: ${state.branch}`);
}
