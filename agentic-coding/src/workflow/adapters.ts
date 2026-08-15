import fs from 'node:fs';
import path from 'node:path';
import type { AgentHandle, Assignment, ResolvedProfile, RuntimeId } from './contracts.ts';
import type { RenderedAssignment } from './assignment.ts';

export interface HerdrPort { call(...args: string[]): unknown }
export interface LaunchContext { profile: ResolvedProfile; assignment: Assignment; rendered: RenderedAssignment; paneId: string; tabId?: string; cwd: string; name: string; environment: Record<string, string>; bridgePath?: string }
export interface AgentObservation { status: 'idle' | 'working' | 'blocked' | 'done' | 'unknown'; paneId: string; sessionId?: string }
export interface AgentAdapter {
  readonly id: RuntimeId;
  preflight(profile: ResolvedProfile, requirements: readonly string[]): void;
  launch(ctx: LaunchContext): Promise<AgentHandle>;
  prompt(handle: AgentHandle, message: string): Promise<void>;
  observe(handle: AgentHandle): Promise<AgentObservation>;
  stop(handle: AgentHandle): Promise<void>;
}
function agent(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || !('agent' in value)) throw new Error('Herdr returned no agent');
  const item = (value as { agent: unknown }).agent; if (!item || typeof item !== 'object') throw new Error('Herdr returned invalid agent'); return item as Record<string, unknown>;
}
function requireExecutable(executable: string): string {
  const resolved = path.isAbsolute(executable) ? executable : Bun.which(executable);
  if (!resolved || !fs.existsSync(resolved)) throw new Error(`configured runtime executable not found: ${executable}`);
  return fs.realpathSync(resolved);
}
const SHELL_NAMES = new Set(['sh', 'bash', 'dash', 'zsh', 'fish', 'ksh', 'mksh', 'csh', 'tcsh', 'elvish', 'xonsh', 'nu', 'pwsh', 'powershell', 'cmd']);
export class HerdrLifecycle {
  constructor(private readonly herdr: HerdrPort, private readonly sleep: (ms: number) => Promise<void> = Bun.sleep) {}
  async waitForShell(paneId: string): Promise<void> {
    for (let attempt = 0; attempt < 50; attempt++) {
      const result = this.herdr.call('pane', 'process-info', '--pane', paneId) as { process_info?: { shell_pid?: number; foreground_process_group_id?: number; foreground_processes?: Array<{ name?: string; argv?: string[]; pid?: number }> } };
      const info = result.process_info; const foreground = info?.foreground_processes ?? [];
      // Match Herdr's Linux/macOS available-shell check. Linux can report zsh
      // alongside startup helpers; seeing zsh somewhere in that job is not ready.
      const foregroundName = String(foreground[0]?.name ?? foreground[0]?.argv?.[0] ?? '').split(/[\\/]/).at(-1)?.replace(/^-/, '').replace(/\.exe$/, '').toLowerCase();
      const shellIsForeground = typeof info?.shell_pid === 'number' && info.foreground_process_group_id === info.shell_pid && foreground.length === 1 && foreground[0]?.pid === info.shell_pid && SHELL_NAMES.has(foregroundName ?? '');
      if (shellIsForeground) return;
      await this.sleep(100);
    }
    throw new Error(`pane did not reach foreground shell: ${paneId}`);
  }
  async start(kind: 'pi' | 'opencode', ctx: LaunchContext, runtimeArgs: string[]): Promise<AgentHandle> {
    await this.waitForShell(ctx.paneId);
    // herdr 0.8.0 has no agent-level env flag and spawns agents through the pane
    // shell, so the run environment must be injected into the pane first. Source
    // a 0600 env file (secrets stay out of the terminal scrollback), then keep a
    // shell alive with the exported vars for `agent start` to inherit.
    const envFile = path.join(ctx.cwd, '.herdr-workflow', 'runtime-bin', ctx.assignment.runId, 'run.env');
    fs.mkdirSync(path.dirname(envFile), { recursive: true });
    const lines = Object.entries(ctx.environment).filter(([key]) => /^[A-Za-z_][A-Za-z0-9_]*$/.test(key)).map(([key, value]) => `${key}=${shQuote(value)}`);
    fs.writeFileSync(envFile, `${lines.join('\n')}\n`, { mode: 0o600 });
    // pane run is asynchronous and waitForShell cannot tell the pre-injection
    // shell from the exec'd one; a marker touched after sourcing proves the
    // env landed before `agent start` inherits it.
    const marker = `${envFile}.done`; fs.rmSync(marker, { force: true });
    this.herdr.call('pane', 'run', ctx.paneId, `set -a; . ${shQuote(envFile)}; set +a; touch ${shQuote(marker)}; exec "${'$'}{SHELL:-sh}"`);
    for (let attempt = 0; attempt < 50 && !fs.existsSync(marker); attempt++) await this.sleep(100);
    if (!fs.existsSync(marker)) throw new Error(`run environment injection did not land in pane: ${ctx.paneId}`);
    await this.waitForShell(ctx.paneId);
    const invoke = () => this.herdr.call('agent', 'start', ctx.name, '--kind', kind, '--pane', ctx.paneId, '--', ...runtimeArgs);
    let result: unknown;
    try { result = invoke() } catch (error) {
      if (!String((error as Error).message).includes('not an available shell')) throw error;
      await this.sleep(250); await this.waitForShell(ctx.paneId); result = invoke();
    }
    const started = agent(result); const paneId = String(started.pane_id ?? ctx.paneId);
    const live = agent(this.herdr.call('agent', 'get', paneId)); if (String(live.pane_id) !== paneId) throw new Error(`agent get mismatch for ${paneId}`);
    this.herdr.call('agent', 'prompt', paneId, ctx.rendered.prompt);
    return { runtime: ctx.profile.runtime, name: ctx.name, paneId, ...(live.tab_id ? { tabId: String(live.tab_id) } : {}), ...(live.session_id ? { sessionId: String(live.session_id) } : {}) };
  }
  async prompt(handle: AgentHandle, message: string): Promise<void> { agent(this.herdr.call('agent', 'get', handle.paneId)); this.herdr.call('agent', 'prompt', handle.paneId, message) }
  async observe(handle: AgentHandle): Promise<AgentObservation> { const live = agent(this.herdr.call('agent', 'get', handle.paneId)); const observed = String(live.agent_status ?? 'unknown'); const status = ['idle', 'working', 'blocked', 'done'].includes(observed) ? observed as AgentObservation['status'] : 'unknown'; return { status, paneId: handle.paneId, ...(live.session_id ? { sessionId: String(live.session_id) } : {}) } }
  async stop(handle: AgentHandle): Promise<void> { this.herdr.call('pane', 'close', handle.paneId) }
}
abstract class BaseAdapter implements AgentAdapter {
  abstract readonly id: RuntimeId;
  constructor(protected readonly lifecycle: HerdrLifecycle) {}
  preflight(profile: ResolvedProfile, requirements: readonly string[]): void { if (profile.runtime !== this.id) throw new Error(`profile runtime ${profile.runtime} routed to ${this.id}`); requireExecutable(profile.executable); const missing = requirements.filter(requirement => requirement !== 'read-only' && !profile.capabilities.includes(requirement as never)); if (missing.length) throw new Error(`${this.id} lacks required policy: ${missing.join(', ')}`) }
  abstract launch(ctx: LaunchContext): Promise<AgentHandle>;
  prompt(handle: AgentHandle, message: string) { return this.lifecycle.prompt(handle, message) }
  observe(handle: AgentHandle) { return this.lifecycle.observe(handle) }
  stop(handle: AgentHandle) { return this.lifecycle.stop(handle) }
}
export class PiAdapter extends BaseAdapter {
  readonly id = 'pi' as const;
  async launch(ctx: LaunchContext): Promise<AgentHandle> {
    const args = ['--name', ctx.name, '--no-prompt-templates']; if (ctx.profile.model) args.push('--model', ctx.profile.model); if (ctx.profile.thinking) args.push('--thinking', ctx.profile.thinking); if (ctx.profile.tools.length) args.push('--tools', ctx.profile.tools.join(','));
    if (ctx.profile.readOnly || ctx.profile.extensions.length === 0) args.push('--no-extensions'); for (const extension of ctx.profile.extensions) args.push('--extension', extension); if (ctx.bridgePath) args.push('--extension', ctx.bridgePath);
    return this.lifecycle.start('pi', withRuntimeLauncher(ctx, 'pi'), args);
  }
}
export class OpenCodeAdapter extends BaseAdapter {
  readonly id = 'opencode' as const;
  async launch(ctx: LaunchContext): Promise<AgentHandle> { const args: string[] = []; if (ctx.profile.model) args.push('--model', ctx.profile.model); if (ctx.profile.agent) args.push('--agent', ctx.profile.agent); return this.lifecycle.start('opencode', withOpenCodeLauncher(isolatedOpenCode(ctx)), args) }
}
function isolatedOpenCode(ctx: LaunchContext): LaunchContext { const directory = path.join(ctx.cwd, '.herdr-workflow', 'runtime-config', ctx.assignment.runId); fs.mkdirSync(directory, { recursive: true }); fs.writeFileSync(path.join(directory, 'opencode.json'), JSON.stringify({ permission: ctx.profile.readOnly ? { edit: 'deny', bash: 'allow', read: 'allow' } : { edit: 'allow', bash: 'allow', read: 'allow' }, plugin: ctx.bridgePath ? [ctx.bridgePath] : [] }, null, 2)); return { ...ctx, environment: { ...ctx.environment, XDG_CONFIG_HOME: directory } } }
function withOpenCodeLauncher(ctx: LaunchContext): LaunchContext { return withRuntimeLauncher(ctx, 'opencode') }
function shQuote(value: string): string { return `'${value.replace(/'/g, `'\\''`)}'` }
function withRuntimeLauncher(ctx: LaunchContext, name: 'pi' | 'opencode'): LaunchContext { const target = requireExecutable(ctx.profile.executable); const directory = path.join(ctx.cwd, '.herdr-workflow', 'runtime-bin', ctx.assignment.runId); fs.mkdirSync(directory, { recursive: true }); const launcher = path.join(directory, name); const environment = { ...ctx.environment, PATH: `${directory}:${process.env.PATH ?? ''}` }; const exports = Object.entries(environment).filter(([key]) => /^[A-Za-z_][A-Za-z0-9_]*$/.test(key)).map(([key, value]) => `export ${key}=${shQuote(value)}`).join('\n'); const content = `#!/bin/sh\n${exports}\nexec ${JSON.stringify(target)} "$@"\n`; if (!fs.existsSync(launcher) || fs.readFileSync(launcher, 'utf8') !== content) { fs.writeFileSync(launcher, content, { mode: 0o700 }); fs.chmodSync(launcher, 0o700) } return { ...ctx, environment } }

export class OpenCodeV2Adapter extends BaseAdapter {
  readonly id = 'opencode-v2' as const;
  async launch(ctx: LaunchContext): Promise<AgentHandle> {
    const args: string[] = []; if (ctx.profile.model) args.push('--model', ctx.profile.model); if (ctx.profile.agent) args.push('--agent', ctx.profile.agent);
    return this.lifecycle.start('opencode', withOpenCodeLauncher(isolatedOpenCode(ctx)), args);
  }
}
