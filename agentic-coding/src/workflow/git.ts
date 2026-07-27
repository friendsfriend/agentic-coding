// Git/ssh/branch helpers — the workflow's git-concern module (kept separate from
// orchestration and terminal layout, per R2's module boundaries).
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { Context } from './effects.ts';
import type { WorkflowState } from './state.ts';

export function ensureClean(ctx: Context, repo: string, requireOpenspec = true): void {
  if (ctx.git.run(['status', '--porcelain'], repo)) {
    throw new Error('working tree is dirty; commit or clean it first');
  }
  if (requireOpenspec && !fs.existsSync(path.join(repo, 'openspec', 'config.yaml'))) {
    throw new Error(`OpenSpec project not found: ${repo}/openspec/config.yaml`);
  }
}

export function ensureBaseFresh(ctx: Context, state: WorkflowState): void {
  const base = state.baseBranch ?? ctx.config.workflow.base_branch ?? 'origin/HEAD';
  let current: string;
  try {
    current = ctx.git.run(['rev-parse', '--verify', base], state.worktree);
  } catch {
    return; // legacy/local workflow without a tracked remote base
  }
  if (current !== state.baseCommit) {
    throw new Error(`base branch moved: ${base} is now ${current.slice(0, 12)}, workflow planned against ${(state.baseCommit ?? '').slice(0, 12)}; rebase/replan explicitly`);
  }
}

/** Add configured SSH identities to running agent without persisting secret. */
export function unlockSshKeys(ctx: Context, repo: string, remote: string, passphrase: string): void {
  if (!passphrase) return;
  const url = ctx.git.run(['remote', 'get-url', remote], repo);
  const match = /^ssh:\/\/(?:[^@/]+@)?([^/:]+)/.exec(url) ?? /^(?:[^@/:]+@)?([^/:]+)(?::|\/)/.exec(url);
  let identities: string[] = [];
  if (match) {
    const probe = Bun.spawnSync(['ssh', '-G', match[1]], { stdout: 'pipe', stderr: 'pipe' });
    const lines = probe.stdout.toString().split('\n');
    identities = lines
      .filter(line => line.startsWith('identityfile '))
      .map(line => line.split(/\s+/, 2)[1].replace(/^~/, os.homedir()))
      .filter(p => fs.existsSync(p) && fs.statSync(p).isFile());
  }
  const passphrasePath = path.join(os.tmpdir(), `herdr-ssh-passphrase-${process.pid}-${Date.now()}`);
  const scriptPath = path.join(os.tmpdir(), `herdr-ssh-askpass-${process.pid}-${Date.now()}`);
  try {
    fs.writeFileSync(passphrasePath, passphrase, { mode: 0o600 });
    fs.writeFileSync(scriptPath, `#!/bin/sh\ncat "${passphrasePath}"\n`, { mode: 0o700 });
    const env = { ...process.env, SSH_ASKPASS: scriptPath, SSH_ASKPASS_REQUIRE: 'force', DISPLAY: process.env.DISPLAY ?? ':0' };
    const result = Bun.spawnSync(['ssh-add', ...identities], { env, stdout: 'pipe', stderr: 'pipe' });
    if (result.exitCode !== 0) {
      const detail = (result.stderr.toString() || result.stdout.toString() || 'ssh-add failed').trim();
      throw new Error(`could not unlock SSH key: ${detail}`);
    }
  } finally {
    fs.rmSync(passphrasePath, { force: true });
    fs.rmSync(scriptPath, { force: true });
  }
}

export function remoteDefaultBranch(ctx: Context, repo: string, remote: string): string {
  ctx.git.run(['fetch', remote, '--prune'], repo);
  return ctx.git.run(['symbolic-ref', '--quiet', '--short', `refs/remotes/${remote}/HEAD`], repo);
}

export function ensureWorkflowBranch(ctx: Context, state: WorkflowState): void {
  const current = ctx.git.run(['branch', '--show-current'], state.worktree);
  if (current !== state.branch) {
    throw new Error(`wrong branch checked out: ${current || '(detached)'}; expected ${state.branch}. Switch to the workflow branch before commit/push.`);
  }
}
