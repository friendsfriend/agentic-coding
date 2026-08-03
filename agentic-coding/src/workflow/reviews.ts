// Verification review artifacts: triage input, scoped review contexts, verifier
// report reading, findings consolidation, and the failure path. The dashboard
// and CLI read these artifacts; agents write the JSONL reports per contract.
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import type { Context } from './effects.ts';
import * as completion from './completion.ts';
import type { Args } from './orchestration.ts';
import * as findings from './findings.ts';
import * as git from './git.ts';
import * as quality from './quality.ts';
import * as roles from './roles.ts';
import * as stateMod from './state.ts';
import type { WorkflowState } from './state.ts';
import * as telemetry from './telemetry.ts';
import * as tiering from './tiering.ts';

export function getReviewTier(ctx: Context, state: WorkflowState): [string, readonly string[]] {
  const stat = ctx.git.run(['diff', '--numstat', 'HEAD'], state.worktree);
  const changedPaths = ctx.git.run(['diff', '--name-only', 'HEAD'], state.worktree).split('\n').filter(Boolean);
  return tiering.reviewTier(stat, changedPaths);
}

export function triageInputPath(state: WorkflowState): string {
  return path.join(stateMod.workflowDir(state), 'reviews', `round-${state.verificationRound}-triage-input.json`);
}

export function triagePlanPath(state: WorkflowState): string {
  return path.join(stateMod.workflowDir(state), 'reviews', `round-${state.verificationRound}-triage.json`);
}

function getFileManifest(ctx: Context, root: string, files: string[]): tiering.FileManifestEntry[] {
  const numstat = ctx.git.run(['diff', '--numstat', 'HEAD'], root);
  const diffText = files.length ? ctx.git.run(['diff', '--no-color', '--unified=0', 'HEAD', '--', ...files], root) : '';
  return tiering.fileManifest(numstat, diffText, files);
}

export function writeTriageInput(ctx: Context, state: WorkflowState, tier: string): void {
  const root = state.worktree;
  const files = ctx.git.run(['diff', '--name-only', 'HEAD'], root).split('\n').filter(Boolean);
  // Full diff when previous round never completed (no coordinator verdict)
  const prevCompleted = Boolean(state.previousVerificationResults?.coordinator);
  const hashes: Record<string, string> = {};
  for (const p of files) {
    const full = path.join(root, p);
    hashes[p] = fs.existsSync(full) && fs.statSync(full).isFile() ? createHash('sha256').update(fs.readFileSync(full)).digest('hex') : 'deleted';
  }
  let changed: string[];
  if (prevCompleted) {
    const previous = state.verificationSnapshots?.[String(state.verificationRound - 1)] ?? {};
    changed = files.filter(p => hashes[p] !== previous[p]);
  } else {
    changed = [...files];
  }
  state.verificationSnapshots = { ...(state.verificationSnapshots ?? {}), [String(state.verificationRound)]: hashes };
  const available: string[] = tiering.VERIFIER_ROLES.filter(role => role !== 'openspec-verifier' || state.workflowType !== 'no-openspec');
  const checks: Record<string, unknown> = { applicableInstructions: tiering.applicableInstructions(root, changed), triagePlanSchema: 'validated by dispatch-verifiers' };
  if (state.workflowType !== 'no-openspec') checks.openSpec = quality.planQuality(state);
  const suggested = tiering.eligibleVerifierRoles(changed).filter(role => available.includes(role));
  const prior = state.previousVerificationResults ?? {};
  const reusable: Record<string, unknown> = {};
  for (const [role, result] of Object.entries(prior)) {
    if (available.includes(role) && (result as any).verdict === 'PASS') reusable[role] = result;
  }
  const p = triageInputPath(state);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(
    p,
    JSON.stringify(
      { round: state.verificationRound, tier, fileManifest: getFileManifest(ctx, root, changed), allChangedFiles: files, deterministicChecks: checks, availableRoles: available, suggestedRoles: suggested, reusablePasses: reusable },
      null,
      2,
    ) + '\n',
  );
}

function scopedDiff(ctx: Context, root: string, files: string[], hunks?: Record<string, number[]>, limit = 12000): string {
  const chunks: string[] = [];
  for (const file of files) {
    const diff = ctx.git.run(['diff', '--no-color', '--unified=0', 'HEAD', '--', file], root);
    const selected = new Set((hunks ?? {})[file] ?? []);
    if (selected.size) {
      const parts = diff.split('@@');
      chunks.push(parts[0] + parts.slice(1).map((part, index) => (selected.has(index + 1) ? `@@${part}` : '')).join(''));
    } else {
      chunks.push(diff);
    }
  }
  const diff = chunks.join('\n');
  return diff.length > limit ? diff.slice(0, limit) + '\n… diff capped; inspect only scoped files if needed.\n' : diff;
}

export function writeReviewContext(ctx: Context, state: WorkflowState, tier: string, plan: Record<string, any>): void {
  const root = state.worktree;
  for (const [role, entry] of Object.entries(plan)) {
    const files = entry.files as string[];
    const p = path.join(stateMod.workflowDir(state), 'reviews', `round-${state.verificationRound}-${role}-context.md`);
    fs.writeFileSync(
      p,
      `# Review context\n\nTier: ${tier}\nRole: ${role}\nReason: ${entry.reason}\n\n## Files in scope\n${files.join('\n')}\n\n## Scoped diff (max 12000 chars)\n\`\`\`diff\n${scopedDiff(ctx, root, files, entry.hunks)}\n\`\`\`\nReview only this context.\n`,
    );
  }
}

export function writeTestContext(ctx: Context, state: WorkflowState): void {
  const root = state.worktree;
  const triageInput = JSON.parse(fs.readFileSync(triageInputPath(state), 'utf8'));
  const files: string[] = triageInput.allChangedFiles;
  const tests = files.filter(p => p.includes('/test/') || p.includes('/tests/') || p.startsWith('test/'));
  const results: Record<string, unknown> = {};
  for (const [role, result] of Object.entries(state.verificationResults ?? {})) {
    if (role !== 'coordinator') results[role] = (result as any).verdict;
  }
  const previousTestReport = (state.previousVerificationResults?.[tiering.TEST_VERIFIER] as any)?.report;
  let priorBaseline = '(none)';
  if (typeof previousTestReport === 'string' && fs.existsSync(previousTestReport)) {
    priorBaseline = fs.readFileSync(previousTestReport, 'utf8').slice(0, 8000);
  }
  const p = path.join(stateMod.workflowDir(state), 'reviews', `round-${state.verificationRound}-${tiering.TEST_VERIFIER}-context.md`);
  fs.writeFileSync(
    p,
    `# Test verification context\n\nRun the repository's full configured test suite once without filters. Do not rerun changed tests already covered by that suite. Review regression coverage only for scoped changed behavior. Reuse matching prior baseline evidence below; only a new apparently unrelated failure permits one focused baseline reproduction.\n\n## Prior test-verifier baseline evidence\n\`\`\`jsonl\n${priorBaseline}\n\`\`\`\n\n## Changed files\n${files.join('\n')}\n\n## Changed test files\n${tests.join('\n') || '(none)'}\n\n## Selected verifier verdicts\n\`\`\`json\n${JSON.stringify(results)}\n\`\`\`\n\n## Scoped diff (max 12000 chars)\n\`\`\`diff\n${scopedDiff(ctx, root, files)}\n\`\`\`\n`,
  );
}

export function reportPath(state: WorkflowState, role: string): string {
  return path.join(stateMod.workflowDir(state), 'reviews', `round-${state.verificationRound}-${role}.findings.jsonl`);
}

export function reportEvents(state: WorkflowState, role: string): [string, findings.FindingEvent[]] {
  const p = reportPath(state, role);
  if (!fs.existsSync(p)) throw new Error(`missing JSONL report: ${p}`);
  if (fs.statSync(p).size > 48000) throw new Error(`report exceeds 48KB: ${p}`);
  const events: findings.FindingEvent[] = [];
  const lines = fs.readFileSync(p, 'utf8').split('\n');
  lines.forEach((line, index) => {
    if (!line.trim()) return;
    try {
      events.push(JSON.parse(line));
    } catch (error) {
      throw new Error(`invalid JSONL report ${p}:${index + 1}: ${(error as Error).message}`);
    }
  });
  findings.validateReportEvents(events, p);
  return [p, events];
}

export function consolidateFindings(ctx: Context, state: WorkflowState, roles: readonly string[]): string {
  const eventsByRole: Record<string, findings.FindingEvent[]> = {};
  for (const role of roles) {
    try {
      const [, events] = reportEvents(state, role);
      eventsByRole[role] = events;
    } catch {
      continue;
    }
  }
  const historyPath = path.join(stateMod.workflowDir(state), 'reviews', 'findings.json');
  const history = fs.existsSync(historyPath) ? JSON.parse(fs.readFileSync(historyPath, 'utf8')) : { rounds: {} };
  const priorRound: findings.Finding[] = history.rounds[String(state.verificationRound - 1)] ?? [];
  const acceptedPath = path.join(stateMod.workflowDir(state), 'reviews', 'accepted-findings.json');
  const accepted = new Set<string>(fs.existsSync(acceptedPath) ? JSON.parse(fs.readFileSync(acceptedPath, 'utf8')).ids ?? [] : []);
  const findingsList = findings.consolidate(eventsByRole, priorRound, accepted);
  const createdAt = ctx.clock.now().toISOString();
  for (const item of findingsList) if (!item.createdAt) item.createdAt = createdAt;
  history.rounds[String(state.verificationRound)] = findingsList;
  fs.mkdirSync(path.dirname(historyPath), { recursive: true });
  fs.writeFileSync(historyPath, JSON.stringify(history, null, 2) + '\n');

  const verdicts: Record<string, string> = {};
  for (const role of roles) verdicts[role] = state.verificationResults?.[role]?.verdict ?? 'PENDING';
  const overall = Object.values(verdicts).includes('FAIL') ? 'FAIL' : Object.values(verdicts).every(v => v === 'PASS') ? 'PASS' : 'PENDING';
  const output = path.join(stateMod.workflowDir(state), 'reviews', `round-${state.verificationRound}-consolidated.md`);
  const lines = ['# Consolidated verification', '', `Overall verdict: ${overall}`, '', '## Verdicts', ...roles.map(role => `- ${role}: ${verdicts[role]}`), '', '## Findings by verifier'];
  for (const role of roles) {
    const grouped = findingsList.filter(item => item.role === role);
    lines.push('', `### ${role}`);
    lines.push(...(grouped.length ? grouped.map(item => `- [${item.severity}] ${item.id} ${item.status} | ${item.detail}`) : ['- none']));
  }
  fs.writeFileSync(output, lines.join('\n') + '\n');
  return output;
}

export function currentFindings(state: WorkflowState, ctx?: Context): findings.Finding[] {
  const historyPath = path.join(stateMod.workflowDir(state), 'reviews', 'findings.json');
  try {
    if (!fs.existsSync(historyPath)) return [];
    return JSON.parse(fs.readFileSync(historyPath, 'utf8')).rounds?.[String(state.verificationRound)] ?? [];
  } catch (error) {
    if (ctx) telemetry.telemetry(ctx, state, 'findings_read_failed', { path: historyPath, error: String(error), spanStatus: 'ERROR' });
    return [];
  }
}

/** Return PASS-round warning/info findings still awaiting developer choice. */
export function optionalFindings(state: WorkflowState, ctx?: Context): findings.Finding[] {
  return currentFindings(state, ctx).filter(item => ['warning', 'info'].includes(item.severity ?? '') && ['new', 'unfixed'].includes(item.status));
}

function writeWorkerFixContext(ctx: Context, state: WorkflowState): string {
  const findingsList = currentFindings(state, ctx);
  const failedRoles = new Set(Object.entries(state.verificationResults ?? {}).filter(([role, result]) => role !== 'coordinator' && (result as any).verdict === 'FAIL').map(([role]) => role));
  const actionable = findingsList.filter(item => failedRoles.has(item.role) && item.status !== 'fixed');
  const files = [...new Set(actionable.map(item => item.path).filter(Boolean))].sort() as string[];
  const tests = files.filter(p => p.includes('/test/') || p.includes('/tests/') || p.startsWith('test/'));
  const p = path.join(stateMod.workflowDir(state), 'reviews', `round-${state.verificationRound}-worker-fix-context.md`);
  const lines = ['# Worker fix context', '', 'Fix findings from every failed verifier. Do not read raw verifier reports.'];
  for (const role of [...failedRoles].sort()) {
    const grouped = actionable.filter(item => item.role === role);
    lines.push('', `## ${role}`);
    lines.push(...(grouped.length ? grouped.map(item => `- [${item.severity}] ${item.id} | ${item.path} | ${item.detail} | fix: ${item.fix || 'resolve finding'}`) : ['- FAIL verdict without critical finding (contract violation)']));
  }
  lines.push('', '## Files', ...(files.length ? files.map(file => `- ${file}`) : ['- none']));
  lines.push('', '## Focused validation', ...(tests.length ? tests.map(test => `- ${test}`) : ['- nearest existing regression test for changed behavior']));
  fs.writeFileSync(p, lines.join('\n') + '\n');
  return p;
}

export async function failRound(ctx: Context, state: WorkflowState, roles: readonly string[]): Promise<void> {
  const consolidated = consolidateFindings(ctx, state, roles);
  telemetry.traceFindings(ctx, state, 'verification_finding', currentFindings(state, ctx));
  state.verificationResults.coordinator = { verdict: 'FAIL', report: consolidated };
  stateMod.saveState(state);
  await failVerification(ctx, state);
}

/**
 * Consolidate and transition out of verify once every dispatched verifier has
 * reported. Called by `finish-review` (PASS final step) and `failRound` (any
 * FAIL). No verifier role doubles as coordinator — the completion condition is
 * a pure function of recorded results.
 */
export async function completeVerification(ctx: Context, state: WorkflowState, roles: readonly string[]): Promise<void> {
  const consolidated = consolidateFindings(ctx, state, roles);
  telemetry.traceFindings(ctx, state, 'verification_finding', currentFindings(state, ctx));
  state.verificationResults.coordinator = { verdict: 'PASS', report: consolidated };
  stateMod.saveState(state);
  telemetry.changePhase(ctx, state, 'developer-review', { reason: 'verification_passed' });
  telemetry.telemetry(ctx, state, 'developer_review_ready', { tier: state.verificationTier, verifier_count: roles.length, reused: Object.keys(state.verificationReusedResults ?? {}).length });
  ctx.herdr.call('notification', 'show', 'Developer review ready', '--body', `${state.changeId} passed verification; approve archive in dashboard`, '--sound', 'done');
  console.log('verification passed');
}

export async function failVerification(ctx: Context, state: WorkflowState): Promise<void> {
  const workerContext = writeWorkerFixContext(ctx, state);
  const spare = state.verificationSecondRowPane;
  delete state.verificationSecondRowPane;
  delete state.verificationSecondRowRole;
  if (spare) {
    try {
      ctx.herdr.call('pane', 'close', spare);
    } catch {
      /* already gone */
    }
  }
  let consolidated = state.verificationResults?.coordinator?.report;
  if (!consolidated) consolidated = path.join(stateMod.workflowDir(state), 'reviews', `round-${state.verificationRound}-consolidated.md`);
  if (state.verificationRound >= ctx.config.workflow.max_verification_rounds) {
    telemetry.changePhase(ctx, state, 'paused', { reason: 'verification_round_limit' });
    telemetry.telemetry(ctx, state, 'verification_failed', { report: consolidated, spanStatus: 'ERROR' });
    ctx.herdr.call('notification', 'show', 'Verification limit reached', '--body', `${state.changeId} failed round ${state.verificationRound}; developer instruction required`, '--sound', 'request');
    console.log('verification failed at round limit; developer instruction required');
    return;
  }
  telemetry.changePhase(ctx, state, 'fix', { reason: 'verification_failed' });
  telemetry.telemetry(ctx, state, 'verification_failed', { report: consolidated, spanStatus: 'ERROR' });
  await roles.startRole(ctx, state, 'worker', `Verification failed. Read only ${workerContext}. Fix every blocker, run its focused validation, then run herdr-workflow verify --repo . --change ${state.changeId}. Do not report completion until that command succeeds.`);
  console.log('verification failed; worker notified to fix and restart verification');
}


export async function cmdFinishReview(ctx: Context, args: Args): Promise<void> {
  const state = stateMod.loadState(args.repo!, args.change!);
  if (state.phase === 'verify') {
    // Deterministic verification coordination: consolidate once every dispatched
    // verifier has reported. The gate re-reads the row under one write
    // transaction, so a concurrently committing verifier result either lands
    // before us (visible here) or transitions the phase out of verify (this
    // call then fails loudly) — the round can never be consolidated from a
    // stale snapshot that drops a FAIL verdict.
    let dispatched: string[] = [];
    const decided = stateMod.updateState(args.repo!, args.change!, s => {
      if (s.phase !== 'verify') throw new Error(`finish-review requires verify phase, found ${s.phase}`);
      const rolesList: readonly string[] = s.verificationRoles ?? tiering.VERIFIER_ROLES;
      dispatched = s.testVerifierStarted ? [...rolesList, tiering.TEST_VERIFIER] : [...rolesList];
      const missing = dispatched.filter(role => !s.verificationResults?.[role]);
      if (missing.length) throw new Error(`finish-review requires every dispatched verifier to have reported; missing: ${missing.join(', ')}`);
    });
    const failed = dispatched.some(role => decided.verificationResults?.[role]?.verdict === 'FAIL');
    if (failed) {
      await failRound(ctx, decided, dispatched);
      return;
    }
    await completeVerification(ctx, decided, dispatched);
    return;
  }
  if (state.phase !== 'developer-review') throw new Error(`finish-review requires verify or developer-review phase, found ${state.phase}`);
  const reviewDir = path.join(stateMod.workflowDir(state), 'reviews');
  const reviewPath = path.join(reviewDir, 'developer-review.json');
  // Approval requires an explicit recorded decision (the dashboard writes this
  // file before invoking finish-review). Without it, a retried finish-review
  // after the verify -> developer-review consolidation would silently approve.
  if (!fs.existsSync(reviewPath)) throw new Error(`no developer review recorded: ${reviewPath}; approve from the dashboard`);
  let payload: any;
  try {
    payload = JSON.parse(fs.readFileSync(reviewPath, 'utf8'));
  } catch (error) {
    throw new Error(`invalid developer review comments: ${(error as Error).message}`);
  }
  const comments = typeof payload === 'object' && payload !== null ? (payload.comments ?? []) : null;
  if (!Array.isArray(comments) || comments.some((comment: any) => typeof comment !== 'object' || !String(comment?.body ?? '').trim())) {
    throw new Error('developer review comments must be a list of non-empty comment objects');
  }
  const advisory = optionalFindings(state, ctx);
  const selectedIds = new Set(comments.filter((comment: any) => comment.findingId != null).map((comment: any) => String(comment.findingId)));
  const availableIds = new Set(advisory.map(item => String(item.id)));
  const unknownIds = [...selectedIds].filter(id => !availableIds.has(id));
  if (unknownIds.length) throw new Error(`developer review references unknown findings: ${unknownIds.sort().join(', ')}`);

  const acceptedPath = path.join(reviewDir, 'accepted-findings.json');
  let accepted = new Set<string>();
  try {
    accepted = new Set(fs.existsSync(acceptedPath) ? JSON.parse(fs.readFileSync(acceptedPath, 'utf8')).ids ?? [] : []);
  } catch {
    accepted = new Set();
  }
  const acceptedFindings = advisory.filter(item => !selectedIds.has(String(item.id)));
  for (const item of acceptedFindings) accepted.add(String(item.id));
  fs.mkdirSync(reviewDir, { recursive: true });
  fs.writeFileSync(acceptedPath, JSON.stringify({ ids: [...accepted].sort() }, null, 2) + '\n');
  telemetry.traceFindings(ctx, state, 'developer_accepted_finding', acceptedFindings, 'accepted');

  const commentLocation = (comment: any): string => {
    const start = comment.startLine ?? comment.line ?? 1;
    const end = comment.endLine;
    return end != null && end !== start ? `${comment.filePath ?? 'repository'}:${start}-${end}` : `${comment.filePath ?? 'repository'}:${start}`;
  };

  comments.forEach((comment: any, index: number) => {
    telemetry.telemetry(ctx, state, 'developer_review_comment', {
      comment_index: index + 1,
      finding_id: comment.findingId,
      file_path: comment.filePath,
      start_line: comment.startLine ?? comment.line,
      end_line: comment.endLine,
      body: comment.body,
    });
  });

  if (!comments.length) {
    console.log(await completion.approveDeveloperReview(ctx, state));
    return;
  }

  const contextPath = path.join(reviewDir, 'developer-review-context.md');
  fs.writeFileSync(contextPath, '# Developer review comments\n\n' + comments.map((comment: any) => `- \`${commentLocation(comment)}\`: ${String(comment.body).trim()}`).join('\n') + '\n');
  state.developerReviewComments = comments;
  state.developerApproval = false;
  stateMod.saveState(state);
  telemetry.changePhase(ctx, state, 'apply', { reason: 'developer_review_comments' });
  telemetry.telemetry(ctx, state, 'developer_review_comments_received', { count: comments.length, report: contextPath });
  const prompt = `Developer review found comments. Read only ${contextPath}. Address every comment, run focused validation, then run \`herdr-workflow verify --repo . --change ${state.changeId}\`. Do not report completion until verification starts.`;
  await roles.startRole(ctx, state, 'worker', prompt);
  console.log('developer review findings sent to worker');
}
