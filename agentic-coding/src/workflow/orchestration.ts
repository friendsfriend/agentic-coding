// cmd_* orchestration: wires pure logic (transitions/tiering/findings/tracing/gates)
// to effects (herdr/git/clock/exporter) via the Context. Git, terminal layout,
// telemetry, and plugin concerns live in their own modules (git.ts, layout.ts,
// telemetry.ts, plugins.ts) — this module only sequences phase flow.
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { Context } from './effects.ts';
import * as findings from './findings.ts';
import * as gates from './gates.ts';
import * as git from './git.ts';
import * as layout from './layout.ts';
import * as naming from './naming.ts';
import * as paths from './paths.ts';
import * as prompts from './prompts.ts';
import * as stateMod from './state.ts';
import type { WorkflowState } from './state.ts';
import * as telemetry from './telemetry.ts';
import * as tiering from './tiering.ts';
import * as tracing from './tracing.ts';
import * as transitions from './transitions.ts';

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

// ---------------------------------------------------------------------------
// role lifecycle: launch, prompt, start
// ---------------------------------------------------------------------------

function providerUnhealthy(ctx: Context, model: string): boolean {
  const p = path.join(paths.AGENT_DIR, 'herdr-provider-health.json');
  if (!fs.existsSync(p)) return false;
  try {
    const health = JSON.parse(fs.readFileSync(p, 'utf8'))[model.split('/', 1)[0]] ?? {};
    const last = new Date(health.lastFailure ?? '1970-01-01T00:00:00+00:00');
    return (health.failures ?? 0) >= 3 && (ctx.clock.now().getTime() - last.getTime()) / 1000 < 120;
  } catch {
    return false;
  }
}

export function roleAgentName(state: WorkflowState, role: string): string {
  return naming.agentName(state.changeId, role);
}

export async function launchRole(ctx: Context, state: WorkflowState, role: string, text?: string): Promise<void> {
  const config = ctx.config;
  const models = config.models;
  const thinking = config.thinking;
  let model = role === 'worker'
    ? state.workerModel
    : role.endsWith('-verifier')
      ? (models[role.replace(/-/g, '_')] ?? models.verifier)
      : (models[role] ?? models.archive ?? models.verifier);
  const level = role === 'worker'
    ? thinking.worker_default
    : role.endsWith('-verifier')
      ? (state.verificationTier === 'lite' ? thinking.verifier_lite : thinking.verifier)
      : (thinking[role] ?? thinking.archive ?? thinking.verifier);
  if (role.endsWith('-verifier') && providerUnhealthy(ctx, model) && models.verifier_fallback) {
    telemetry.telemetry(ctx, state, 'provider_circuit_open', { role, model, fallback: models.verifier_fallback });
    model = models.verifier_fallback;
  }
  const change = state.changeId;

  const spawn = async (spawnModel: string): Promise<void> => {
    layout.closeOldPane(ctx, state, role);
    const label = layout.launchLabel(role);
    const instructions = text ?? prompts.rolePrompt(role, change, state.verificationRound, state.workflowType, state.task);
    const placement = layout.placeLaunchPane(ctx, state, role, state.workspace, state.worktree, change);
    const { targetTab, launchPane, createdTab, usedSpare, createdSparePane } = placement;

    ctx.herdr.call('pane', 'rename', launchPane, role);
    await layout.waitForPaneReady(ctx, launchPane);
    telemetry.writeTraceHandoff(ctx, state, role);
    const command = [
      'agent', 'start', roleAgentName(state, role), '--kind', 'pi', '--pane', launchPane,
      '--', ...prompts.piArguments(role, spawnModel, level, change, config), `/skill:herdr-openspec-${role} ${instructions}`,
    ];

    const cleanup = (): void => {
      if (createdTab) ctx.herdr.call('tab', 'close', targetTab);
      else if (!usedSpare) ctx.herdr.call('pane', 'close', launchPane);
      if (createdSparePane) ctx.herdr.call('pane', 'close', createdSparePane);
    };

    let agent: any;
    try {
      agent = ctx.herdr.call(...command).agent;
    } catch (error) {
      if (!String((error as Error).message).includes('not an available shell')) {
        cleanup();
        throw error;
      }
      await ctx.clock.sleep(0.25);
      try {
        agent = ctx.herdr.call(...command).agent;
      } catch (retryError) {
        cleanup();
        throw retryError;
      }
    }
    const paneId = agent.pane_id;
    const tabId = agent.tab_id ?? targetTab;
    ctx.herdr.call('tab', 'rename', tabId, label);
    state.panes = { ...(state.panes ?? {}), [role]: paneId };
    state.tabs = { ...(state.tabs ?? {}), [role]: tabId };
    layout.recordVerificationPlacement(state, role, placement, tabId);
    stateMod.saveState(state);
  };

  try {
    await spawn(model);
  } catch (error) {
    const fallback = role.endsWith('-verifier') ? models.verifier_fallback : undefined;
    if (!fallback || fallback === model) throw error;
    telemetry.telemetry(ctx, state, 'provider_launch_fallback', { role, model, fallback });
    await spawn(fallback);
    model = fallback;
  }

  state.verificationModels = { ...(state.verificationModels ?? {}), [role]: model };
  if (role.endsWith('-verifier')) {
    state.verificationRoleStartedAt = { ...(state.verificationRoleStartedAt ?? {}), [role]: ctx.clock.now().toISOString() };
  }
  stateMod.saveState(state);
}

/** Submit a follow-up to the live Pi agent, keeping its session and prior-round context. */
export function promptRole(ctx: Context, state: WorkflowState, role: string, text?: string): void {
  if (!(role in (state.panes ?? {}))) throw new Error(`no pane for role ${role} in promptRole`);
  const instructions = text ?? prompts.rolePrompt(role, state.changeId, state.verificationRound, state.workflowType, state.task);
  telemetry.writeTraceHandoff(ctx, state, role);
  ctx.herdr.call('agent', 'prompt', state.panes[role], instructions);
}

export async function startRole(ctx: Context, state: WorkflowState, role: string, text?: string): Promise<void> {
  const verificationTab = (state.tabs ?? {}).verification;
  if (layout.VERIFICATION_TAB_ROLES.includes(role) && (!verificationTab || (state.tabs ?? {})[role] !== verificationTab)) {
    await launchRole(ctx, state, role, text);
    return;
  }
  if (layout.hasRolePane(state, role)) {
    let agent: any;
    try {
      agent = ctx.herdr.call('agent', 'get', state.panes[role]).agent;
    } catch {
      await launchRole(ctx, state, role, text);
      return;
    }
    if (agent?.pane_id === state.panes[role] && ['idle', 'working', 'blocked', 'done'].includes(agent.agent_status)) {
      if (agent.tab_id && (state.tabs ?? {})[role] !== agent.tab_id) {
        state.tabs = { ...(state.tabs ?? {}), [role]: agent.tab_id };
        stateMod.saveState(state);
      }
      promptRole(ctx, state, role, text);
      return;
    }
  }
  await launchRole(ctx, state, role, text);
}

export async function cmdPlanner(ctx: Context, args: Args): Promise<void> {
  const state = stateMod.loadState(args.repo!, args.change!);
  if (state.phase !== 'explore') throw new Error(`planner restart invalid during phase ${state.phase}`);
  await startRole(ctx, state, 'planner');
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
  const worker = args.worker ?? models.worker_default;
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
  const dashboard = ['agent-dash', '--repo', worktree, '--change', args.change!].map(Bun.$.escape).join(' ');
  ctx.herdr.call('pane', 'run', panes.dashboard, dashboard);
  ctx.herdr.call('pane', 'run', panes.git, 'lazygit');
  for (const role of initialRoles) await startRole(ctx, state, role);
  console.log(JSON.stringify(state, null, 2));
}

// ---------------------------------------------------------------------------
// plan quality / task completion gates
// ---------------------------------------------------------------------------

export function planQuality(state: WorkflowState): gates.PlanQualityResult & { specFiles: number; taskCount: number } {
  const root = path.join(state.worktree, 'openspec', 'changes', state.changeId);
  const required: Record<string, string> = { proposal: path.join(root, 'proposal.md'), design: path.join(root, 'design.md'), tasks: path.join(root, 'tasks.md') };
  const missing = Object.keys(required).filter(name => !fs.existsSync(required[name]) || !fs.readFileSync(required[name], 'utf8').trim());
  const specsDir = path.join(root, 'specs');
  const specs = fs.existsSync(specsDir) ? findMarkdownFiles(specsDir) : [];
  const taskCount = !missing.includes('tasks') ? gates.countTasks(fs.readFileSync(required.tasks, 'utf8')) : 0;
  const result = gates.evaluatePlanQuality(missing, specs.length > 0, taskCount);
  return { ...result, specFiles: specs.length, taskCount };
}

function findMarkdownFiles(dir: string): string[] {
  const found: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) found.push(...findMarkdownFiles(full));
    else if (entry.name.endsWith('.md')) found.push(full);
  }
  return found;
}

export function ensureTasksComplete(state: WorkflowState): void {
  const p = path.join(state.worktree, 'openspec', 'changes', state.changeId, 'tasks.md');
  if (!fs.existsSync(p) || !fs.statSync(p).isFile()) throw new Error(`missing OpenSpec tasks: ${p}`);
  const { tasks, incomplete } = gates.incompleteTasks(fs.readFileSync(p, 'utf8'));
  if (!tasks.length) throw new Error(`no OpenSpec tasks found: ${p}`);
  if (incomplete.length) {
    throw new Error(`verification requires completed OpenSpec tasks; ${incomplete.length} remain in ${p}. Mark each implemented task [x] after focused validation.`);
  }
}

export async function cmdApply(ctx: Context, args: Args): Promise<void> {
  const state = stateMod.loadState(args.repo!, args.change!);
  if (state.phase !== 'proposed') throw new Error(`apply requires approved proposal, found phase ${state.phase}`);
  const baseStatus = git.baseStatus(ctx, state);
  state.planQuality = planQuality(state);
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
  await startRole(ctx, state, 'worker', prompt);
  telemetry.changePhase(ctx, state, 'apply');
  console.log('worker started');
}

// ---------------------------------------------------------------------------
// verification: triage input, review context, findings consolidation
// ---------------------------------------------------------------------------

function getReviewTier(ctx: Context, state: WorkflowState): [string, readonly string[]] {
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

function writeTriageInput(ctx: Context, state: WorkflowState, tier: string): void {
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
  if (state.workflowType !== 'no-openspec') checks.openSpec = planQuality(state);
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

function writeReviewContext(ctx: Context, state: WorkflowState, tier: string, plan: Record<string, any>): void {
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

function writeTestContext(ctx: Context, state: WorkflowState): void {
  const root = state.worktree;
  const triageInput = JSON.parse(fs.readFileSync(triageInputPath(state), 'utf8'));
  const files: string[] = triageInput.allChangedFiles;
  const tests = files.filter(p => p.includes('/test/') || p.includes('/tests/') || p.startsWith('test/'));
  const results: Record<string, unknown> = {};
  for (const [role, result] of Object.entries(state.verificationResults ?? {})) {
    if (role !== 'coordinator') results[role] = (result as any).verdict;
  }
  const p = path.join(stateMod.workflowDir(state), 'reviews', `round-${state.verificationRound}-${tiering.TEST_VERIFIER}-context.md`);
  fs.writeFileSync(
    p,
    `# Test verification context\n\nRun the repository's full configured test suite without filters. Review regression coverage only for scoped changed behavior.\n\n## Changed files\n${files.join('\n')}\n\n## Changed test files\n${tests.join('\n') || '(none)'}\n\n## Selected verifier verdicts\n\`\`\`json\n${JSON.stringify(results)}\n\`\`\`\n\n## Scoped diff (max 12000 chars)\n\`\`\`diff\n${scopedDiff(ctx, root, files)}\n\`\`\`\n`,
  );
}

export function reportPath(state: WorkflowState, role: string): string {
  return path.join(stateMod.workflowDir(state), 'reviews', `round-${state.verificationRound}-${role}.findings.jsonl`);
}

function reportEvents(state: WorkflowState, role: string): [string, findings.FindingEvent[]] {
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

function consolidateFindings(ctx: Context, state: WorkflowState, roles: readonly string[]): string {
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
    lines.push(...(grouped.length ? grouped.map(item => `- [${item.severity}] ${item.id} | ${item.path} | ${item.detail} | fix: ${item.fix || 'resolve finding'}`) : ['- FAIL verdict reported without findings']));
  }
  lines.push('', '## Files', ...(files.length ? files.map(file => `- ${file}`) : ['- none']));
  lines.push('', '## Focused validation', ...(tests.length ? tests.map(test => `- ${test}`) : ['- nearest existing regression test for changed behavior']));
  fs.writeFileSync(p, lines.join('\n') + '\n');
  return p;
}

async function failVerification(ctx: Context, state: WorkflowState): Promise<void> {
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
  await startRole(ctx, state, 'worker', `Verification failed. Read only ${workerContext}. Fix every blocker, run its focused validation, then run herdr-workflow verify --repo . --change ${state.changeId}. Do not report completion until that command succeeds.`);
  console.log('verification failed; worker notified to fix and restart verification');
}

export async function cmdVerify(ctx: Context, args: Args): Promise<void> {
  const state = stateMod.loadState(args.repo!, args.change!);
  if (state.workflowType !== 'no-openspec') ensureTasksComplete(state);
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
  const [tier] = getReviewTier(ctx, state);
  state.verificationTier = tier;
  state.verificationRoles = [];
  telemetry.changePhase(ctx, state, 'triage', { tier });
  writeTriageInput(ctx, state, tier);
  const triageInput = JSON.parse(fs.readFileSync(triageInputPath(state), 'utf8'));
  telemetry.telemetry(ctx, state, 'triage_started', { tier, changed_file_count: triageInput.allChangedFiles.length, suggested_role_count: triageInput.suggestedRoles.length });
  telemetry.traceItems(ctx, state, 'triage_role_suggested', 'role', triageInput.suggestedRoles);
  stateMod.saveState(state);
  await startRole(ctx, state, 'triage');
  console.log(`triage started: round ${state.verificationRound} (${tier})`);
}

export async function cmdDispatchVerifiers(ctx: Context, args: Args): Promise<void> {
  const state = stateMod.loadState(args.repo!, args.change!);
  if (state.phase !== 'triage') throw new Error(`dispatch invalid during phase ${state.phase}`);
  const planPath = triagePlanPath(state);
  if (!fs.existsSync(planPath)) throw new Error(`missing triage plan: ${planPath}`);
  const plan: Record<string, any> = JSON.parse(fs.readFileSync(planPath, 'utf8')).roles ?? {};
  const triageInput = JSON.parse(fs.readFileSync(triageInputPath(state), 'utf8'));
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
  writeReviewContext(ctx, state, state.verificationTier, plan);
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
    await startRole(ctx, state, role);
  }
  console.log(`verification started: round ${state.verificationRound} (${state.verificationTier}, ${Object.keys(plan).length} selected verifiers)`);
}

export async function cmdVerificationResult(ctx: Context, args: Args): Promise<void> {
  const state = stateMod.loadState(args.repo!, args.change!);
  if (state.phase !== 'verify') {
    console.log(`verification result ignored: phase ${state.phase}`);
    return;
  }
  const roles: readonly string[] = state.verificationRoles ?? tiering.VERIFIER_ROLES;
  if (!roles.includes(args.role!) && args.role !== tiering.TEST_VERIFIER) throw new Error(`unknown verifier role: ${args.role}`);
  const [report, events] = reportEvents(state, args.role!);
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

  if (args.role === tiering.TEST_VERIFIER) {
    const consolidated = consolidateFindings(ctx, state, [...roles, tiering.TEST_VERIFIER]);
    telemetry.traceFindings(ctx, state, 'verification_finding', currentFindings(state, ctx));
    state.verificationResults.coordinator = { verdict, report: consolidated };
    stateMod.saveState(state);
    if (verdict === 'FAIL') {
      await failVerification(ctx, state);
      return;
    }
    telemetry.changePhase(ctx, state, 'developer-review', { reason: 'verification_passed' });
    telemetry.telemetry(ctx, state, 'developer_review_ready', { tier: state.verificationTier, verifier_count: roles.length, reused: Object.keys(state.verificationReusedResults ?? {}).length });
    ctx.herdr.call('notification', 'show', 'Developer review ready', '--body', `${state.changeId} passed verification; approve archive in dashboard`, '--sound', 'done');
    console.log('verification passed');
    return;
  }
  const results = state.verificationResults;
  if (roles.every(role => role in results)) {
    const failed = roles.some(role => results[role].verdict === 'FAIL');
    const consolidated = consolidateFindings(ctx, state, failed ? roles : [...roles, tiering.TEST_VERIFIER]);
    if (failed) {
      telemetry.traceFindings(ctx, state, 'verification_finding', currentFindings(state, ctx));
      results.coordinator = { verdict: 'FAIL', report: consolidated };
      stateMod.saveState(state);
      await failVerification(ctx, state);
      return;
    }
    if (!state.testVerifierStarted) {
      state.testVerifierStarted = true;
      results.coordinator = { verdict: 'PENDING', report: consolidated };
      writeTestContext(ctx, state);
      stateMod.saveState(state);
      telemetry.telemetry(ctx, state, 'test_verifier_started', { selected_verifier_count: roles.length });
      await startRole(ctx, state, tiering.TEST_VERIFIER);
      console.log('selected verifiers passed; test verifier started');
      return;
    }
  }
  console.log('verification result recorded; awaiting parallel verifiers');
}

export function cmdClose(ctx: Context, args: Args): void {
  const state = stateMod.loadState(args.repo!, args.change!);
  if (state.phase !== 'completed') throw new Error(`close requires completed phase, found ${state.phase}`);
  telemetry.changePhase(ctx, state, 'closed');
  telemetry.telemetry(ctx, state, 'workflow_closed');
  ctx.herdr.call('workspace', 'close', state.workspace);
  console.log('workspace closed; branch and checkout kept');
}

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
  await launchRole(ctx, state, 'archive');
  state.developerApproval = true;
  telemetry.changePhase(ctx, state, 'archive', { reason: 'developer_approved' });
  telemetry.telemetry(ctx, state, 'archive_started');
}

function completeGitOperations(ctx: Context, state: WorkflowState, commit?: string, pushed?: boolean): void {
  git.ensureWorkflowBranch(ctx, state);
  const dirty = ctx.git.run(['status', '--porcelain'], state.worktree);
  if (dirty) throw new Error('working tree is dirty after git operations; commit or clean first');
  for (const role of ['git', 'archive']) {
    const pane = state.panes?.[role];
    if (pane) {
      try {
        ctx.herdr.call('pane', 'close', pane);
      } catch {
        /* already gone */
      }
    }
  }
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
async function approveDeveloperReview(ctx: Context, state: WorkflowState): Promise<string> {
  telemetry.telemetry(ctx, state, 'developer_review_approved', { workflow_type: state.workflowType });
  if (hasOpenspecChange(state)) {
    ensureTasksComplete(state);
    await startArchive(ctx, state);
    return 'archive started';
  }
  closeCompletedRolePanes(ctx, state);
  state.developerApproval = true;
  startGitOperations(ctx, state);
  return 'git operations started';
}

export async function cmdFinishReview(ctx: Context, args: Args): Promise<void> {
  const state = stateMod.loadState(args.repo!, args.change!);
  if (state.phase !== 'developer-review') throw new Error(`finish-review requires developer-review phase, found ${state.phase}`);
  const reviewDir = path.join(stateMod.workflowDir(state), 'reviews');
  const reviewPath = path.join(reviewDir, 'developer-review.json');
  let payload: any;
  try {
    payload = fs.existsSync(reviewPath) ? JSON.parse(fs.readFileSync(reviewPath, 'utf8')) : { comments: [] };
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
    console.log(await approveDeveloperReview(ctx, state));
    return;
  }

  const contextPath = path.join(reviewDir, 'developer-review-context.md');
  fs.writeFileSync(contextPath, '# Developer review comments\n\n' + comments.map((comment: any) => `- \`${commentLocation(comment)}\`: ${String(comment.body).trim()}`).join('\n') + '\n');
  state.developerReviewComments = comments;
  state.developerApproval = false;
  telemetry.changePhase(ctx, state, 'apply', { reason: 'developer_review_comments' });
  telemetry.telemetry(ctx, state, 'developer_review_comments_received', { count: comments.length, report: contextPath });
  const prompt = `Developer review found comments. Read only ${contextPath}. Address every comment, run focused validation, then run \`herdr-workflow verify --repo . --change ${state.changeId}\`. Do not report completion until verification starts.`;
  await startRole(ctx, state, 'worker', prompt);
  console.log('developer review findings sent to worker');
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
    state.planQuality = planQuality(state);
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
  promptRole(ctx, state, args.target!, `Message from ${args.sender}: ${args.text} Full message: ${artifact}`);
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
