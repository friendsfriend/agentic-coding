// Test doubles for the Herdr/Git/Clock/TraceExporter seams, plus a tmp-repo helper.
//
// ponytail: real git in a tmp dir beats mocking diff output; upgrade to a pure
// fake only if git-in-CI proves flaky.
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import type { Context } from '../src/workflow/effects.ts';

export const DEFAULT_CONFIG = {
  models: {
    worker_default: 'test/worker',
    verifier: 'test/verifier',
    usability_verifier: 'test/usability',
    verifier_fallback: 'test/verifier-fallback',
    archive: 'test/archive',
    git: 'test/git',
    planner: 'test/planner',
    triage: 'test/triage',
    recovery: 'test/recovery',
  },
  thinking: {
    worker_default: 'high',
    verifier: 'high',
    verifier_lite: 'medium',
    planner: 'high',
    triage: 'high',
    recovery: 'high',
    archive: 'high',
  },
  workflow: {
    max_verification_rounds: 6,
    remote: 'origin',
    branch_prefix: 'feature/',
    base_branch: 'origin/HEAD',
    worktree_directory: '~/.herdr/worktrees',
  },
  projects: { root: '~/development', max_depth: 3 },
  telemetry: { capture_content: false },
  ui: { theme: 'catppuccin', selection_height: 10 },
  plugins: {},
};

type Predicate = (args: string[]) => boolean;
type Handler = (args: string[]) => any;

/**
 * Records every call(...args); returns scripted or generated responses.
 *
 * Agent state is tracked by pane_id (the source of truth), matching the real
 * herdr API where `wait agent-status`, `pane run`, and `pane send-keys` all
 * target a pane_id and `agent get` has no sequence counter — only `agent_status`.
 * `agent get <name>` resolves name -> pane_id via the `agent rename` mapping,
 * exactly as production code relies on.
 */
export class FakeHerdr {
  calls: string[][] = [];
  private paneToAgent = new Map<string, string>();
  private agentToPane = new Map<string, string>();
  private paneToTab = new Map<string, string>();
  private paneStatus = new Map<string, string>();
  private tabSeq = 0;
  private paneSeq = 0;
  private handlers: Array<[Predicate, Handler]> = [];
  private afterHooks: Array<[Predicate, (args: string[]) => void]> = [];
  // Default: `pane run` settles the target pane into the status a real submission
  // would reach. Tests exercising verification/failure paths set this false and
  // script transitions explicitly via `.after(...)`.
  autoAdvanceOnSubmit = true;

  on(predicate: Predicate, handler: Handler): void {
    this.handlers.push([predicate, handler]);
  }

  after(predicate: Predicate, effect: (args: string[]) => void): void {
    this.afterHooks.push([predicate, effect]);
  }

  registerPane(paneId: string, name: string, tabId?: string): void {
    this.paneToAgent.set(paneId, name);
    this.agentToPane.set(name, paneId);
    if (tabId) this.paneToTab.set(paneId, tabId);
  }

  setAgent(name: string, options: { paneId?: string; agentStatus?: string } = {}): void {
    if (options.paneId) this.registerPane(options.paneId, name);
    const targetPane = options.paneId ?? this.agentToPane.get(name);
    if (options.agentStatus !== undefined && targetPane) this.paneStatus.set(targetPane, options.agentStatus);
  }

  setStatus(paneIdOrName: string, status: string): void {
    const paneId = this.agentToPane.get(paneIdOrName) ?? paneIdOrName;
    this.paneStatus.set(paneId, status);
  }

  get paneToTabMap(): Map<string, string> {
    return this.paneToTab;
  }

  call(...args: string[]): any {
    this.calls.push(args);
    let result: any;
    let matched = false;
    for (const [predicate, handler] of this.handlers) {
      if (predicate(args)) {
        result = handler(args);
        matched = true;
        break;
      }
    }
    if (!matched) result = this.default(args);
    for (const [predicate, effect] of this.afterHooks) {
      if (predicate(args)) effect(args);
    }
    return result;
  }

  private default(args: string[]): any {
    if (args[0] === 'tab' && args[1] === 'create') {
      this.tabSeq += 1;
      this.paneSeq += 1;
      const tabId = `tab-${this.tabSeq}`;
      const paneId = `pane-${this.paneSeq}`;
      this.paneToTab.set(paneId, tabId);
      return { root_pane: { pane_id: paneId, tab_id: tabId }, tab: { tab_id: tabId } };
    }
    if (args[0] === 'pane' && args[1] === 'split') {
      this.paneSeq += 1;
      const paneId = `pane-${this.paneSeq}`;
      this.paneToTab.set(paneId, this.paneToTab.get(args[2])!);
      return { pane: { pane_id: paneId, tab_id: this.paneToTab.get(paneId) } };
    }
    if (args[0] === 'agent' && args[1] === 'start') {
      const name = args[2];
      const paneId = args[args.indexOf('--pane') + 1];
      const tabId = this.paneToTab.get(paneId);
      this.registerPane(paneId, name, tabId);
      this.paneStatus.set(paneId, 'idle');
      return { agent: { pane_id: paneId, tab_id: tabId, name, agent_status: 'idle' } };
    }
    if (args[0] === 'agent' && args[1] === 'prompt') {
      const target = args[2];
      const paneId = this.paneToAgent.has(target) || this.paneStatus.has(target) ? target : this.agentToPane.get(target);
      if (paneId == null) throw new Error(`agent not found: ${target}`);
      if (this.autoAdvanceOnSubmit) this.paneStatus.set(paneId, 'working');
      return { agent: { pane_id: paneId, agent_status: this.paneStatus.get(paneId) ?? 'working' } };
    }
    if (args[0] === 'agent' && args[1] === 'rename') {
      this.registerPane(args[2], args[3]);
      return {};
    }
    if (args[0] === 'pane' && args[1] === 'get') {
      return { pane: { pane_id: args[2], tab_id: this.paneToTab.get(args[2]) } };
    }
    if (args[0] === 'pane' && args[1] === 'process-info') {
      return { process_info: { foreground_processes: [{ name: 'zsh' }] } };
    }
    if (args[0] === 'pane' && args[1] === 'read') {
      return { read: { text: '❯ ' } };
    }
    if (args[0] === 'pane' && args[1] === 'run') {
      const paneId = args[2];
      if (this.autoAdvanceOnSubmit) {
        // First `pane run` on a pane is the pi launch (settles to idle once
        // booted); any later one is a prompt on an already-running agent
        // (settles to working).
        this.paneStatus.set(paneId, this.paneStatus.has(paneId) ? 'working' : 'idle');
      }
      return {};
    }
    if ((args[0] === 'pane' && (args[1] === 'close' || args[1] === 'send-keys')) || (args[0] === 'notification' && args[1] === 'show')) {
      return {};
    }
    if (args[0] === 'agent' && args[1] === 'get') {
      const target = args[2];
      const paneId = this.paneToAgent.has(target) || this.paneStatus.has(target) ? target : this.agentToPane.get(target);
      if (paneId == null) throw new Error(`agent not found: ${target}`);
      return { agent: { agent_status: this.paneStatus.get(paneId) ?? 'idle', pane_id: paneId, tab_id: this.paneToTab.get(paneId) } };
    }
    if (args[0] === 'wait' && args[1] === 'agent-status') {
      const paneId = args[2];
      const wanted = args[args.indexOf('--status') + 1];
      if ((this.paneStatus.get(paneId) ?? 'idle') === wanted) return {};
      throw new Error('timed out waiting for agent status change');
    }
    if (args[0] === 'wait') return {};
    return {};
  }
}

/** Backed by a real temp git repo — cheapest correct option for diff/numstat parsing. */
export class FakeGit {
  run(args: string[], cwd: string): string {
    try {
      return execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
    } catch (error: any) {
      const detail = (error.stderr?.toString() || error.stdout?.toString() || 'command failed').trim();
      throw new Error(`git ${args.join(' ')}: ${detail}`);
    }
  }
}

/** Fixed/monotone: `sleep` advances virtual time so timeout logic is deterministic and fast. */
export class FakeClock {
  private currentNow: Date;
  private monotonicSeconds: number;
  private timeSeconds: number;

  constructor(start = 1_700_000_000.0) {
    this.currentNow = new Date('2024-01-01T00:00:00Z');
    this.monotonicSeconds = start;
    this.timeSeconds = start;
  }

  now(): Date {
    return this.currentNow;
  }

  monotonic(): number {
    return this.monotonicSeconds;
  }

  time(): number {
    return this.timeSeconds;
  }

  timeNs(): bigint {
    return BigInt(Math.round(this.timeSeconds * 1_000_000_000));
  }

  async sleep(seconds: number): Promise<void> {
    this.advance(seconds);
  }

  advance(seconds: number): void {
    this.monotonicSeconds += seconds;
    this.timeSeconds += seconds;
    this.currentNow = new Date(this.currentNow.getTime() + seconds * 1000);
  }
}

export class NoopExporter {
  export(_record: unknown): void {
    /* no-op */
  }
}

export function makeContext(overrides: Partial<Context> = {}): Context {
  return {
    config: overrides.config ?? structuredClone(DEFAULT_CONFIG),
    herdr: overrides.herdr ?? new FakeHerdr(),
    git: overrides.git ?? new FakeGit(),
    clock: overrides.clock ?? new FakeClock(),
    exporter: overrides.exporter ?? new NoopExporter(),
  };
}

/** Init a git repo with an OpenSpec project and one committed base file. */
export function initRepo(dir: string): string {
  fs.mkdirSync(dir, { recursive: true });
  const run = (...args: string[]) => execFileSync('git', args, { cwd: dir, encoding: 'utf8' });
  run('init', '-q', '-b', 'main');
  run('config', 'user.email', 'test@example.com');
  run('config', 'user.name', 'Test');
  fs.mkdirSync(path.join(dir, 'openspec'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'openspec', 'config.yaml'), 'name: test\n');
  fs.writeFileSync(path.join(dir, 'README.md'), '# test\n');
  run('add', '-A');
  run('commit', '-q', '-m', 'base');
  fs.mkdirSync(path.join(dir, '.git', 'info'), { recursive: true });
  fs.writeFileSync(path.join(dir, '.git', 'info', 'exclude'), '\n.herdr-workflow/\n');
  return dir;
}
