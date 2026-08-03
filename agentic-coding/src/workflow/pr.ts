// Optional, user-triggered PR/MR creation after git operations complete. The
// workflow never auto-creates one: `create-pr` runs once from the `completed`
// phase, records `prCreated`/`prUrl`, and the dashboard then offers only Close.
import type { Context } from './effects.ts';
import { run } from './effects.ts';
import type { Args } from './orchestration.ts';
import * as reviews from './reviews.ts';
import * as stateMod from './state.ts';
import type { WorkflowState } from './state.ts';
import * as telemetry from './telemetry.ts';

/** Pick the PR tool from the origin remote URL; null when the host is unknown. */
export function detectPrTool(remoteUrl: string): string | null {
  if (/github\.com[:/]/i.test(remoteUrl)) return 'gh';
  if (/gitlab\.com[:/]/i.test(remoteUrl)) return 'glab';
  return null;
}

/** Build the tool-specific create command args (gh vs glab flag names differ). */
export function prCreateArgs(tool: string, title: string, body: string, baseBranch: string, headBranch: string): string[] {
  const baseName = baseBranch.replace(/^origin\//, '');
  return tool === 'gh'
    ? ['pr', 'create', '--title', title, '--body', body, '--base', baseName, '--head', headBranch]
    : ['mr', 'create', '--title', title, '--description', body, '--target-branch', baseName];
}

export function prTitle(state: WorkflowState): string {
  const task = (state.task ?? '').trim();
  const firstLine = task ? task.split('\n', 1)[0]!.trim() : '';
  const subject = firstLine || state.changeId;
  const title = state.ticketNumber ? `[${state.ticketNumber}] ${subject}` : subject;
  return title.slice(0, 72);
}

export function prBody(state: WorkflowState): string {
  const results = state.verificationResults ?? {};
  const verdictLines = Object.entries(results)
    .filter(([role]) => role !== 'coordinator')
    .map(([role, result]) => `- ${role}: ${(result as { verdict?: string }).verdict ?? 'PENDING'}`);
  const findings = reviews.currentFindings(state);
  const advisory = findings.filter(item => ['warning', 'info'].includes(item.severity ?? ''));
  const lines = [
    `## Change`,
    state.changeId,
    '',
    `## Ticket`,
    state.ticketNumber ?? '(none)',
    '',
    `## Task`,
    state.task ?? '(none)',
    '',
    `## Verification`,
    `Round ${state.verificationRound} (${state.verificationTier ?? 'n/a'})`,
    ...(verdictLines.length ? verdictLines : ['- (no verifier results)']),
    '',
    `## Findings`,
    ...(advisory.length ? advisory.map(item => `- [${item.severity}] ${item.path ?? ''}${item.line ? `:${item.line}` : ''} ${item.detail}`) : ['No advisory findings']),
  ];
  return lines.join('\n');
}

/** Create the PR/MR for a completed workflow. Fails loudly on error so the
 * operator can retry; `prCreated` is only set on success. */
export function cmdCreatePr(ctx: Context, args: Args): void {
  const state = stateMod.loadState(args.repo!, args.change!);
  if (state.phase !== 'completed') throw new Error(`create-pr requires completed phase, found ${state.phase}`);
  if (state.prCreated) throw new Error('PR/MR already created for this workflow');
  const remote = ctx.git.run(['remote', 'get-url', ctx.config.workflow.remote], state.worktree);
  const tool = ctx.config.workflow.pr_tool ?? detectPrTool(remote);
  if (!tool) throw new Error(`cannot determine PR tool for remote ${remote}; set workflow.pr_tool in config`);
  const title = prTitle(state);
  const body = prBody(state);
  const output = run(prCreateArgs(tool, title, body, state.baseBranch ?? 'main', state.branch), state.worktree);
  const url = /(https?:\/\/\S+)/.exec(output)?.[1] ?? null;
  state.prCreated = true;
  state.prUrl = url;
  stateMod.saveState(state);
  telemetry.telemetry(ctx, state, 'pr_created', { tool, url, title });
  console.log(`PR/MR created: ${url ?? output}`);
}
