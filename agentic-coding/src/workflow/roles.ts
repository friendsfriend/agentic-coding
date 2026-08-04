// Role lifecycle: launch, prompt, start. Terminal layout, prompt building, and
// telemetry concerns live in their own modules (layout.ts, prompts.ts,
// telemetry.ts) — this module only decides whether a role's agent pane exists
// and how to (re)start it.
import fs from 'node:fs';
import path from 'node:path';
import { ensureWorkflowAgentDefinitions } from './bootstrap.ts';
import type { Context } from './effects.ts';
import * as layout from './layout.ts';
import * as naming from './naming.ts';
import * as paths from './paths.ts';
import * as prompts from './prompts.ts';
import * as stateMod from './state.ts';
import type { WorkflowState } from './state.ts';
import * as telemetry from './telemetry.ts';

function providerUnhealthy(ctx: Context, model: string | undefined): boolean {
  if (!model) return false;
  const p = path.join(paths.AGENT_DIR, 'herdr-provider-health.json');
  if (!fs.existsSync(p)) return false;
  try {
    const health = JSON.parse(fs.readFileSync(p, 'utf8'))[model.split('/', 1)[0]] ?? {};
    const last = new Date(health.lastFailure ?? '1970-01-01T00:00:00+00:00');
    return (health.failures ?? 0) >= 3 && (ctx.clock.now().getTime() - last.getTime()) / 1000 < 120;
  } catch {
    return false;
  }
}

export function roleAgentName(state: WorkflowState, role: string): string {
  return naming.agentName(state.changeId, role);
}

export async function launchRole(ctx: Context, state: WorkflowState, role: string, text?: string): Promise<void> {
  const config = ctx.config;
  const models = config.models;
  const thinking = config.thinking;
  let model: string | undefined = role === 'worker'
    ? state.workerModel ?? undefined
    : role.endsWith('-verifier')
      ? (models[role.replace(/-/g, '_')] ?? models.verifier)
      : (models[role] ?? models.archive ?? models.verifier);
  const level: string | undefined = role === 'worker'
    ? thinking.worker_default
    : role.endsWith('-verifier')
      ? (state.verificationTier === 'lite' ? thinking.verifier_lite : thinking.verifier)
      : (thinking[role] ?? thinking.archive ?? thinking.verifier);
  if (role.endsWith('-verifier') && model && providerUnhealthy(ctx, model) && models.verifier_fallback) {
    telemetry.telemetry(ctx, state, 'provider_circuit_open', { role, model, fallback: models.verifier_fallback });
    model = models.verifier_fallback;
  }
  const change = state.changeId;
  // Per-workflow injection: agents of this workflow reference skills/extensions
  // materialized into its own .herdr-workflow dir (compiled binaries); source
  // runs and HERDR_AGENT_DEF_DIR overrides use the shared definitions.
  const agentDefDir = ensureWorkflowAgentDefinitions(state.worktree, change);

  const spawn = async (spawnModel: string | undefined): Promise<void> => {
    layout.closeOldPane(ctx, state, role);
    const label = layout.launchLabel(role);
    const instructions = text ?? prompts.rolePrompt(role, change, state.verificationRound, state.workflowType, state.task);
    const placement = layout.placeLaunchPane(ctx, state, role, state.workspace, state.worktree, change);
    const { targetTab, launchPane, createdTab, usedSpare, createdSparePane } = placement;

    ctx.herdr.call('pane', 'rename', launchPane, role);
    await layout.waitForPaneReady(ctx, launchPane);
    telemetry.writeTraceHandoff(ctx, state, role);

    const cleanup = (): void => {
      if (createdTab) ctx.herdr.call('tab', 'close', targetTab);
      else if (!usedSpare) ctx.herdr.call('pane', 'close', launchPane);
      if (createdSparePane) ctx.herdr.call('pane', 'close', createdSparePane);
    };

    const startAgent = (name: string) =>
      ctx.herdr.call(
        'agent', 'start', name, '--kind', 'pi', '--pane', launchPane, '--timeout', '60000',
        '--', ...prompts.piArguments(role, spawnModel, level, change, config, agentDefDir, name),
      );
    const launchFailed = (error: unknown): never => {
      telemetry.telemetry(ctx, state, 'agent_launch_failed', { role, model: spawnModel, error: String((error as Error)?.message ?? error), spanStatus: 'ERROR' });
      cleanup();
      throw error;
    };

    const name = naming.agentName(change, role);
    let agent: any;
    let launchError: unknown;
    try {
      agent = startAgent(name).agent;
    } catch (error) {
      launchError = error;
      if (String((error as Error)?.message ?? error).includes('not an available shell')) {
        await ctx.clock.sleep(0.25);
        try {
          agent = startAgent(name).agent;
        } catch (retryError) {
          launchError = retryError;
        }
      }
    }
    if (!agent) launchFailed(launchError);
    const paneId = agent.pane_id;
    const tabId = agent.tab_id ?? targetTab;
    try {
      const live = ctx.herdr.call('agent', 'get', paneId).agent;
      if (!live || live.pane_id !== paneId || !['idle', 'working', 'blocked', 'done'].includes(live.agent_status)) {
        throw new Error(`pi agent did not become ready on pane ${paneId}`);
      }
      ctx.herdr.call('agent', 'prompt', paneId, `/skill:herdr-openspec-${role} ${instructions}`);
    } catch (error) {
      launchFailed(error);
    }
    ctx.herdr.call('tab', 'rename', tabId, label);
    state.panes = { ...(state.panes ?? {}), [role]: paneId };
    state.tabs = { ...(state.tabs ?? {}), [role]: tabId };
    layout.recordVerificationPlacement(state, role, placement, tabId);
    stateMod.saveState(state);
  };

  await spawn(model);

  state.verificationModels = { ...(state.verificationModels ?? {}), [role]: model };
  if (role.endsWith('-verifier')) {
    state.verificationRoleStartedAt = { ...(state.verificationRoleStartedAt ?? {}), [role]: ctx.clock.now().toISOString() };
  }
  stateMod.saveState(state);
}

/** Submit a follow-up to the live Pi agent, keeping its session and prior-round context. */
export function promptRole(ctx: Context, state: WorkflowState, role: string, text?: string): void {
  if (!(role in (state.panes ?? {}))) throw new Error(`no pane for role ${role} in promptRole`);
  const instructions = text ?? prompts.rolePrompt(role, state.changeId, state.verificationRound, state.workflowType, state.task);
  telemetry.writeTraceHandoff(ctx, state, role);
  ctx.herdr.call('agent', 'prompt', state.panes[role], instructions);
}

export async function startRole(ctx: Context, state: WorkflowState, role: string, text?: string): Promise<void> {
  const verificationTab = (state.tabs ?? {}).verification;
  if (layout.VERIFICATION_TAB_ROLES.includes(role) && (!verificationTab || (state.tabs ?? {})[role] !== verificationTab)) {
    await launchRole(ctx, state, role, text);
    return;
  }
  if (layout.hasRolePane(state, role)) {
    let agent: any;
    try {
      agent = ctx.herdr.call('agent', 'get', state.panes[role]).agent;
    } catch {
      await launchRole(ctx, state, role, text);
      return;
    }
    if (agent?.pane_id === state.panes[role] && ['idle', 'working', 'blocked', 'done'].includes(agent.agent_status)) {
      if (agent.tab_id && (state.tabs ?? {})[role] !== agent.tab_id) {
        state.tabs = { ...(state.tabs ?? {}), [role]: agent.tab_id };
        stateMod.saveState(state);
      }
      promptRole(ctx, state, role, text);
      return;
    }
  }
  await launchRole(ctx, state, role, text);
}
