// PR/MR creation: pure body/title/tool-arg building plus the guarded command.
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import type { Context } from '../src/workflow/effects.ts';
import * as pr from '../src/workflow/pr.ts';
import * as stateMod from '../src/workflow/state.ts';
import { FakeClock, FakeHerdr, initRepo, makeContext } from './fakes.ts';

let tmp: string;
let repo: string;
let ctx: Context;

function makeCompletedState(overrides: Record<string, unknown> = {}): stateMod.WorkflowState {
  const state: stateMod.WorkflowState = {
    changeId: 'my-change',
    phase: 'completed',
    repository: repo,
    worktree: repo,
    branch: 'feature/my-change',
    workspace: 'ws-1',
    task: 'Make preferred date optional',
    ticketNumber: 'DAPC-123',
    verificationRound: 1,
    returnWorkspace: null,
    baseBranch: 'origin/main',
    baseCommit: ctx.git.run(['rev-parse', 'HEAD'], repo),
    developerApproval: true,
    panes: {},
    tabs: {},
    workflowModules: null,
    workflowType: 'standard',
    createdAt: ctx.clock.now().toISOString(),
    verificationTier: 'lite',
    verificationResults: { 'quality-verifier': { verdict: 'PASS' }, coordinator: { verdict: 'PASS' } },
  };
  Object.assign(state, overrides);
  stateMod.saveState(state);
  return state;
}

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'pr-test-'));
  repo = initRepo(path.join(tmp, 'repo'));
  ctx = makeContext({ herdr: new FakeHerdr(), clock: new FakeClock() });
  const origin = path.join(tmp, 'origin.git');
  execFileSync('git', ['init', '--bare', '-q', '-b', 'main', origin]);
  ctx.git.run(['remote', 'add', 'origin', origin], repo);
  ctx.git.run(['push', '-q', 'origin', 'main'], repo);
  ctx.git.run(['checkout', '-b', 'feature/my-change'], repo);
});

afterEach(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
});

describe('detectPrTool', () => {
  test('github and gitlab urls', () => {
    expect(pr.detectPrTool('git@github.com:acme/engine.git')).toBe('gh');
    expect(pr.detectPrTool('https://github.com/acme/engine.git')).toBe('gh');
    expect(pr.detectPrTool('git@gitlab.com:acme/engine.git')).toBe('glab');
    expect(pr.detectPrTool('https://gitlab.com/acme/engine.git')).toBe('glab');
  });

  test('unknown host returns null', () => {
    expect(pr.detectPrTool('/tmp/origin.git')).toBeNull();
    expect(pr.detectPrTool('git@gitlab.example.com:acme/engine.git')).toBeNull();
  });
});

describe('prCreateArgs', () => {
  test('gh uses base/head and body', () => {
    expect(pr.prCreateArgs('gh', 'title', 'body', 'origin/main', 'feature/x')).toEqual([
      'pr', 'create', '--title', 'title', '--body', 'body', '--base', 'main', '--head', 'feature/x',
    ]);
  });

  test('glab uses target-branch and description', () => {
    expect(pr.prCreateArgs('glab', 'title', 'body', 'origin/main', 'feature/x')).toEqual([
      'mr', 'create', '--title', 'title', '--description', 'body', '--target-branch', 'main',
    ]);
  });
});

describe('prTitle', () => {
  test('ticket prefix plus task first line', () => {
    const state = makeCompletedState({ task: 'Make preferred date optional\nSecond line ignored' });
    expect(pr.prTitle(state)).toBe('[DAPC-123] Make preferred date optional');
  });

  test('falls back to change id without task or ticket', () => {
    const state = makeCompletedState({ task: null, ticketNumber: null });
    expect(pr.prTitle(state)).toBe('my-change');
  });
});

describe('prBody', () => {
  test('includes change, ticket, task, and verification summary', () => {
    const state = makeCompletedState();
    const body = pr.prBody(state);
    expect(body).toContain('## Change\nmy-change');
    expect(body).toContain('## Ticket\nDAPC-123');
    expect(body).toContain('## Task\nMake preferred date optional');
    expect(body).toContain('Round 1 (lite)');
    expect(body).toContain('- quality-verifier: PASS');
    expect(body).not.toContain('- coordinator');
    expect(body).toContain('No advisory findings');
  });
});

describe('cmdCreatePr', () => {
  test('requires completed phase', () => {
    makeCompletedState({ phase: 'closed' });
    expect(() => pr.cmdCreatePr(ctx, { repo, change: 'my-change' })).toThrow(/requires completed phase/);
  });

  test('refuses second creation after prCreated', () => {
    makeCompletedState({ prCreated: true, prUrl: 'https://github.com/acme/engine/pull/1' });
    expect(() => pr.cmdCreatePr(ctx, { repo, change: 'my-change' })).toThrow(/already created/);
  });

  test('fails loudly on unknown remote host (no tool)', () => {
    makeCompletedState();
    // origin points at a local bare repo path, not github/gitlab.
    expect(() => pr.cmdCreatePr(ctx, { repo, change: 'my-change' })).toThrow(/cannot determine PR tool/);
    expect(stateMod.loadState(repo, 'my-change').prCreated).toBeUndefined();
  });
});
