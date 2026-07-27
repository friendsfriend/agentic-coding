import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import type { Context } from '../src/workflow/effects.ts';
import * as orchestration from '../src/workflow/orchestration.ts';
import * as prompts from '../src/workflow/prompts.ts';
import * as stateMod from '../src/workflow/state.ts';
import { DEFAULT_CONFIG, FakeClock, FakeGit, FakeHerdr, initRepo, makeContext } from './fakes.ts';

class FailFirstPushGit extends FakeGit {
  private failPush = true;
  override run(args: string[], cwd: string): string {
    if (args[0] === 'push' && this.failPush) {
      this.failPush = false;
      throw new Error('push failed');
    }
    return super.run(args, cwd);
  }
}

class MoveBaseAfterPushGit extends FakeGit {
  override run(args: string[], cwd: string): string {
    const result = super.run(args, cwd);
    if (args[0] === 'push') {
      super.run(['branch', '-f', 'main', 'HEAD'], cwd);
      super.run(['push', 'origin', 'main'], cwd);
    }
    return result;
  }
}

class FailFirstPushExceptionGit extends FakeGit {
  private failPush = true;
  override run(args: string[], cwd: string): string {
    if (args[0] === 'push' && this.failPush) {
      this.failPush = false;
      const error = new Error('push failed');
      (error as any).isOSError = true;
      throw error;
    }
    return super.run(args, cwd);
  }
}

class CommittingPushGit extends FakeGit {
  phases: string[] = [];
  constructor(private repo: string) {
    super();
  }
  override run(args: string[], cwd: string): string {
    if (args[0] === 'push') this.phases.push(stateMod.loadState(this.repo, 'my-change').phase);
    return super.run(args, cwd);
  }
}

let tmp: string;
let repo: string;
let origin: string;
let herdr: FakeHerdr;
let clock: FakeClock;
let ctx: Context;

function makeState(phase: string, overrides: Record<string, unknown> = {}): stateMod.WorkflowState {
  const state: stateMod.WorkflowState = {
    changeId: 'my-change',
    phase,
    repository: repo,
    worktree: repo,
    branch: 'feature/my-change',
    workspace: 'ws-1',
    task: 'do the thing',
    ticketNumber: null,
    workerModel: 'test/worker',
    verificationRound: 0,
    returnWorkspace: null,
    baseBranch: 'origin/main',
    baseCommit: ctx.git.run(['rev-parse', 'HEAD'], repo),
    developerApproval: false,
    panes: { dashboard: 'pane-dash', git: 'pane-git' },
    tabs: { dashboard: 'tab-dash', git: 'tab-git' },
    workflowModules: null,
    workflowType: overrides.workflowType ?? 'standard',
    createdAt: clock.now().toISOString(),
  };
  Object.assign(state, overrides);
  stateMod.saveState(state);
  return state;
}

function writeChangeArtifacts(complete = true, taskMarks: string[] = ['x']) {
  const root = path.join(repo, 'openspec', 'changes', 'my-change');
  fs.mkdirSync(path.join(root, 'specs'), { recursive: true });
  fs.writeFileSync(path.join(root, 'proposal.md'), '# Proposal\nDo the thing.\n');
  fs.writeFileSync(path.join(root, 'design.md'), '# Design\nHow.\n');
  const tasks = taskMarks.map((mark, i) => `- [${mark}] task ${i}`).join('\n');
  fs.writeFileSync(path.join(root, 'tasks.md'), complete ? tasks + '\n' : '');
  fs.writeFileSync(path.join(root, 'specs', 'delta.md'), '## ADDED Requirements\n### Requirement: X\n');
}

/** Modify an already-tracked file so `git diff HEAD` picks it up (untracked new
 * files are invisible to `git diff` unless staged). */
function dirtyFile(name = 'README.md', content = '# test\nchanged\n') {
  const p = path.join(repo, name);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, content);
}

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'workflow-phases-'));
  repo = initRepo(path.join(tmp, 'repo'));
  herdr = new FakeHerdr();
  clock = new FakeClock();
  ctx = makeContext({ herdr, clock });
  origin = path.join(tmp, 'origin.git');
  execFileSync('git', ['init', '--bare', '-q', '-b', 'main', origin]);
  ctx.git.run(['remote', 'add', 'origin', origin], repo);
  ctx.git.run(['push', '-q', 'origin', 'main'], repo);
  ctx.git.run(['checkout', '-b', 'feature/my-change'], repo);
});

afterEach(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
});

describe('cmdPlanner', () => {
  test('starts planner agent', async () => {
    makeState('explore');
    await orchestration.cmdPlanner(ctx, { repo, change: 'my-change' });
    const state = stateMod.loadState(repo, 'my-change');
    expect(state.panes.planner).toBeDefined();
    const launches = herdr.calls.filter(call => call[0] === 'agent' && call[1] === 'start' && call.at(-1)?.includes('/skill:herdr-openspec-planner'));
    expect(launches.length).toBe(1);
  });

  test('rejects wrong phase', async () => {
    makeState('apply');
    await expect(orchestration.cmdPlanner(ctx, { repo, change: 'my-change' })).rejects.toThrow();
  });
});

describe('cmdApply', () => {
  test('passes quality gate and starts worker', async () => {
    makeState('proposed');
    writeChangeArtifacts(true);
    await orchestration.cmdApply(ctx, { repo, change: 'my-change' });
    const state = stateMod.loadState(repo, 'my-change');
    expect(state.phase).toBe('apply');
    expect(state.planQuality.passed).toBe(true);
    expect(state.panes.worker).toBeDefined();
    const traces = fs
      .readFileSync(path.join(stateMod.workflowDir(state), 'traces.jsonl'), 'utf8')
      .trim()
      .split('\n')
      .map(line => JSON.parse(line));
    const phaseChange = traces.find(t => t.name === 'workflow.phase_changed');
    expect(phaseChange.attributes['herdr.source']).toBe('proposed');
    expect(phaseChange.attributes['herdr.target']).toBe('apply');
  });

  test('fails quality gate without tasks', async () => {
    makeState('proposed');
    writeChangeArtifacts(false);
    await expect(orchestration.cmdApply(ctx, { repo, change: 'my-change' })).rejects.toThrow(/plan quality gate failed/);
    const state = stateMod.loadState(repo, 'my-change');
    expect(state.phase).toBe('proposed'); // unchanged
    expect(state.planQuality.passed).toBe(false);
  });

  test('rejects wrong phase', async () => {
    makeState('apply');
    await expect(orchestration.cmdApply(ctx, { repo, change: 'my-change' })).rejects.toThrow();
  });
});

describe('cmdPhase', () => {
  test('explore to proposed with complete plan', () => {
    makeState('explore');
    writeChangeArtifacts(true);
    orchestration.cmdPhase(ctx, { repo, change: 'my-change', phase: 'proposed' });
    const state = stateMod.loadState(repo, 'my-change');
    expect(state.phase).toBe('proposed');
  });

  test('plan rejected when incomplete', () => {
    makeState('explore');
    writeChangeArtifacts(false);
    expect(() => orchestration.cmdPhase(ctx, { repo, change: 'my-change', phase: 'proposed' })).toThrow(/^PLAN_REJECTED:/);
    const state = stateMod.loadState(repo, 'my-change');
    const traces = fs
      .readFileSync(path.join(stateMod.workflowDir(state), 'traces.jsonl'), 'utf8')
      .trim()
      .split('\n')
      .map(line => JSON.parse(line));
    expect(state.phase).toBe('explore'); // unchanged
    expect(traces.find(t => t.name === 'workflow.plan_quality_rejected').attributes['herdr.span_status']).toBe('ERROR');
    expect(traces.find(t => t.name === 'workflow.plan_quality_issue').attributes['herdr.span_status']).toBe('ERROR');
  });

  test('invalid transition rejected', () => {
    makeState('explore');
    expect(() => orchestration.cmdPhase(ctx, { repo, change: 'my-change', phase: 'apply' })).toThrow(/invalid transition/);
  });
});

describe('cmdOverridePhase', () => {
  test('overrides to any operational phase', () => {
    makeState('apply');
    orchestration.cmdOverridePhase(ctx, { repo, change: 'my-change', phase: 'paused' });
    expect(stateMod.loadState(repo, 'my-change').phase).toBe('paused');
  });

  test('rejects unknown phase', () => {
    makeState('apply');
    expect(() => orchestration.cmdOverridePhase(ctx, { repo, change: 'my-change', phase: 'not-a-phase' })).toThrow();
  });

  test('rejects override of closed', () => {
    makeState('closed');
    expect(() => orchestration.cmdOverridePhase(ctx, { repo, change: 'my-change', phase: 'apply' })).toThrow();
  });
});

describe('cmdVerify', () => {
  test('starts triage round', async () => {
    makeState('apply', { verificationRound: 0, panes: { dashboard: 'pane-dash', git: 'pane-git' } });
    writeChangeArtifacts(true, ['x']);
    dirtyFile();
    await orchestration.cmdVerify(ctx, { repo, change: 'my-change' });
    const state = stateMod.loadState(repo, 'my-change');
    expect(state.phase).toBe('triage');
    expect(state.verificationRound).toBe(1);
    expect(['lite', 'full', 'trivial']).toContain(state.verificationTier);
    expect(state.panes.triage).toBeDefined();
    expect(fs.existsSync(orchestration.triageInputPath(state))).toBe(true);
    const traces = fs
      .readFileSync(path.join(stateMod.workflowDir(state), 'traces.jsonl'), 'utf8')
      .trim()
      .split('\n')
      .map(line => JSON.parse(line));
    expect(traces.some(t => t.name === 'workflow.triage_started')).toBe(true);
  });

  test('no-openspec workflow skips tasks and openspec review', async () => {
    makeState('apply', { verificationRound: 0, workflowType: 'no-openspec' });
    dirtyFile();
    await orchestration.cmdVerify(ctx, { repo, change: 'my-change' });
    const state = stateMod.loadState(repo, 'my-change');
    const triageInput = JSON.parse(fs.readFileSync(orchestration.triageInputPath(state), 'utf8'));
    expect(state.phase).toBe('triage');
    expect(triageInput.availableRoles).not.toContain('openspec-verifier');
    expect(triageInput.suggestedRoles).not.toContain('openspec-verifier');
    expect(triageInput.deterministicChecks.openSpec).toBeUndefined();
  });

  test('rejects incomplete tasks', async () => {
    makeState('apply', { verificationRound: 0 });
    writeChangeArtifacts(true, [' ']);
    dirtyFile();
    await expect(orchestration.cmdVerify(ctx, { repo, change: 'my-change' })).rejects.toThrow();
  });

  test('already verifying is a noop', async () => {
    makeState('verify', { verificationRound: 1 });
    writeChangeArtifacts(true);
    await orchestration.cmdVerify(ctx, { repo, change: 'my-change' });
    const state = stateMod.loadState(repo, 'my-change');
    expect(state.phase).toBe('verify');
    expect(state.verificationRound).toBe(1);
  });

  test('rejects wrong phase', async () => {
    makeState('explore');
    await expect(orchestration.cmdVerify(ctx, { repo, change: 'my-change' })).rejects.toThrow();
  });

  test('rejects round limit reached', async () => {
    makeState('apply', { verificationRound: ctx.config.workflow.max_verification_rounds });
    await expect(orchestration.cmdVerify(ctx, { repo, change: 'my-change' })).rejects.toThrow();
  });
});

async function prepareTriage(workflowType = 'standard') {
  makeState('apply', { verificationRound: 0, workflowType });
  if (workflowType !== 'no-openspec') writeChangeArtifacts(true);
  dirtyFile();
  await orchestration.cmdVerify(ctx, { repo, change: 'my-change' });
  return stateMod.loadState(repo, 'my-change');
}

describe('cmdDispatchVerifiers', () => {
  test('dispatches selected verifiers', async () => {
    const state = await prepareTriage();
    const triageInput = JSON.parse(fs.readFileSync(orchestration.triageInputPath(state), 'utf8'));
    const files = triageInput.allChangedFiles;
    const plan = { roles: { 'quality-verifier': { reason: 'code change', files } } };
    fs.writeFileSync(orchestration.triagePlanPath(state), JSON.stringify(plan));
    await orchestration.cmdDispatchVerifiers(ctx, { repo, change: 'my-change' });
    const after = stateMod.loadState(repo, 'my-change');
    const traces = fs
      .readFileSync(path.join(stateMod.workflowDir(after), 'traces.jsonl'), 'utf8')
      .trim()
      .split('\n')
      .map(line => JSON.parse(line));
    expect(after.phase).toBe('verify');
    expect(after.panes['quality-verifier']).toBeDefined();
    expect(traces.some(t => t.name === 'workflow.triage_role_selected')).toBe(true);
    expect(traces.some(t => t.name === 'workflow.verifier_dispatched')).toBe(true);
  });

  test('UI file suggests and dispatches usability verifier', async () => {
    makeState('apply', { verificationRound: 0 });
    writeChangeArtifacts(true);
    dirtyFile('ui/Button.tsx', 'export const Button = () => <button>Save</button>;\n');
    ctx.git.run(['add', 'ui/Button.tsx'], repo);
    await orchestration.cmdVerify(ctx, { repo, change: 'my-change' });
    let state = stateMod.loadState(repo, 'my-change');
    const triageInput = JSON.parse(fs.readFileSync(orchestration.triageInputPath(state), 'utf8'));
    expect(triageInput.suggestedRoles).toContain('usability-verifier');
    fs.writeFileSync(orchestration.triagePlanPath(state), JSON.stringify({ roles: { 'usability-verifier': { reason: 'UI change', files: ['ui/Button.tsx'] } } }));
    await orchestration.cmdDispatchVerifiers(ctx, { repo, change: 'my-change' });
    state = stateMod.loadState(repo, 'my-change');
    expect(state.phase).toBe('verify');
    expect(state.panes['usability-verifier']).toBeDefined();
    expect(state.verificationModels['usability-verifier']).toBe('test/usability');
  });

  test('empty plan goes straight to developer review', async () => {
    const state = await prepareTriage();
    fs.writeFileSync(orchestration.triagePlanPath(state), JSON.stringify({ roles: {} }));
    await orchestration.cmdDispatchVerifiers(ctx, { repo, change: 'my-change' });
    expect(stateMod.loadState(repo, 'my-change').phase).toBe('developer-review');
  });

  test('invalid role rejected', async () => {
    const state = await prepareTriage();
    const plan = { roles: { 'not-a-role': { reason: 'x', files: ['a.py'] } } };
    fs.writeFileSync(orchestration.triagePlanPath(state), JSON.stringify(plan));
    await expect(orchestration.cmdDispatchVerifiers(ctx, { repo, change: 'my-change' })).rejects.toThrow();
  });

  test('no-openspec workflow rejects openspec verifier', async () => {
    const state = await prepareTriage('no-openspec');
    const files = JSON.parse(fs.readFileSync(orchestration.triageInputPath(state), 'utf8')).allChangedFiles;
    const plan = { roles: { 'openspec-verifier': { reason: 'openspec changed', files } } };
    fs.writeFileSync(orchestration.triagePlanPath(state), JSON.stringify(plan));
    await expect(orchestration.cmdDispatchVerifiers(ctx, { repo, change: 'my-change' })).rejects.toThrow(/unavailable roles/);
  });

  test('rejects wrong phase', async () => {
    makeState('apply');
    await expect(orchestration.cmdDispatchVerifiers(ctx, { repo, change: 'my-change' })).rejects.toThrow();
  });
});

function writeTriageInputFixture(state: stateMod.WorkflowState, files: string[] = []) {
  const p = orchestration.triageInputPath(state);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, JSON.stringify({ allChangedFiles: files }));
}

function writeReportFixture(state: stateMod.WorkflowState, role: string, verdict = 'PASS', findingsList: any[] = []) {
  const p = orchestration.reportPath(state, role);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  const lines = findingsList.map(finding => JSON.stringify(finding));
  lines.push(JSON.stringify({ type: 'verdict', verdict }));
  fs.writeFileSync(p, lines.join('\n') + '\n');
}

describe('cmdVerificationResult', () => {
  function verifyingState(roles: string[] = ['quality-verifier']) {
    const state = makeState('verify', {
      verificationRound: 1,
      verificationRoles: roles,
      verificationTier: 'lite',
      verificationRoleStartedAt: Object.fromEntries(roles.map(role => [role, clock.now().toISOString()])),
    });
    writeTriageInputFixture(state);
    return state;
  }

  test('single verifier pass starts test verifier', async () => {
    const state = verifyingState();
    writeReportFixture(state, 'quality-verifier', 'PASS');
    await orchestration.cmdVerificationResult(ctx, { repo, change: 'my-change', role: 'quality-verifier' });
    const after = stateMod.loadState(repo, 'my-change');
    expect(after.phase).toBe('verify');
    expect(after.testVerifierStarted).toBe(true);
    expect(after.panes['test-verifier']).toBeDefined();
  });

  test('test verifier pass moves to developer review', async () => {
    const state = verifyingState();
    writeReportFixture(state, 'quality-verifier', 'PASS');
    await orchestration.cmdVerificationResult(ctx, { repo, change: 'my-change', role: 'quality-verifier' });
    const mid = stateMod.loadState(repo, 'my-change');
    writeReportFixture(mid, 'test-verifier', 'PASS');
    await orchestration.cmdVerificationResult(ctx, { repo, change: 'my-change', role: 'test-verifier' });
    const after = stateMod.loadState(repo, 'my-change');
    expect(after.phase).toBe('developer-review');
    expect(after.verificationResults.coordinator.verdict).toBe('PASS');
    const traces = fs
      .readFileSync(path.join(stateMod.workflowDir(after), 'traces.jsonl'), 'utf8')
      .trim()
      .split('\n')
      .map(line => JSON.parse(line));
    expect(traces.some(t => t.name === 'workflow.developer_review_ready')).toBe(true);
  });

  test('any fail moves to fix', async () => {
    const state = verifyingState(['quality-verifier', 'security-verifier']);
    writeReportFixture(state, 'quality-verifier', 'FAIL', [{ type: 'finding', severity: 'critical', path: 'a.py', line: 1, detail: 'bug', evidence: 'repro', fix: 'fix bug' }]);
    await orchestration.cmdVerificationResult(ctx, { repo, change: 'my-change', role: 'quality-verifier' });
    writeReportFixture(state, 'security-verifier', 'PASS');
    await orchestration.cmdVerificationResult(ctx, { repo, change: 'my-change', role: 'security-verifier' });
    const after = stateMod.loadState(repo, 'my-change');
    const traces = fs
      .readFileSync(path.join(stateMod.workflowDir(after), 'traces.jsonl'), 'utf8')
      .trim()
      .split('\n')
      .map(line => JSON.parse(line));
    const findingTrace = traces.find(t => t.name === 'workflow.verification_finding');
    expect(after.phase).toBe('fix');
    expect(after.panes.worker).toBeDefined();
    expect(findingTrace.attributes['herdr.severity']).toBe('critical');
    expect(findingTrace.attributes['herdr.finding_id']).toBeTruthy();
    expect(findingTrace.attributes['herdr.finding_path']).toBe('a.py');
    expect(findingTrace.attributes['herdr.finding_line']).toBe(1);
    expect(findingTrace.attributes['herdr.description']).toBe('bug');
    expect(findingTrace.attributes['herdr.evidence']).toBe('repro');
    expect(findingTrace.attributes['herdr.resolution']).toBe('fix bug');
  });

  test('round limit reached pauses', async () => {
    const maxRounds = ctx.config.workflow.max_verification_rounds;
    const state = verifyingState();
    state.verificationRound = maxRounds;
    stateMod.saveState(state);
    writeReportFixture(state, 'quality-verifier', 'FAIL');
    await orchestration.cmdVerificationResult(ctx, { repo, change: 'my-change', role: 'quality-verifier' });
    expect(stateMod.loadState(repo, 'my-change').phase).toBe('paused');
  });

  test('unknown role rejected', async () => {
    verifyingState();
    await expect(orchestration.cmdVerificationResult(ctx, { repo, change: 'my-change', role: 'ghost-verifier' })).rejects.toThrow();
  });

  test('wrong phase is ignored', async () => {
    makeState('fix');
    await expect(orchestration.cmdVerificationResult(ctx, { repo, change: 'my-change', role: 'quality-verifier' })).resolves.toBeUndefined();
  });

  test('finish review only sends selected findings to worker', async () => {
    const state = makeState('developer-review', { verificationRound: 1, verificationResults: { 'quality-verifier': { verdict: 'PASS' }, 'test-verifier': { verdict: 'PASS' } } });
    const reviews = path.join(stateMod.workflowDir(state), 'reviews');
    fs.mkdirSync(reviews, { recursive: true });
    fs.writeFileSync(
      path.join(reviews, 'findings.json'),
      JSON.stringify({
        rounds: {
          '1': [
            { id: 'warn-1', severity: 'warning', role: 'quality-verifier', status: 'new', path: 'a.py', line: 1, detail: 'optional cleanup' },
            { id: 'info-1', severity: 'info', role: 'quality-verifier', status: 'new', path: 'b.py', line: 2, detail: 'accepted cleanup' },
          ],
        },
      }),
    );
    fs.writeFileSync(
      path.join(reviews, 'developer-review.json'),
      JSON.stringify({
        comments: [
          { findingId: 'warn-1', filePath: 'a.py', line: 1, body: 'optional cleanup' },
          { filePath: 'c.py', line: 4, startLine: 2, endLine: 4, body: 'review range' },
        ],
      }),
    );

    await orchestration.cmdFinishReview(ctx, { repo, change: 'my-change' });

    const after = stateMod.loadState(repo, 'my-change');
    const context = fs.readFileSync(path.join(reviews, 'developer-review-context.md'), 'utf8');
    const accepted = JSON.parse(fs.readFileSync(path.join(reviews, 'accepted-findings.json'), 'utf8'));
    expect(after.phase).toBe('apply');
    expect(after.panes.worker).toBeDefined();
    expect(context).toContain('optional cleanup');
    expect(context).toContain('c.py:2-4');
    expect(context).not.toContain('accepted cleanup');
    expect(accepted.ids).toEqual(['info-1']);
    const traces = fs
      .readFileSync(path.join(stateMod.workflowDir(after), 'traces.jsonl'), 'utf8')
      .trim()
      .split('\n')
      .map(line => JSON.parse(line));
    const comments = traces.filter(t => t.name === 'workflow.developer_review_comment');
    const acceptedTrace = traces.find(t => t.name === 'workflow.developer_accepted_finding');
    expect(comments.length).toBe(2);
    expect(comments[0].attributes['herdr.finding_id']).toBe('warn-1');
    expect(comments[0].attributes['herdr.file_path']).toBe('a.py');
    expect(comments[0].attributes['herdr.start_line']).toBe(1);
    expect(comments[0].attributes['herdr.body']).toBe('optional cleanup');
    expect(acceptedTrace.attributes['herdr.finding_id']).toBe('info-1');
    expect(acceptedTrace.attributes['herdr.status']).toBe('accepted');
  });

  test('finish review without comments archives and accepts findings', async () => {
    const state = makeState('developer-review', { verificationRound: 1 });
    writeChangeArtifacts(true, ['x']);
    const reviews = path.join(stateMod.workflowDir(state), 'reviews');
    fs.mkdirSync(reviews, { recursive: true });
    fs.writeFileSync(path.join(reviews, 'findings.json'), JSON.stringify({ rounds: { '1': [{ id: 'info-1', severity: 'info', status: 'new' }] } }));
    fs.writeFileSync(path.join(reviews, 'developer-review.json'), JSON.stringify({ comments: [] }));

    await orchestration.cmdFinishReview(ctx, { repo, change: 'my-change' });

    const after = stateMod.loadState(repo, 'my-change');
    expect(after.phase).toBe('archive');
    expect(JSON.parse(fs.readFileSync(path.join(reviews, 'accepted-findings.json'), 'utf8')).ids).toEqual(['info-1']);
  });

  test('accepted optional findings are not reoffered', () => {
    const state = makeState('developer-review', { verificationRound: 1 });
    const reviews = path.join(stateMod.workflowDir(state), 'reviews');
    fs.mkdirSync(reviews, { recursive: true });
    fs.writeFileSync(path.join(reviews, 'findings.json'), JSON.stringify({ rounds: { '1': [{ id: 'info-1', severity: 'info', status: 'accepted' }] } }));
    expect(orchestration.optionalFindings(state)).toEqual([]);
  });
});

describe('archive and git operations', () => {
  test('developer review starts archive', async () => {
    const state = makeState('developer-review');
    writeChangeArtifacts(true, ['x']);
    await orchestration.cmdArchive(ctx, { repo, change: 'my-change' });
    const after = stateMod.loadState(repo, 'my-change');
    expect(after.phase).toBe('archive');
    expect(after.developerApproval).toBe(true);
    expect(after.panes.archive).toBeDefined();
  });

  test('developer review without openspec change skips archive', async () => {
    makeState('developer-review', { workflowType: 'no-openspec' });
    dirtyFile();
    await orchestration.cmdArchive(ctx, { repo, change: 'my-change' });
    const state = stateMod.loadState(repo, 'my-change');
    expect(state.phase).toBe('completed');
    expect(state.panes.archive).toBeUndefined();
    expect(herdr.calls.some(call => call.some(token => String(token).includes('herdr-openspec-archive')))).toBe(false);
  });

  test('archive phase commits and pushes without agent', async () => {
    makeState('archive');
    dirtyFile();
    await orchestration.cmdArchive(ctx, { repo, change: 'my-change' });
    const state = stateMod.loadState(repo, 'my-change');
    expect(state.phase).toBe('completed');
    expect(ctx.git.run(['log', '-1', '--format=%s'], repo)).toBe('Apply my-change');
    expect(ctx.git.run(['rev-parse', 'HEAD'], repo)).toBe(ctx.git.run(['rev-parse', 'origin/feature/my-change'], repo));
    expect(herdr.calls).toContainEqual(['pane', 'close', 'pane-git']);
    expect(herdr.calls.some(call => call[0] === 'agent' && call[1] === 'start')).toBe(false);
  });

  test('git operations are committing while pushing', async () => {
    ctx.git = new CommittingPushGit(repo);
    makeState('archive');
    dirtyFile();
    await orchestration.cmdArchive(ctx, { repo, change: 'my-change' });
    expect((ctx.git as CommittingPushGit).phases).toEqual(['committing']);
  });

  test('push failure keeps workflow retryable', async () => {
    ctx.git = new FailFirstPushGit();
    makeState('archive');
    dirtyFile();
    await expect(orchestration.cmdArchive(ctx, { repo, change: 'my-change' })).rejects.toThrow(/push failed/);
    expect(stateMod.loadState(repo, 'my-change').phase).toBe('archive');

    await orchestration.cmdArchive(ctx, { repo, change: 'my-change' });
    const state = stateMod.loadState(repo, 'my-change');
    expect(state.phase).toBe('completed');
    expect(ctx.git.run(['rev-parse', 'HEAD'], repo)).toBe(ctx.git.run(['rev-parse', 'origin/feature/my-change'], repo));
  });

  test('exception during push restores archive phase and start time', async () => {
    ctx.git = new FailFirstPushExceptionGit();
    const originalStart = '2024-01-01T00:00:00+00:00';
    makeState('archive', { phaseStartedAt: originalStart });
    dirtyFile();

    await expect(orchestration.cmdArchive(ctx, { repo, change: 'my-change' })).rejects.toThrow(/push failed/);

    const state = stateMod.loadState(repo, 'my-change');
    expect(state.phase).toBe('archive');
    expect(state.phaseStartedAt).toBe(originalStart);
  });

  test('base move after push does not block completion', async () => {
    ctx.git = new MoveBaseAfterPushGit();
    const state = makeState('archive');
    dirtyFile();

    await orchestration.cmdArchive(ctx, { repo, change: 'my-change' });

    expect(ctx.git.run(['rev-parse', 'origin/main'], repo)).not.toBe(state.baseCommit);
    expect(stateMod.loadState(repo, 'my-change').phase).toBe('completed');
    expect(ctx.git.run(['log', '-1', '--format=%s'], repo)).toBe('Apply my-change');
    expect(ctx.git.run(['status', '--porcelain'], repo)).toBe('');
  });

  test('git-operations subcommand requires archive phase', () => {
    makeState('developer-review');
    expect(() => orchestration.cmdGitOperations(ctx, { repo, change: 'my-change' })).toThrow();
  });

  test('committing phase completes on clean tree', async () => {
    makeState('committing');
    await orchestration.cmdArchive(ctx, { repo, change: 'my-change' });
    expect(stateMod.loadState(repo, 'my-change').phase).toBe('completed');
  });

  test('committing phase rejects dirty tree', async () => {
    makeState('committing');
    dirtyFile();
    await expect(orchestration.cmdArchive(ctx, { repo, change: 'my-change' })).rejects.toThrow();
  });
});

describe('legacy layout-state fields', () => {
  test('legacy state.json with removed layout fields still loads', () => {
    const state = makeState('verify', {
      verificationSecondRowPane: 'pane-legacy',
      verificationSecondRowRole: 'quality-verifier',
      verificationPaneOrder: ['triage', 'quality-verifier'],
    });
    expect(() => stateMod.loadState(repo, 'my-change')).not.toThrow();
    const loaded = stateMod.loadState(repo, 'my-change');
    expect(loaded.phase).toBe('verify');

    // The next save strips those fields from the persisted file (R3).
    stateMod.saveState(state);
    const onDisk = JSON.parse(fs.readFileSync(stateMod.statePath(repo, 'my-change'), 'utf8'));
    expect(onDisk.verificationSecondRowPane).toBeUndefined();
    expect(onDisk.verificationSecondRowRole).toBeUndefined();
    expect(onDisk.verificationPaneOrder).toBeUndefined();
  });
});

describe('cmdMessage', () => {
  test('writes artifact and prompts target', () => {
    const state = makeState('apply', { panes: { worker: 'pane-worker' } });
    const name = orchestration.roleAgentName(state, 'worker');
    herdr.registerPane('pane-worker', name);
    herdr.setAgent(name, { agentStatus: 'idle' });
    orchestration.cmdMessage(ctx, { repo, change: 'my-change', sender: 'dev', target: 'worker', text: 'please hurry' });
    const calls = herdr.calls.filter(call => call[0] === 'agent' && call[1] === 'prompt' && call[3]?.includes('please hurry'));
    expect(calls.length).toBe(1);
  });

  test('unknown target rejected', () => {
    makeState('apply', { panes: {} });
    expect(() => orchestration.cmdMessage(ctx, { repo, change: 'my-change', sender: 'dev', target: 'ghost', text: 'hi' })).toThrow();
  });
});

describe('launchRole', () => {
  test('long change agent names keep role suffix', () => {
    const state = { changeId: 'x'.repeat(32) };
    const worker = orchestration.roleAgentName(state, 'worker');
    const triage = orchestration.roleAgentName(state, 'triage');
    expect(worker.length).toBe(32);
    expect(worker.endsWith('-worker')).toBe(true);
    expect(triage.endsWith('-triage')).toBe(true);
    expect(worker).not.toBe(triage);
  });

  test('herdr agent name and pi --name agree, including truncation', () => {
    for (const changeId of ['short-change', 'x'.repeat(32), 'y'.repeat(50)]) {
      const state = { changeId };
      const herdrName = orchestration.roleAgentName(state, 'worker');
      const args = prompts.piArguments('worker', 'test/worker', 'high', changeId, DEFAULT_CONFIG);
      const piName = args[args.indexOf('--name') + 1];
      expect(piName).toBe(herdrName);
    }
  });

  test('starts pi agent with initial prompt', async () => {
    const state = makeState('apply');
    await orchestration.launchRole(ctx, state, 'worker');
    const kinds = herdr.calls.map(call => `${call[0]} ${call[1]}`);
    const tabCreate = herdr.calls.find(call => call[0] === 'tab' && call[1] === 'create')!;
    const launch = herdr.calls.find(call => call[0] === 'agent' && call[1] === 'start')!;
    expect(kinds).toContain('tab create');
    expect(kinds).not.toContain('pane split');
    expect(kinds).not.toContain('pane run');
    expect(kinds).not.toContain('pane send-keys');
    expect(launch.slice(0, 7)).toEqual(['agent', 'start', 'my-change-worker', '--kind', 'pi', '--pane', state.panes.worker]);
    expect(launch[7]).toBe('--');
    expect(launch.slice(0, 7)).not.toContain('--cwd');
    expect(tabCreate[tabCreate.indexOf('--cwd') + 1]).toBe(repo);
    expect(launch).toContain('--name');
    expect(launch).toContain('my-change-worker');
    expect(launch.at(-1)).toContain('/skill:herdr-openspec-worker');
    expect(state.panes.worker).toBeDefined();
    expect(state.tabs.worker).toBeDefined();
  });

  test('groups named agents in two verification rows', async () => {
    const roles = ['triage', 'quality-verifier', 'performance-verifier', 'security-verifier', 'agents-verifier'];
    const state = makeState('triage', { verificationRoles: roles.slice(1) });
    for (const role of roles) await orchestration.launchRole(ctx, state, role);

    const launches = herdr.calls.filter(call => call[0] === 'agent' && call[1] === 'start');
    const splits = herdr.calls.filter(call => call[0] === 'pane' && call[1] === 'split');
    const renames = herdr.calls.filter(call => call[0] === 'pane' && call[1] === 'rename');
    const verificationTab = state.tabs.verification;

    expect(herdr.calls.filter(call => call[0] === 'tab' && call[1] === 'create').length).toBe(1);
    expect(splits.map(call => [call[2], call[call.indexOf('--direction') + 1]])).toEqual([
      ['pane-1', 'down'],
      ['pane-1', 'right'],
      ['pane-2', 'right'],
      ['pane-4', 'right'],
    ]);
    expect(splits[0][splits[0].indexOf('--env') + 1]).toBe('HERDR_ROLE=performance-verifier');
    expect(launches.map(call => call[call.indexOf('--pane') + 1])).toEqual(['pane-1', 'pane-3', 'pane-2', 'pane-4', 'pane-5']);
    expect(renames).toEqual([
      ['pane', 'rename', 'pane-1', 'triage'],
      ['pane', 'rename', 'pane-3', 'quality-verifier'],
      ['pane', 'rename', 'pane-2', 'performance-verifier'],
      ['pane', 'rename', 'pane-4', 'security-verifier'],
      ['pane', 'rename', 'pane-5', 'agents-verifier'],
    ]);
    expect(launches.every(launch => herdr.paneToTabMap.get(launch[launch.indexOf('--pane') + 1]) === verificationTab)).toBe(true);
    expect(roles.every(role => state.tabs[role] === verificationTab)).toBe(true);
  });

  test('replacing grouped role closes only its pane', async () => {
    const state = makeState('verify', { panes: { 'quality-verifier': 'old-pane' }, tabs: { 'quality-verifier': 'verification-tab', verification: 'verification-tab' } });
    await orchestration.launchRole(ctx, state, 'quality-verifier');
    expect(herdr.calls).toContainEqual(['pane', 'close', 'old-pane']);
    expect(herdr.calls).not.toContainEqual(['tab', 'close', 'verification-tab']);
  });

  test('never reuses worker tab as verification tab', async () => {
    const state = makeState('verify', { panes: { worker: 'worker-pane' }, tabs: { worker: 'worker-tab', verification: 'worker-tab' } });
    await orchestration.launchRole(ctx, state, 'quality-verifier');
    expect(state.tabs['quality-verifier']).not.toBe('worker-tab');
    expect(herdr.calls).not.toContainEqual(['pane', 'close', 'worker-pane']);
    expect(herdr.calls).not.toContainEqual(['tab', 'close', 'worker-tab']);
  });
});

describe('prompt submission', () => {
  test('submits follow-up through agent prompt', () => {
    const state = makeState('apply', { panes: { worker: 'pane-1' } });
    herdr.registerPane('pane-1', orchestration.roleAgentName(state, 'worker'));
    orchestration.promptRole(ctx, state, 'worker', 'go');
    expect(herdr.calls).toContainEqual(['agent', 'prompt', 'pane-1', 'go']);
    expect(herdr.calls.some(call => (call[0] === 'pane' && (call[1] === 'run' || call[1] === 'send-keys')) || (call[0] === 'wait' && call[1] === 'agent-status'))).toBe(false);
  });

  test('reuses role launched with pi name', async () => {
    const state = makeState('apply');
    await orchestration.launchRole(ctx, state, 'worker');
    herdr.calls.length = 0;

    await orchestration.startRole(ctx, state, 'worker', 'go');

    expect(herdr.calls).toContainEqual(['agent', 'get', state.panes.worker]);
    expect(herdr.calls).toContainEqual(['agent', 'prompt', state.panes.worker, 'go']);
    expect(herdr.calls.some(call => call[0] === 'agent' && call[1] === 'start')).toBe(false);
  });

  test('reuses persistent done verifier', async () => {
    const state = makeState('verify', { panes: { 'quality-verifier': 'pane-1' }, tabs: { 'quality-verifier': 'tab-verification', verification: 'tab-verification' } });
    herdr.registerPane('pane-1', orchestration.roleAgentName(state, 'quality-verifier'), 'tab-verification');
    herdr.setStatus('pane-1', 'done');
    await orchestration.startRole(ctx, state, 'quality-verifier', 'next round');
    expect(herdr.calls).toContainEqual(['agent', 'prompt', 'pane-1', 'next round']);
    expect(herdr.calls.some(call => call[0] === 'agent' && call[1] === 'start')).toBe(false);
  });

  test('refreshes moved standalone agent tab', async () => {
    const state = makeState('apply');
    await orchestration.launchRole(ctx, state, 'worker');
    const actualTab = state.tabs.worker;
    state.tabs.worker = 'stale-tab';
    await orchestration.startRole(ctx, state, 'worker', 'go');
    expect(state.tabs.worker).toBe(actualTab);
    expect(herdr.calls).not.toContainEqual(['tab', 'close', 'stale-tab']);
  });

  test('unknown agent restarts in fresh tab', async () => {
    const state = makeState('apply', { panes: { worker: 'old-pane' }, tabs: { worker: 'old-tab' } });
    herdr.registerPane('old-pane', orchestration.roleAgentName(state, 'worker'));
    herdr.setStatus('old-pane', 'unknown');
    await orchestration.startRole(ctx, state, 'worker', 'go');
    expect(herdr.calls).toContainEqual(['tab', 'close', 'old-tab']);
    expect(state.panes.worker).not.toBe('old-pane');
    const launch = herdr.calls.find(call => call[0] === 'agent' && call[1] === 'start')!;
    expect(launch[2]).toBe(orchestration.roleAgentName(state, 'worker'));
  });
});
