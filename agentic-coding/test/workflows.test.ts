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
  fs.writeFileSync(reportPath, JSON.stringify({ type: 'verdict', verdict: 'PASS' }) + '\n');
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
