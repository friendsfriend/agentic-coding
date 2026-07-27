// Locks the frozen external contract: CLI subcommand surface + state.json field shape.
//
// Runs against the final package (cli.ts + orchestration.ts), not the pre-port
// Python monolith — this test encodes the same contract the Python
// `test_characterization.py` captured, so any future drift in subcommand
// names/flags or the `start`-produced state.json shape fails loudly here rather
// than silently breaking the dashboard.
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, test } from 'bun:test';
import * as orchestration from '../src/workflow/orchestration.ts';
import * as cli from '../src/workflow/cli.ts';
import { FakeClock, FakeHerdr, initRepo, makeContext } from './fakes.ts';

const EXPECTED_SUBCOMMANDS = new Set([
  'projects', 'config', 'start', 'planner', 'apply', 'verify',
  'dispatch-verifiers', 'archive', 'close', 'status',
  'git-operations', 'phase', 'override-phase',
  'preflight-archive', 'set-return', 'verification-result', 'message', 'plugin',
  'finish-review',
]);

const EXPECTED_REQUIRED_FLAGS: Record<string, Set<string>> = {
  start: new Set(['repo', 'change', 'mode']),
  planner: new Set(['repo', 'change']),
  apply: new Set(['repo', 'change']),
  verify: new Set(['repo', 'change']),
  'dispatch-verifiers': new Set(['repo', 'change']),
  archive: new Set(['repo', 'change']),
  close: new Set(['repo', 'change']),
  status: new Set(['repo', 'change']),
  'git-operations': new Set(['repo', 'change']),
  phase: new Set(['repo', 'change']),
  'override-phase': new Set(['repo', 'change']),
  'preflight-archive': new Set(['repo', 'change']),
  'set-return': new Set(['repo', 'change', 'workspace']),
  'verification-result': new Set(['repo', 'change', 'role']),
  message: new Set(['repo', 'change', 'sender', 'target']),
};

// state.json fields the dashboard's WorkflowState reads (see design.md contract #2)
const EXPECTED_STATE_FIELDS = new Set([
  'changeId', 'phase', 'repository', 'worktree', 'branch',
  'workspace', 'task', 'ticketNumber', 'workerModel', 'verificationRound',
  'returnWorkspace', 'baseBranch', 'baseCommit', 'developerApproval', 'panes',
  'tabs', 'workflowModules', 'workflowType', 'createdAt', 'otelTraceRoot',
  'otelTraceRootStartedUnixNano', 'verificationModels',
]);

describe('subcommand surface', () => {
  test('subcommand names unchanged', () => {
    expect(new Set<string>(cli.SUBCOMMANDS)).toEqual(EXPECTED_SUBCOMMANDS);
  });

  test('required flags unchanged', () => {
    for (const [name, expected] of Object.entries(EXPECTED_REQUIRED_FLAGS)) {
      expect(new Set(cli.REQUIRED_FLAGS[name] ?? [])).toEqual(expected);
    }
  });

  test('plugin subcommands unchanged', () => {
    expect(new Set<string>(cli.PLUGIN_SUBCOMMANDS)).toEqual(new Set(['list', 'install', 'install-local']));
  });
});

describe('golden state shape', () => {
  test("start produces expected state shape", async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'workflow-characterization-'));
    try {
      const repo = initRepo(path.join(tmp, 'repo'));
      const bare = path.join(tmp, 'origin.git');
      execFileSync('git', ['init', '--bare', '-q', '-b', 'main', bare]);
      execFileSync('git', ['remote', 'add', 'origin', bare], { cwd: repo });
      execFileSync('git', ['push', '-q', 'origin', 'main'], { cwd: repo });
      execFileSync('git', ['remote', 'set-head', 'origin', 'main'], { cwd: repo });
      const herdr = new FakeHerdr();
      const ctx = makeContext({ herdr, clock: new FakeClock() });

      herdr.on(
        args => args[0] === 'workspace' && args[1] === 'create',
        () => ({ workspace: { workspace_id: 'ws-1' }, root_pane: { pane_id: 'pane-root' } }),
      );
      herdr.on(
        args => args[0] === 'tab' && args[1] === 'list',
        () => ({ tabs: [{ tab_id: 'tab-dashboard' }] }),
      );

      await orchestration.cmdStart(ctx, { repo, change: 'golden-change', task: 'do it', mode: 'checkout', ticket: null, worker: undefined, workflowType: 'standard' });

      const state = JSON.parse(fs.readFileSync(path.join(repo, '.herdr-workflow', 'golden-change', 'state.json'), 'utf8'));
      expect(new Set(Object.keys(state))).toEqual(EXPECTED_STATE_FIELDS);
      expect(state.changeId).toBe('golden-change');
      expect(state.phase).toBe('explore');
      expect(typeof state.panes).toBe('object');
      expect(typeof state.tabs).toBe('object');

      await orchestration.cmdStart(ctx, { repo, change: 'quick-change', task: null, mode: 'checkout', ticket: null, worker: undefined, workflowType: 'no-openspec' });
      expect(fs.existsSync(path.join(repo, '.herdr-workflow', 'quick-change', 'request.md'))).toBe(false);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });
});
