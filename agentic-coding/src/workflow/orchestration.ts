// cmd_* orchestration: wires the phase flow (transitions/tiering/findings/tracing
// gates) to effects (herdr/git/clock/exporter) via the Context. Role lifecycle
// lives in roles.ts, review artifacts in reviews.ts, plan gates in quality.ts,
// and archive/git completion in completion.ts — this module only sequences.
//
// Moved cmd_* are re-exported here so the CLI surface and tests keep one import
// root; new code should import from the owning module directly.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { Context } from './effects.ts';
import * as findings from './findings.ts';
import * as git from './git.ts';
import * as layout from './layout.ts';
import * as prompts from './prompts.ts';
import * as quality from './quality.ts';
import * as roles from './roles.ts';
import * as reviews from './reviews.ts';
import * as stateMod from './state.ts';
import type { WorkflowState } from './state.ts';
import * as telemetry from './telemetry.ts';
import * as tiering from './tiering.ts';
import * as tracing from './tracing.ts';
import * as transitions from './transitions.ts';

export { cmdFinishReview } from './reviews.ts';
export { cmdArchive, cmdGitOperations, cmdPreflightArchive } from './completion.ts';
export { launchRole, promptRole, roleAgentName, startRole } from './roles.ts';
export { triageInputPath, triagePlanPath, reportPath, optionalFindings } from './reviews.ts';

export interface Args {
  repo?: string;
  change?: string;
  task?: string | null;
  mode?: 'worktree' | 'checkout';
  ticket?: string | null;
  worker?: string;
  workflowType?: string;
  phase?: string;
  workspace?: string;
  role?: string;
  sender?: string;
  target?: string;
  text?: string;
}

export async function cmdPlanner(ctx: Context, args: Args): Promise<void> {
  const state = stateMod.loadState(args.repo!, args.change!);
  if (state.phase !== 'explore') throw new Error(`planner restart invalid during phase ${state.phase}`);
  await roles.startRole(ctx, state, 'planner');
  console.log('planner started');
}

// ---------------------------------------------------------------------------
// start
// ---------------------------------------------------------------------------

export async function cmdStart(ctx: Context, args: Args): Promise<void> {
  const config = ctx.config;
  const ticket = args.ticket ? args.ticket.trim() : null;
  const ticketBranch = ticket ? ticket.replace(/[^A-Za-z0-9._-]+/g, '-').replace(/^[.-]+|[.-]+$/g, '') : null;
  if (ticket && !/[A-Za-z0-9]/.test(ticket)) throw new Error('ticket identifier must contain at least one letter or digit');
  const source = fs.realpathSync(path.resolve(args.repo!.replace(/^~/, os.homedir())));
  const passphrase = process.env.HERDR_SSH_PASSPHRASE ?? '';
  delete process.env.HERDR_SSH_PASSPHRASE;
  const workflowType = args.workflowType ?? 'standard';
  git.ensureClean(ctx, source, workflowType !== 'no-openspec');
  const remote = config.workflow.remote;
  git.unlockSshKeys(ctx, source, remote, passphrase);
  const baseBranch = git.remoteDefaultBranch(ctx, source, remote);
  const base = ctx.git.run(['rev-parse', '--verify', baseBranch], source);
  const branchName = ticketBranch ? `${ticketBranch}-${args.change}` : args.change!;
  const branch = config.workflow.branch_prefix + branchName;

  let workspace: string;
  let root: string;
  let worktree: string;
  if (args.mode === 'worktree') {
    const result = ctx.herdr.call('worktree', 'create', '--cwd', source, '--branch', branch, '--base', base, '--no-focus');
    workspace = result.workspace.workspace_id;
    root = result.root_pane.pane_id;
    worktree = result.worktree.path;
  } else {
    if (ctx.git.run(['branch', '--list', branch], source)) throw new Error(`branch already exists: ${branch}`);
    ctx.git.run(['switch', '-c', branch, base], source);
    const result = ctx.herdr.call('workspace', 'create', '--cwd', source, '--label', args.change!);
    workspace = result.workspace.workspace_id;
    root = result.root_pane.pane_id;
    worktree = source;
  }

  ctx.herdr.call('workspace', 'rename', workspace, args.change!);
  const firstTab = ctx.herdr.call('tab', 'list', '--workspace', workspace).tabs[0].tab_id;
  ctx.herdr.call('tab', 'rename', firstTab, 'dashboard');
  const gitTab = layout.createTab(ctx, workspace, 'git');
  const panes: Record<string, string> = { dashboard: root, git: gitTab.pane_id };
  const tabs: Record<string, string> = { dashboard: firstTab, git: gitTab.tab_id };
  const models = config.models;
  const worker = args.worker ?? models.worker_default ?? null;
  const modules = [...transitions.WORKFLOW_TYPES[workflowType]];
  const initialPhase = transitions.WORKFLOW_MODULES[modules[0]].entry;
  const initialRoles = transitions.WORKFLOW_MODULES[modules[0]].roles;
  const state: WorkflowState = {
    changeId: args.change,
    phase: initialPhase,
    repository: source,
    worktree,
    branch,
    workspace,
    task: args.task ?? null,
    ticketNumber: args.ticket ?? null,
    workerModel: worker,
    verificationRound: 0,
    returnWorkspace: process.env.HERDR_WORKSPACE_ID ?? null,
    baseBranch,
    baseCommit: base,
    developerApproval: false,
    panes,
    tabs,
    workflowModules: modules,
    workflowType,
    createdAt: ctx.clock.now().toISOString(),
    otelTraceRoot: tracing.childContext(tracing.parseTraceparent(process.env.TRACEPARENT)),
    otelTraceRootStartedUnixNano: String(ctx.clock.timeNs()),
  };
  stateMod.saveState(state);
  if (state.workflowType !== 'no-openspec') {
    const request = path.join(worktree, '.herdr-workflow', args.change!, 'request.md');
    const ticketLine = args.ticket ? `\n**Ticket:** ${args.ticket}\n` : '';
    const task = args.task ? args.task.trim() : '';
    fs.mkdirSync(path.dirname(request), { recursive: true });
    fs.writeFileSync(request, task ? `# ${args.change}\n${ticketLine}${task}\n` : `# ${args.change}\n${ticketLine}`);
    if (source !== worktree) {
      const sourceRequest = path.join(source, '.herdr-workflow', args.change!, 'request.md');
      fs.mkdirSync(path.dirname(sourceRequest), { recursive: true });
      fs.writeFileSync(sourceRequest, fs.readFileSync(request, 'utf8'));
    }
  }
  for (const checkout of new Set([source, worktree])) {
    let exclude = ctx.git.run(['rev-parse', '--git-path', 'info/exclude'], checkout);
    if (!path.isAbsolute(exclude)) exclude = path.join(checkout, exclude);
    fs.mkdirSync(path.dirname(exclude), { recursive: true });
    if (!fs.existsSync(exclude) || !fs.readFileSync(exclude, 'utf8').includes('.herdr-workflow/')) {
      fs.appendFileSync(exclude, '\n.herdr-workflow/\n');
    }
  }
  const dashboard = ['agentic-coding', 'dash', '--repo', worktree, '--change', args.change!].map(Bun.$.escape).join(' ');
  ctx.herdr.call('pane', 'run', panes.dashboard, dashboard);
  ctx.herdr.call('pane', 'run', panes.git, 'lazygit');
  for (const role of initialRoles) await roles.startRole(ctx, state, role);
  console.log(JSON.stringify(state, null, 2));
}

// ---------------------------------------------------------------------------
// plan quality / task completion gates
// ---------------------------------------------------------------------------

export async function cmdApply(ctx: Context, args: Args): Promise<void> {
  const state = stateMod.loadState(args.repo!, args.change!);
  if (state.phase !== 'proposed') throw new Error(`apply requires approved proposal, found phase ${state.phase}`);
  const baseStatus = git.baseStatus(ctx, state);
  state.planQuality = quality.planQuality(state);
  stateMod.saveState(state);
  if (!state.planQuality.passed) {
    telemetry.telemetry(ctx, state, 'plan_quality_rejected', { issue_count: state.planQuality.issues.length, spanStatus: 'ERROR' });
    telemetry.traceItems(ctx, state, 'plan_quality_issue', 'issue', state.planQuality.issues, { spanStatus: 'ERROR' });
    throw new Error(`plan quality gate failed: ${state.planQuality.issues.join('; ')}`);
  }
  telemetry.telemetry(ctx, state, 'plan_quality_passed', { tasks: state.planQuality.taskCount, specs: state.planQuality.specFiles });
  let prompt: string | undefined;
  if (baseStatus.moved) {
    const oldBase = state.baseCommit;
    state.baseCommit = baseStatus.current!;
    stateMod.saveState(state);
    telemetry.telemetry(ctx, state, 'apply_base_moved', { base: baseStatus.base, from: oldBase, to: baseStatus.current });
    prompt = `${git.rebaseInstruction(baseStatus, oldBase, 'implementing anything else')} ${prompts.rolePrompt('worker', state.changeId, state.verificationRound, state.workflowType, state.task)}`;
  }
  await roles.startRole(ctx, state, 'worker', prompt);
  telemetry.changePhase(ctx, state, 'apply');
  console.log('worker started');
}

// ---------------------------------------------------------------------------
// verification
// ---------------------------------------------------------------------------

export async function cmdVerify(ctx: Context, args: Args): Promise<void> {
  const state = stateMod.loadState(args.repo!, args.change!);
  if (state.workflowType !== 'no-openspec') quality.ensureTasksComplete(state);
  git.ensureBaseFresh(ctx, state);
  if (state.phase === 'verify') {
    console.log(`verification already running: round ${state.verificationRound}`);
    return;
  }
  if (!['apply', 'fix', 'paused'].includes(state.phase)) throw new Error(`verify invalid during phase ${state.phase}`);
  if (state.verificationRound >= ctx.config.workflow.max_verification_rounds) throw new Error('verification limit reached; reset explicitly before another round');
  const firstRound = state.verificationRound === 0;
  if (firstRound && state.panes?.planner) {
    try {
      ctx.herdr.call('pane', 'close', state.panes.planner);
    } catch {
      /* already gone */
    }
  }
  state.verificationRound += 1;
  telemetry.changePhase(ctx, state, 'verify', { reason: 'verification_requested' });
  state.testVerifierStarted = false;
  state.previousVerificationResults = state.verificationResults ?? {};
  state.verificationResults = {};
  state.verificationRoleStartedAt = {};
  delete state.verificationTimeoutRoles;
  const [tier] = reviews.getReviewTier(ctx, state);
  state.verificationTier = tier;
  state.verificationRoles = [];
  telemetry.changePhase(ctx, state, 'triage', { tier });
  reviews.writeTriageInput(ctx, state, tier);
  const triageInput = JSON.parse(fs.readFileSync(reviews.triageInputPath(state), 'utf8'));
  telemetry.telemetry(ctx, state, 'triage_started', { tier, changed_file_count: triageInput.allChangedFiles.length, suggested_role_count: triageInput.suggestedRoles.length });
  telemetry.traceItems(ctx, state, 'triage_role_suggested', 'role', triageInput.suggestedRoles);
  stateMod.saveState(state);
  await roles.startRole(ctx, state, 'triage');
  console.log(`triage started: round ${state.verificationRound} (${tier})`);
}

export async function cmdDispatchVerifiers(ctx: Context, args: Args): Promise<void> {
  const state = stateMod.loadState(args.repo!, args.change!);
  if (state.phase !== 'triage') throw new Error(`dispatch invalid during phase ${state.phase}`);
  const planPath = reviews.triagePlanPath(state);
  if (!fs.existsSync(planPath)) throw new Error(`missing triage plan: ${planPath}`);
  const plan: Record<string, any> = JSON.parse(fs.readFileSync(planPath, 'utf8')).roles ?? {};
  const triageInput = JSON.parse(fs.readFileSync(reviews.triageInputPath(state), 'utf8'));
  const changed = new Set<string>(triageInput.allChangedFiles);
  const available = new Set<string>(triageInput.availableRoles);
  if (typeof plan !== 'object' || !Object.keys(plan).every(role => available.has(role))) {
    throw new Error(`triage plan contains unavailable roles; choose from: ${[...available].sort().join(', ')}`);
  }
  for (const [role, entry] of Object.entries(plan)) {
    const filesOk = Array.isArray(entry?.files) && entry.files.length > 0 && entry.files.every((f: string) => changed.has(f));
    const hunksOk =
      !('hunks' in entry) ||
      (typeof entry.hunks === 'object' &&
        entry.hunks !== null &&
        Object.entries(entry.hunks).every(([p, ids]) => entry.files.includes(p) && Array.isArray(ids) && ids.every(id => Number.isInteger(id) && id >= 1 && id <= 8)));
    if (typeof entry !== 'object' || typeof entry?.reason !== 'string' || !filesOk || !hunksOk) throw new Error(`invalid triage plan entry: ${role}`);
  }
  state.verificationRoles = Object.keys(plan);
  const reusedResults: Record<string, unknown> = {};
  for (const [role, result] of Object.entries(triageInput.reusablePasses ?? {})) if (!(role in plan)) reusedResults[role] = result;
  state.verificationReusedResults = reusedResults;
  state.verificationStartedAt = ctx.clock.now().toISOString();

  if (!Object.keys(plan).length) {
    telemetry.changePhase(ctx, state, 'developer-review', { reason: 'no_verifiers_selected' });
    telemetry.telemetry(ctx, state, 'developer_review_ready', { tier: state.verificationTier, reused: Object.keys(triageInput.reusablePasses ?? {}).length, verifier_count: 0 });
    ctx.herdr.call('notification', 'show', 'Developer review ready', '--body', `${state.changeId} passed verification (nothing changed); approve archive in dashboard`, '--sound', 'done');
    console.log('verification passed: no verifiers needed');
    return;
  }

  telemetry.changePhase(ctx, state, 'verify', { tier: state.verificationTier });
  reviews.writeReviewContext(ctx, state, state.verificationTier, plan);
  telemetry.telemetry(ctx, state, 'triage_plan_selected', { tier: state.verificationTier, role_count: Object.keys(plan).length });
  for (const [role, entry] of Object.entries(plan)) {
    const hunks: Record<string, number[]> = entry.hunks ?? {};
    telemetry.telemetry(ctx, state, 'triage_role_selected', { role, reason: entry.reason, file_count: entry.files.length, hunk_count: Object.values(hunks).reduce((a, ids) => a + ids.length, 0) });
    for (const file of entry.files) telemetry.telemetry(ctx, state, 'triage_file_selected', { role, path: file, hunk_count: (hunks[file] ?? []).length });
    for (const [file, ids] of Object.entries(hunks)) telemetry.traceItems(ctx, state, 'triage_hunk_selected', 'hunk', ids, { role, path: file });
  }
  telemetry.telemetry(ctx, state, 'verification_started', { tier: state.verificationTier, role_count: Object.keys(plan).length });
  for (const role of Object.keys(plan)) {
    telemetry.telemetry(ctx, state, 'verifier_dispatched', { role });
    await roles.startRole(ctx, state, role);
  }
  console.log(`verification started: round ${state.verificationRound} (${state.verificationTier}, ${Object.keys(plan).length} selected verifiers)`);
}

export async function cmdVerificationResult(ctx: Context, args: Args): Promise<void> {
  const state = stateMod.loadState(args.repo!, args.change!);
  if (state.phase !== 'verify') {
    console.log(`verification result ignored: phase ${state.phase}`);
    return;
  }
  const rolesList: readonly string[] = state.verificationRoles ?? tiering.VERIFIER_ROLES;
  if (!rolesList.includes(args.role!) && args.role !== tiering.TEST_VERIFIER) throw new Error(`unknown verifier role: ${args.role}`);
  const [report, events] = reviews.reportEvents(state, args.role!);
  const verdictEvent = [...events].reverse().find(event => event.type === 'verdict');
  if (!verdictEvent || !['PASS', 'FAIL'].includes(verdictEvent.verdict ?? '')) throw new Error(`report must end with JSONL verdict PASS or FAIL: ${report}`);
  const verdict = verdictEvent.verdict!;
  const observedFindings = findings.consolidate({ [args.role!]: events }, [], new Set());
  state.verificationResults = { ...(state.verificationResults ?? {}), [args.role!]: { verdict, report } };
  stateMod.saveState(state);
  const started = state.verificationRoleStartedAt?.[args.role!];
  const duration = started ? (ctx.clock.now().getTime() - new Date(started).getTime()) / 1000 : null;
  const severityCounts: Record<string, number> = {};
  for (const severity of ['critical', 'warning', 'info']) severityCounts[`${severity}_count`] = observedFindings.filter(item => item.severity === severity).length;
  telemetry.telemetry(ctx, state, 'verifier_result', { role: args.role, verdict, duration_seconds: duration, model: state.verificationModels?.[args.role!], finding_count: observedFindings.length, ...severityCounts });
  telemetry.traceFindings(ctx, state, 'verification_finding_observed', observedFindings);

  // Deterministic completion check — a pure function of recorded results. No
  // verifier role doubles as coordinator; consolidation/transition happens in
  // reviews.failRound (any FAIL) or cmdFinishReview (all PASS).
  const dispatched: string[] = state.testVerifierStarted ? [...rolesList, tiering.TEST_VERIFIER] : [...rolesList];
  if (dispatched.every(role => state.verificationResults?.[role])) {
    const failed = dispatched.some(role => state.verificationResults?.[role]?.verdict === 'FAIL');
    if (failed) {
      await reviews.failRound(ctx, state, dispatched);
      return;
    }
    if (!state.testVerifierStarted) {
      state.testVerifierStarted = true;
      reviews.writeTestContext(ctx, state);
      stateMod.saveState(state);
      telemetry.telemetry(ctx, state, 'test_verifier_started', { selected_verifier_count: rolesList.length });
      await roles.startRole(ctx, state, tiering.TEST_VERIFIER);
      console.log('selected verifiers passed; test verifier started');
      return;
    }
    console.log('verification complete; run finish-review to consolidate');
    return;
  }
  console.log('verification result recorded; awaiting remaining verifiers');
}

export function cmdClose(ctx: Context, args: Args): void {
  const state = stateMod.loadState(args.repo!, args.change!);
  if (state.phase !== 'completed') throw new Error(`close requires completed phase, found ${state.phase}`);
  telemetry.changePhase(ctx, state, 'closed');
  telemetry.telemetry(ctx, state, 'workflow_closed');
  ctx.herdr.call('workspace', 'close', state.workspace);
  console.log('workspace closed; branch and checkout kept');
}

export function cmdOverridePhase(ctx: Context, args: Args): void {
  if (!(transitions.OPERATIONAL_PHASES as readonly string[]).includes(args.phase!)) throw new Error(`invalid override phase: ${args.phase}`);
  const state = stateMod.loadState(args.repo!, args.change!);
  if (state.phase === 'closed') throw new Error('cannot override closed workflow');
  const source = state.phase;
  telemetry.changePhase(ctx, state, args.phase!, { reason: 'manual_override' });
  telemetry.telemetry(ctx, state, 'workflow_phase_overridden', { source, target: args.phase });
  console.log(args.phase);
}

export function cmdPhase(ctx: Context, args: Args): void {
  const state = stateMod.loadState(args.repo!, args.change!);
  const allowed = transitions.allowedTransitions(state);
  if (args.phase === 'completed') git.ensureWorkflowBranch(ctx, state);
  if (!(allowed[state.phase]?.has(args.phase!))) throw new Error(`invalid transition: ${state.phase} -> ${args.phase}`);
  if (args.phase === 'proposed') {
    state.planQuality = quality.planQuality(state);
    stateMod.saveState(state);
    if (!state.planQuality.passed) {
      const issues = state.planQuality.issues.join('; ');
      telemetry.telemetry(ctx, state, 'plan_quality_rejected', { issue_count: state.planQuality.issues.length, spanStatus: 'ERROR' });
      telemetry.traceItems(ctx, state, 'plan_quality_issue', 'issue', state.planQuality.issues, { spanStatus: 'ERROR' });
      throw new Error(`PLAN_REJECTED: ${issues}. Fix every issue and rerun the proposed transition before ending.`);
    }
  }
  if (args.phase === 'fix' && state.verificationRound >= ctx.config.workflow.max_verification_rounds) args.phase = 'paused';
  telemetry.changePhase(ctx, state, args.phase!);
  if (args.phase === 'completed') telemetry.finalizeWorkspaceTrace(ctx, state);
  console.log(args.phase);
}

export function cmdMessage(ctx: Context, args: Args): void {
  const state = stateMod.loadState(args.repo!, args.change!);
  const pane = state.panes?.[args.target!];
  if (!pane) throw new Error(`unknown target: ${args.target}`);
  const directory = path.join(state.worktree, '.herdr-workflow', args.change!, 'messages');
  fs.mkdirSync(directory, { recursive: true });
  const stamp = ctx.clock.now().toISOString().replace(/[-:.]/g, '');
  const artifact = path.join(directory, `${stamp}-${args.sender}-to-${args.target}.md`);
  fs.writeFileSync(artifact, `# ${args.sender} → ${args.target}\n\n${args.text}\n`);
  roles.promptRole(ctx, state, args.target!, `Message from ${args.sender}: ${args.text} Full message: ${artifact}`);
  console.log(artifact);
}

export function cmdStatus(ctx: Context, args: Args): void {
  console.log(JSON.stringify(stateMod.loadState(args.repo!, args.change!), null, 2));
}

export function cmdProjects(ctx: Context): void {
  const config = ctx.config.projects;
  const root = path.resolve(String(config.root).replace(/^~/, os.homedir()));
  const maxDepth = Number(config.max_depth ?? 3);
  if (!fs.existsSync(root) || !fs.statSync(root).isDirectory()) throw new Error(`project discovery root not found: ${root}`);
  const projects: Array<{ name: string; path: string; openspec: boolean }> = [];
  const walk = (current: string, depth: number): void => {
    if ((fs.existsSync(path.join(current, '.git')))) {
      projects.push({ name: path.relative(root, current) || '.', path: current, openspec: fs.existsSync(path.join(current, 'openspec', 'config.yaml')) });
      return;
    }
    if (depth >= maxDepth) return;
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      if (!entry.isDirectory() || entry.name.startsWith('.') || ['node_modules', 'build', 'dist', 'target'].includes(entry.name)) continue;
      walk(path.join(current, entry.name), depth + 1);
    }
  };
  walk(root, 0);
  console.log(JSON.stringify(projects.sort((a, b) => a.name.toLowerCase().localeCompare(b.name.toLowerCase()))));
}

export function cmdConfig(ctx: Context): void {
  console.log(JSON.stringify(ctx.config));
}

export function cmdSetReturn(ctx: Context, args: Args): void {
  const state = stateMod.loadState(args.repo!, args.change!);
  state.returnWorkspace = args.workspace;
  stateMod.saveState(state);
  console.log(JSON.stringify(state, null, 2));
}
