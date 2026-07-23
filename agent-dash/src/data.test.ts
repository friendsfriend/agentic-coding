import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, test } from 'bun:test';
import { loadLocalChanges, loadLocalDiff, saveDeveloperReview, type DeveloperReviewComment } from './data';

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
