import { describe, expect, test } from 'bun:test';
import { AGENT_EXTENSION_SUBCOMMANDS, REQUIRED_FLAGS, SUBCOMMANDS, cliTest, run } from '../src/workflow/cli.ts';

describe('breaking workflow CLI surface', () => {
  test('exports only typed lifecycle commands', () => {
    expect(SUBCOMMANDS).toEqual(['start', 'status', 'action', 'handoff', 'repair', 'projects', 'config', 'agent-extension']);
    for (const removed of ['planner', 'apply', 'verify', 'dispatch-verifiers', 'verification-result', 'finish-review', 'archive', 'git-operations', 'phase', 'override-phase', 'message', 'plugin']) expect(SUBCOMMANDS).not.toContain(removed as never);
    expect(AGENT_EXTENSION_SUBCOMMANDS).toEqual(['list', 'install', 'install-local']);
    expect(REQUIRED_FLAGS.action).toEqual(['repo', 'change', 'revision']);
  });
  test('help needs no config, database, or runtime', async () => {
    const lines: string[] = []; const original = console.log; console.log = value => lines.push(String(value)); try { await run([]); for (const command of SUBCOMMANDS) await run([command, '--help']) } finally { console.log = original }
    expect(lines.join('\n')).toContain('agent-extension'); expect(lines.join('\n')).toContain('handoff --outcome');
  });
  test('mode and action positionals fail at CLI boundary', async () => { expect(cliTest.parseMode('checkout')).toBe('checkout'); expect(() => cliTest.parseMode('typo')).toThrow('--mode must be worktree or checkout'); await expect(run(['action', '--repo', '.', '--change', 'x', '--revision', '1'])).rejects.toThrow('ACTION_ID is required'); await expect(run(['action', 'approve-plan', 'extra', '--repo', '.', '--change', 'x', '--revision', '1'])).rejects.toThrow('unexpected positional argument'); await expect(run(['start', '--repo', '.', '--change', 'x', '--mode', 'checkout', '--tiket', '42'])).rejects.toThrow('unknown flag --tiket'); await expect(run(['status', '--repo', '.', '--repo', '.', '--change', 'x'])).rejects.toThrow('duplicate flag --repo') });
  test('detached drain argv works in source-tree and compiled runners', () => { const source = cliTest.detachedDrainArgv('/abs/src/cli.ts', '/repo', 'c1'); expect(source[0]).toBe(process.execPath); expect(source.slice(1)).toEqual(['/abs/src/cli.ts', 'workflow', 'status', '--repo', '/repo', '--change', 'c1']); const compiled = cliTest.detachedDrainArgv(undefined, '/repo', 'c1'); expect(compiled.slice(1)).toEqual(['workflow', 'status', '--repo', '/repo', '--change', 'c1']); expect(compiled[0]).toBe(process.execPath) });
  test('legacy command is rejected without translation', async () => { await expect(run(['verify', '--repo', '.', '--change', 'x'])).rejects.toThrow('unknown command: verify') });
});
