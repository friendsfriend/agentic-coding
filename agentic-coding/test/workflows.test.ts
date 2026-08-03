// End-to-end per-workflow-type tests: drive a full run through fakes, asserting the
// phase sequence matches the module chain and the run terminates in `completed`.
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import type { Context } from '../src/workflow/effects.ts';
import * as orchestration from '../src/workflow/orchestration.ts';
import * as stateMod from '../src/workflow/state.ts';
import * as transitions from '../src/workflow/transitions.ts';
import { FakeClock, FakeHerdr, initRepo, makeContext } from './fakes.ts';

let tmp: string;
let repo: string;
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

function dirtyFile(name = 'README.md', content = '# test\nchanged\n') {
  const p = path.join(repo, name);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, content);
}

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'workflow-e2e-'));
  repo = initRepo(path.join(tmp, 'repo'));
  herdr = new FakeHerdr();
  clock = new FakeClock();
  ctx = makeContext({ herdr, clock });
  const origin = path.join(tmp, 'origin.git');
  execFileSync('git', ['init', '--bare', '-q', '-b', 'main', origin]);
  ctx.git.run(['remote', 'add', 'origin', origin], repo);
  ctx.git.run(['push', '-q', 'origin', 'main'], repo);
  ctx.git.run(['checkout', '-b', 'feature/my-change'], repo);
});

afterEach(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
});

async function passVerifier(role: string) {
  const state = stateMod.loadState(repo, 'my-change');
  const reportPath = orchestration.reportPath(state, role);
  fs.mkdirSync(path.dirname(reportPath), { recursive: true });
  fs.writeFileSync(reportPath, ''); // no findings = pass (verdict is engine-derived)
  await orchestration.cmdVerificationResult(ctx, { repo, change: 'my-change', role });
  if (role === 'test-verifier') {
    // test-verifier skill ends with finish-review (deterministic consolidation)
    await orchestration.cmdFinishReview(ctx, { repo, change: 'my-change' });
  }
  return stateMod.loadState(repo, 'my-change');
}

describe('standard workflow', () => {
  test('full run reaches completed', async () => {
    const phasesSeen: string[] = [];
    let state = makeState('explore', { workflowModules: [...transitions.WORKFLOW_TYPES.standard] });
    phasesSeen.push(state.phase);

    // planner explores, submits proposal
    await orchestration.cmdPlanner(ctx, { repo, change: 'my-change' });
    writeChangeArtifacts(true);
    orchestration.cmdPhase(ctx, { repo, change: 'my-change', phase: 'proposed' });
    state = stateMod.loadState(repo, 'my-change');
    phasesSeen.push(state.phase);
    expect(state.phase).toBe('proposed');

    // developer approves -> apply, worker starts
    await orchestration.cmdApply(ctx, { repo, change: 'my-change' });
    state = stateMod.loadState(repo, 'my-change');
    phasesSeen.push(state.phase);
    expect(state.phase).toBe('apply');

    // worker makes a change, triggers verification
    dirtyFile();
    await orchestration.cmdVerify(ctx, { repo, change: 'my-change' });
    state = stateMod.loadState(repo, 'my-change');
    phasesSeen.push(state.phase);
    expect(state.phase).toBe('triage');

    // triage assigns one verifier
    const triageInput = JSON.parse(fs.readFileSync(orchestration.triageInputPath(state), 'utf8'));
    const plan = { roles: { 'quality-verifier': { reason: 'code change', files: triageInput.allChangedFiles } } };
    fs.writeFileSync(orchestration.triagePlanPath(state), JSON.stringify(plan));
    await orchestration.cmdDispatchVerifiers(ctx, { repo, change: 'my-change' });
    state = stateMod.loadState(repo, 'my-change');
    phasesSeen.push(state.phase);
    expect(state.phase).toBe('verify');

    // verifier passes -> test verifier starts -> test verifier passes -> developer-review
    state = await passVerifier('quality-verifier');
    expect(state.testVerifierStarted).toBe(true);
    state = await passVerifier('test-verifier');
    phasesSeen.push(state.phase);
    expect(state.phase).toBe('developer-review');

    // developer approves -> archive -> completed
    await orchestration.cmdArchive(ctx, { repo, change: 'my-change' });
    state = stateMod.loadState(repo, 'my-change');
    phasesSeen.push(state.phase);
    expect(state.phase).toBe('archive');

    await orchestration.cmdArchive(ctx, { repo, change: 'my-change' });
    state = stateMod.loadState(repo, 'my-change');
    phasesSeen.push(state.phase);
    expect(state.phase).toBe('completed');

    expect(phasesSeen).toEqual(['explore', 'proposed', 'apply', 'triage', 'verify', 'developer-review', 'archive', 'completed']);
  });
});

describe('direct-apply workflow', () => {
  test('full run skips planning', async () => {
    makeState('apply', { workflowModules: [...transitions.WORKFLOW_TYPES['direct-apply']], workflowType: 'direct-apply' });
    writeChangeArtifacts(true);
    dirtyFile();

    await orchestration.cmdVerify(ctx, { repo, change: 'my-change' });
    let state = stateMod.loadState(repo, 'my-change');
    expect(state.phase).toBe('triage');

    const triageInput = JSON.parse(fs.readFileSync(orchestration.triageInputPath(state), 'utf8'));
    const plan = { roles: { 'quality-verifier': { reason: 'code change', files: triageInput.allChangedFiles } } };
    fs.writeFileSync(orchestration.triagePlanPath(state), JSON.stringify(plan));
    await orchestration.cmdDispatchVerifiers(ctx, { repo, change: 'my-change' });

    state = await passVerifier('quality-verifier');
    state = await passVerifier('test-verifier');
    expect(state.phase).toBe('developer-review');

    await orchestration.cmdArchive(ctx, { repo, change: 'my-change' });
    await orchestration.cmdArchive(ctx, { repo, change: 'my-change' });
    state = stateMod.loadState(repo, 'my-change');
    expect(state.phase).toBe('completed');
  });
});

describe('no-openspec workflow', () => {
  test('full run skips task checklist', async () => {
    makeState('apply', { workflowModules: [...transitions.WORKFLOW_TYPES['no-openspec']], workflowType: 'no-openspec' });
    dirtyFile(); // worker "applied the change" — no OpenSpec tasks.md required

    await orchestration.cmdVerify(ctx, { repo, change: 'my-change' });
    let state = stateMod.loadState(repo, 'my-change');
    expect(state.phase).toBe('triage');

    const triageInput = JSON.parse(fs.readFileSync(orchestration.triageInputPath(state), 'utf8'));
    const plan = { roles: { 'quality-verifier': { reason: 'code change', files: triageInput.allChangedFiles } } };
    fs.writeFileSync(orchestration.triagePlanPath(state), JSON.stringify(plan));
    await orchestration.cmdDispatchVerifiers(ctx, { repo, change: 'my-change' });

    state = await passVerifier('quality-verifier');
    state = await passVerifier('test-verifier');
    expect(state.phase).toBe('developer-review');

    await orchestration.cmdArchive(ctx, { repo, change: 'my-change' });
    state = stateMod.loadState(repo, 'my-change');
    expect(state.phase).toBe('completed');
    expect(state.panes.archive).toBeUndefined();
  });
});

describe('close', () => {
  test('close --clean removes the worktree directory', () => {
    const worktree = path.join(tmp, 'worktree');
    fs.mkdirSync(worktree, { recursive: true });
    fs.writeFileSync(path.join(worktree, 'file.txt'), 'work');
    makeState('completed', { worktree, repository: repo });

    orchestration.cmdClose(ctx, { repo, change: 'my-change', clean: true });

    expect(fs.existsSync(worktree)).toBe(false);
    expect(herdr.calls.some(call => call[0] === 'workspace' && call[1] === 'close')).toBe(true);
  });

  test('close without --clean keeps the worktree directory', () => {
    const worktree = path.join(tmp, 'worktree-keep');
    fs.mkdirSync(worktree, { recursive: true });
    fs.writeFileSync(path.join(worktree, 'file.txt'), 'work');
    makeState('completed', { worktree, repository: repo });

    orchestration.cmdClose(ctx, { repo, change: 'my-change' });

    expect(fs.existsSync(worktree)).toBe(true);
    expect(herdr.calls.some(call => call[0] === 'workspace' && call[1] === 'close')).toBe(true);
  });
});

describe('verification-result idempotency and concurrency', () => {
  function writeReport(role: string, findingsList: any[] = []) {
    const reportPath = orchestration.reportPath(stateMod.loadState(repo, 'my-change'), role);
    fs.mkdirSync(path.dirname(reportPath), { recursive: true });
    fs.writeFileSync(reportPath, findingsList.map(finding => JSON.stringify(finding)).join('\n') + (findingsList.length ? '\n' : ''));
  }

  function agentStarts(role: string): number {
    const prefix = `my-change-${role}`;
    return herdr.calls.filter(call => call[0] === 'agent' && call[1] === 'start' && call[2]?.startsWith(prefix)).length;
  }

  test('duplicate reports do not re-trigger transitions', async () => {
    // Set up a real round 1 through verify/dispatch so all review artifacts exist.
    makeState('apply');
    writeChangeArtifacts(true);
    dirtyFile();
    await orchestration.cmdVerify(ctx, { repo, change: 'my-change' });
    let state = stateMod.loadState(repo, 'my-change');
    expect(state.phase).toBe('triage');
    const triageInput = JSON.parse(fs.readFileSync(orchestration.triageInputPath(state), 'utf8'));
    const plan = { roles: { 'quality-verifier': { reason: 'code change', files: triageInput.allChangedFiles } } };
    fs.writeFileSync(orchestration.triagePlanPath(state), JSON.stringify(plan));
    await orchestration.cmdDispatchVerifiers(ctx, { repo, change: 'my-change' });
    state = stateMod.loadState(repo, 'my-change');
    expect(state.phase).toBe('verify');

    // First quality-verifier pass (no findings): records, starts test verifier, stays in verify.
    writeReport('quality-verifier');
    await orchestration.cmdVerificationResult(ctx, { repo, change: 'my-change', role: 'quality-verifier' });
    state = stateMod.loadState(repo, 'my-change');
    expect(state.testVerifierStarted).toBe(true);
    expect(state.verificationReported?.['1:quality-verifier']).toBe(true);
    expect(agentStarts('test-verifier')).toBe(1);

    // Duplicate PASS while still in verify: ignored, no second test-verifier start.
    await orchestration.cmdVerificationResult(ctx, { repo, change: 'my-change', role: 'quality-verifier' });
    state = stateMod.loadState(repo, 'my-change');
    expect(state.phase).toBe('verify');
    expect(state.verificationResults?.['quality-verifier']?.verdict).toBe('PASS');
    expect(agentStarts('test-verifier')).toBe(1);

    // Test verifier FAIL (critical finding): one fix round, one worker start.
    writeReport('test-verifier', [{ type: 'finding', severity: 'critical', path: 'src/suite.test.ts', line: 1, detail: 'suite failure introduced by change' }]);
    await orchestration.cmdVerificationResult(ctx, { repo, change: 'my-change', role: 'test-verifier' });
    state = stateMod.loadState(repo, 'my-change');
    expect(state.phase).toBe('fix');
    expect(agentStarts('worker')).toBe(1);

    // Duplicate FAIL after the round transitioned: ignored, no second worker start.
    await orchestration.cmdVerificationResult(ctx, { repo, change: 'my-change', role: 'test-verifier' });
    state = stateMod.loadState(repo, 'my-change');
    expect(state.phase).toBe('fix');
    expect(agentStarts('worker')).toBe(1);
  });

  test('critical finding fails the round with no verdict record', async () => {
    // Set up a real round 1 through verify/dispatch so all review artifacts exist.
    makeState('apply');
    writeChangeArtifacts(true);
    dirtyFile();
    await orchestration.cmdVerify(ctx, { repo, change: 'my-change' });
    let state = stateMod.loadState(repo, 'my-change');
    const triageInput = JSON.parse(fs.readFileSync(orchestration.triageInputPath(state), 'utf8'));
    const plan = { roles: { 'quality-verifier': { reason: 'code change', files: triageInput.allChangedFiles } } };
    fs.writeFileSync(orchestration.triagePlanPath(state), JSON.stringify(plan));
    await orchestration.cmdDispatchVerifiers(ctx, { repo, change: 'my-change' });
    state = stateMod.loadState(repo, 'my-change');
    expect(state.phase).toBe('verify');

    // Findings-only report — no verdict record anywhere. A critical finding
    // derives FAIL and the round fails fast to a fix round.
    const reportPath = orchestration.reportPath(state, 'quality-verifier');
    fs.mkdirSync(path.dirname(reportPath), { recursive: true });
    fs.writeFileSync(reportPath, JSON.stringify({ type: 'finding', severity: 'critical', path: 'src/thing.ts', line: 5, detail: 'sql injection' }) + '\n');
    await orchestration.cmdVerificationResult(ctx, { repo, change: 'my-change', role: 'quality-verifier' });
    state = stateMod.loadState(repo, 'my-change');
    expect(state.phase).toBe('fix');
    expect(state.verificationResults?.['quality-verifier']?.verdict).toBe('FAIL');
    expect(agentStarts('worker')).toBe(1);
  });

  test('warning findings derive PASS and stay advisory', async () => {
    makeState('verify', { verificationRound: 1, verificationRoles: ['quality-verifier'], verificationResults: {}, verificationReported: {}, testVerifierStarted: false });
    // writeTestContext reads the triage input for the changed-files list.
    const triageInput = orchestration.triageInputPath(stateMod.loadState(repo, 'my-change'));
    fs.mkdirSync(path.dirname(triageInput), { recursive: true });
    fs.writeFileSync(triageInput, JSON.stringify({ allChangedFiles: ['README.md'] }));
    writeReport('quality-verifier', [{ type: 'finding', severity: 'warning', path: 'src/thing.ts', line: 5, detail: 'naming smell' }]);
    await orchestration.cmdVerificationResult(ctx, { repo, change: 'my-change', role: 'quality-verifier' });
    // Pass the round fully so findings consolidate into the developer-review flow.
    writeReport('test-verifier');
    await orchestration.cmdVerificationResult(ctx, { repo, change: 'my-change', role: 'test-verifier' });
    await orchestration.cmdFinishReview(ctx, { repo, change: 'my-change' });
    const state = stateMod.loadState(repo, 'my-change');
    expect(state.phase).toBe('developer-review');
    expect(state.verificationResults?.['quality-verifier']?.verdict).toBe('PASS');
    const advisory = orchestration.optionalFindings(state);
    expect(advisory.map(item => item.detail)).toContain('naming smell');
  });

  test('concurrent reporters both land in state', async () => {
    makeState('verify', { verificationRound: 1, verificationRoles: ['security-verifier', 'quality-verifier'], verificationResults: {}, verificationReported: {}, testVerifierStarted: false });
    // Two separate processes update the same row at once; the spin widens the
    // load->save window so a missing write transaction loses one update.
    const script = path.join(tmp, 'report-role.ts');
    fs.writeFileSync(
      script,
      `import { updateState } from '${path.resolve(__dirname, '../src/workflow/state.ts')}';
const [repoDir, change, role] = process.argv.slice(2);
updateState(repoDir, change, s => {
  const end = Date.now() + 150;
  while (Date.now() < end) {}
  s.verificationResults = { ...(s.verificationResults ?? {}), [role]: { verdict: 'PASS' } };
});
`,
    );
    const [a, b] = [Bun.spawn([process.execPath, script, repo, 'my-change', 'security-verifier'], { stdout: 'pipe' }), Bun.spawn([process.execPath, script, repo, 'my-change', 'quality-verifier'], { stdout: 'pipe' })];
    expect(await a.exited).toBe(0);
    expect(await b.exited).toBe(0);
    const state = stateMod.loadState(repo, 'my-change');
    expect(state.verificationResults?.['security-verifier']?.verdict).toBe('PASS');
    expect(state.verificationResults?.['quality-verifier']?.verdict).toBe('PASS');
  });
});
