import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, test } from 'bun:test';
import { loadLocalChanges, loadLocalDiff, saveDeveloperReview, testDashboard, costSummary, costMessages, isStale, type DeveloperReviewComment } from '../../src/tui/dash/data';
import { startArgs } from '../../src/tui/dash/engine';

const roots: string[] = [];
const runGit = (repo: string, ...args: string[]) => execFileSync('git', args, { cwd: repo, stdio: 'pipe' }).toString().trim();

function fixture() {
  const repo = mkdtempSync(join(tmpdir(), 'agent-dash-data-'));
  roots.push(repo);
  runGit(repo, 'init', '-q');
  runGit(repo, 'config', 'user.email', 'test@example.com');
  runGit(repo, 'config', 'user.name', 'Test');
  writeFileSync(join(repo, 'tracked.ts'), 'const value = 1;\n');
  runGit(repo, 'add', 'tracked.ts');
  runGit(repo, 'commit', '-qm', 'initial');
  return repo;
}

function writeState(repo: string, change = 'review') {
  const stateDir = join(repo, '.herdr-workflow', change);
  mkdirSync(stateDir, { recursive: true });
  writeFileSync(join(stateDir, 'state.json'), JSON.stringify({ worktree: repo, baseCommit: 'HEAD' }));
  return stateDir;
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

test('loadLocalChanges includes tracked and untracked files, excluding workflow metadata', () => {
  const repo = fixture();
  writeState(repo);
  writeFileSync(join(repo, 'tracked.ts'), 'const value = 2;\n');
  writeFileSync(join(repo, 'new.ts'), 'export const added = true;\n');

  expect(loadLocalChanges(repo, 'review').map(change => change.newPath)).toEqual(['new.ts', 'tracked.ts']);
  expect(loadLocalChanges(repo, 'review').find(change => change.newPath === 'new.ts')).toMatchObject({ newFile: true, linesAdded: 1 });
});

test('loadLocalDiff returns tracked and untracked diffs, and rejects missing state', () => {
  const repo = fixture();
  writeState(repo);
  writeFileSync(join(repo, 'tracked.ts'), 'const value = 2;\n');
  writeFileSync(join(repo, 'new.ts'), 'export const added = true;\n');
  const changes = loadLocalChanges(repo, 'review');

  expect(loadLocalDiff(repo, 'review', changes.find(change => change.newPath === 'tracked.ts')!)).toContain('-const value = 1;');
  expect(loadLocalDiff(repo, 'review', changes.find(change => change.newPath === 'new.ts')!)).toContain('+export const added = true;');
  expect(() => loadLocalChanges(repo, 'missing')).toThrow();
});

test('saveDeveloperReview creates review directory and serializes comments', async () => {
  const repo = fixture();
  writeState(repo);
  const comments: DeveloperReviewComment[] = [{ filePath: 'tracked.ts', line: 2, body: 'Use const.' }];

  await saveDeveloperReview(repo, 'review', comments);

  expect(JSON.parse(readFileSync(join(repo, '.herdr-workflow', 'review', 'reviews', 'developer-review.json'), 'utf8'))).toEqual({ comments });
});

test('demo dashboard includes usability verifier', () => {
  expect(testDashboard('verify').agents.map(agent => agent.role)).toContain('usability-verifier');
});

test('startArgs maps quick workflow type to no-openspec and passes task through', () => {
  const args = startArgs({ repo: '.', ticket: '', change: 'quick-fix', task: 'Fix login\nand add coverage', mode: 'worktree', worker: 'test/worker', workflowType: 'quick' });

  expect(args.workflowType).toBe('no-openspec');
  expect(args.task).toBe('Fix login\nand add coverage');
});

test('costSummary aggregates model_usage rows per role and sorts by cost', () => {
  const rows = costSummary([
    { event: 'model_usage', role: 'worker', inputTokens: 100, outputTokens: 20, totalTokens: 120, cost: 0.1 },
    { event: 'model_usage', role: 'worker', inputTokens: 50, outputTokens: 10, totalTokens: 60, cost: 0.2 },
    { event: 'model_usage', role: 'planner', inputTokens: 30, outputTokens: 5, totalTokens: 35, cost: 0.05 },
    { event: 'pi_agent_start', role: 'worker' },
  ]);
  expect(rows.map(row => row.role)).toEqual(['worker', 'planner']);
  expect(rows[0]!.messages).toBe(2);
  expect(rows[0]!.inputTokens).toBe(150);
  expect(rows[0]!.outputTokens).toBe(30);
  expect(rows[0]!.totalTokens).toBe(180);
  expect(rows[0]!.cost).toBeCloseTo(0.3, 10);
  expect(rows[1]!.messages).toBe(1);
  expect(rows[1]!.cost).toBe(0.05);
});

test('costMessages returns per-message rows for one role oldest first', () => {
  const messages = costMessages(
    [
      { event: 'model_usage', role: 'worker', at: '2026-01-01T10:48:00Z', inputTokens: 1, outputTokens: 1, totalTokens: 2, cost: 0.01 },
      { event: 'model_usage', role: 'worker', at: '2026-01-01T10:44:00Z', inputTokens: 2, outputTokens: 2, totalTokens: 4, cost: 0.02 },
      { event: 'model_usage', role: 'planner', at: '2026-01-01T10:41:00Z', inputTokens: 9, outputTokens: 9, totalTokens: 18, cost: 0.09 },
    ],
    'worker',
  );
  expect(messages.map(message => message.at)).toEqual(['2026-01-01T10:44:00Z', '2026-01-01T10:48:00Z']);
  expect(messages[0]!.cost).toBe(0.02);
  expect(messages[1]!.inputTokens).toBe(1);
});

test('demo dashboard exposes cost breakdown', () => {
  const dashboard = testDashboard('verify');
  expect(dashboard.costBreakdown.map(row => row.role)).toEqual(['worker', 'planner', 'quality-verifier', 'security-verifier']);
  expect(dashboard.agents.find(agent => agent.role === 'worker')?.cost).toBe(0.42);
});

test('isStale flags long-running non-terminal phases', () => {
  const now = Date.parse('2026-01-01T12:00:00Z');
  expect(isStale({ phase: 'verify', phaseStartedAt: '2026-01-01T06:01:00Z' }, now)).toBe(false);
  expect(isStale({ phase: 'verify', phaseStartedAt: '2026-01-01T05:59:00Z' }, now)).toBe(true);
  expect(isStale({ phase: 'completed', phaseStartedAt: '2026-01-01T00:00:00Z' }, now)).toBe(false);
  expect(isStale({ phase: 'verify' }, now)).toBe(false);
});
