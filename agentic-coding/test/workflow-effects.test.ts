import { expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { Database } from 'bun:sqlite';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { AgentAdapter, AgentObservation, LaunchContext } from '../src/workflow/adapters.ts';
import type { AgentHandle } from '../src/workflow/contracts.ts';
import { agentEffectHandlers, EffectRunner, effectRunnerTest } from '../src/workflow/effect-runner.ts';
import { registerBuiltins } from '../src/workflow/definitions.ts';
import { canonicalStorePath, WorkflowEngine } from '../src/workflow/runtime.ts';
import { cliTest } from '../src/workflow/cli.ts';

class Adapter implements AgentAdapter {
  readonly id = 'pi' as const;
  launches = 0; stops = 0; context?: LaunchContext;
  preflight() {}
  async launch(ctx: LaunchContext): Promise<AgentHandle> { this.launches++; this.context = ctx; return { runtime: 'pi', name: ctx.name, paneId: ctx.paneId } }
  async prompt() {}
  async observe(handle: AgentHandle): Promise<AgentObservation> { return { status: 'working', paneId: handle.paneId } }
  async stop() { this.stops++ }
}

test('runner drains workspace and agent effects, then stops stale run after repair', async () => {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'workflow-effects-'));
  try {
    execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: repo }); fs.writeFileSync(path.join(repo, 'README.md'), 'x\n'); execFileSync('git', ['add', '.'], { cwd: repo }); execFileSync('git', ['-c', 'user.email=test@example.com', '-c', 'user.name=Test', 'commit', '-qm', 'base'], { cwd: repo });
    const registry = registerBuiltins(); const engine = new WorkflowEngine(registry); const adapter = new Adapter();
    const started = engine.start({ repo, mode: 'checkout', changeId: 'effects', definitionId: 'no-openspec', metadata: { branch: 'feature/effects', baseBranch: 'main', baseCommit: execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repo, encoding: 'utf8' }).trim(), task: 'task' }, routing: { defaultProfile: 'pi', routes: [{ stepId: 'core.implementation', role: 'worker', profile: { name: 'pi', runtime: 'pi', executable: 'sh', tools: [], extensions: [], readOnly: false, capabilities: ['prompt', 'run-environment', 'observe'], digest: 'profile' } }], diversity: [] } });
    expect(started.view.runs).toHaveLength(0); expect(started.view.effects.map(item => item.kind)).toEqual(['workspace.setup']);
    const herdr = { call(...args: string[]) { if (args[0] === 'tab' && args[1] === 'list') return { tabs: [{ tab_id: 'tab1', label: 'dashboard' }] }; if (args[0] === 'workspace' && args[1] === 'create') return { workspace: { workspace_id: 'workspace' } }; throw new Error(`unexpected ${args.join(' ')}`) } };
    const handlers = agentEffectHandlers(repo, engine, { registry, adapters: new Map([['pi', adapter]]), herdr, async paneForRun() { return { paneId: 'pane' } } });
    await new EffectRunner(repo, engine, handlers).drain(); const active = engine.status(repo, 'effects'); expect(active.runs[0]?.status).toBe('working'); expect(active.runs[0]?.paneId).toBe('pane'); expect(adapter.launches).toBe(1); expect(adapter.context?.environment.HERDR_STEP_ID).toBe('core.implementation'); expect(adapter.context?.environment.HERDR_TELEMETRY_PATH).toContain('/effects/telemetry.jsonl'); expect(fs.readFileSync(engine.getRun(repo, active.runs[0]!.id).assignmentPath, 'utf8')).toContain('Task: task');
    engine.dispatch(repo, { type: 'operator.repair', workflowId: active.workflowId, revision: active.revision, targetStep: 'core.implementation', reason: 'test repair' }); await new EffectRunner(repo, engine, handlers).drain(); expect(adapter.stops).toBe(1); expect(adapter.launches).toBe(2); expect(engine.status(repo, 'effects').status).toBe('active');
  } finally { fs.rmSync(repo, { recursive: true, force: true }) }
});

test('launch retry recovers stable Herdr agent without rotating capability or duplicating launch', async () => {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'workflow-launch-recover-'));
  try {
    execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: repo }); fs.writeFileSync(path.join(repo, 'README.md'), 'x\n'); execFileSync('git', ['add', '.'], { cwd: repo }); execFileSync('git', ['-c', 'user.email=test@example.com', '-c', 'user.name=Test', 'commit', '-qm', 'base'], { cwd: repo });
    const profile = { name: 'pi', runtime: 'pi' as const, executable: 'sh', tools: [], extensions: [], readOnly: false, capabilities: ['prompt', 'run-environment', 'observe'] as const, digest: 'profile' }; const routing = { defaultProfile: 'pi', routes: [{ stepId: 'core.implementation', role: 'worker', profile }, { stepId: 'core.triage', role: 'triage', profile }, { stepId: 'core.verification', profile }], diversity: [] };
    const registry = registerBuiltins(); const engine = new WorkflowEngine(registry); const started = engine.start({ repo, changeId: 'recover', definitionId: 'no-openspec', metadata: { branch: 'main', baseBranch: 'main', baseCommit: 'base', task: 'task' }, routing }); const claimed = engine.claimEffects(repo, 100); const launch = claimed.find(effect => effect.kind === 'agent.launch')!; const pendingRun = engine.getRun(repo, started.view.runs[0]!.id); const hash = pendingRun.capabilityHash; fs.mkdirSync(path.dirname(pendingRun.assignmentPath), { recursive: true }); fs.writeFileSync(pendingRun.assignmentPath, 'truncated'); const db = new Database(canonicalStorePath(repo)); db.query("UPDATE workflow_outbox SET lease_expires_at='2000-01-01T00:00:00Z' WHERE workflow_id=?").run(started.view.workflowId); db.close();
    let prompts = 0; const herdr = { call(...args: string[]) { if (args[0] === 'tab' && args[1] === 'list') return { tabs: [{ tab_id: 'tab1', label: 'dashboard' }] }; if (args[0] === 'workspace' && args[1] === 'create') return { workspace: { workspace_id: 'workspace' } }; if (args[0] === 'agent' && args[1] === 'get') return { agent: { pane_id: 'recovered-pane', tab_id: 'verification', agent_status: 'working' } }; if (args[0] === 'agent' && args[1] === 'prompt') { prompts++; return {} } throw new Error(`unexpected ${args.join(' ')}`) } }; const adapter = new Adapter(); const handlers = agentEffectHandlers(repo, engine, { registry, adapters: new Map([['pi', adapter]]), herdr, async paneForRun() { throw new Error('must not create pane') } }); await new EffectRunner(repo, engine, handlers).drain(); const run = engine.getRun(repo, started.view.runs[0]!.id); expect(run.handle?.paneId).toBe('recovered-pane'); expect(run.capabilityHash).toBe(hash); expect(adapter.launches).toBe(0); expect(prompts).toBe(1); expect(launch.runToken).toBeTruthy(); expect(fs.readFileSync(run.assignmentPath, 'utf8')).toContain('Write exactly this envelope shape:'); expect(fs.readFileSync(run.assignmentPath, 'utf8')).not.toBe('truncated');
  } finally { fs.rmSync(repo, { recursive: true, force: true }) }
});

test('review-comment loop reuses the planner agent by stable name instead of launching a new tab', async () => {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'workflow-plan-reuse-'));
  try {
    fs.mkdirSync(path.join(repo, 'openspec'), { recursive: true }); execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: repo }); fs.writeFileSync(path.join(repo, 'README.md'), 'x\n'); fs.writeFileSync(path.join(repo, 'openspec', 'config.yaml'), 'schema: spec-driven\n'); execFileSync('git', ['add', '.'], { cwd: repo }); execFileSync('git', ['-c', 'user.email=test@example.com', '-c', 'user.name=Test', 'commit', '-qm', 'base'], { cwd: repo });
    const profile = { name: 'pi', runtime: 'pi' as const, executable: 'sh', tools: [], extensions: [], readOnly: false, capabilities: ['prompt', 'run-environment', 'observe'] as const, digest: 'profile' }; const routing = { defaultProfile: 'pi', routes: [{ stepId: 'core.plan', role: 'planner', profile }], diversity: [] };
    const registry = registerBuiltins(); const engine = new WorkflowEngine(registry);
    const started = engine.start({ repo, changeId: 'plan-reuse', definitionId: 'standard', metadata: { branch: 'main', baseBranch: 'main', baseCommit: 'base' }, routing });

    let agentLive = false; let prompts = 0; let paneForRunCalls = 0; const capturedNames: string[] = [];
    const herdr = { call(...args: string[]) {
      if (args[0] === 'tab' && args[1] === 'list') return { tabs: [{ tab_id: 'tab1', label: 'dashboard' }] };
      if (args[0] === 'workspace' && args[1] === 'create') return { workspace: { workspace_id: 'workspace' } };
      if (args[0] === 'agent' && args[1] === 'get') { capturedNames.push(args[2]!); return agentLive ? { agent: { pane_id: 'planner-pane', tab_id: 'plan', agent_status: 'working' } } : { agent: { agent_status: 'unknown' } } }
      if (args[0] === 'agent' && args[1] === 'prompt') { prompts++; return {} }
      throw new Error(`unexpected ${args.join(' ')}`);
    } };
    const adapter = new Adapter(); const originalLaunch = adapter.launch.bind(adapter); adapter.launch = async ctx => { const handle = await originalLaunch(ctx); agentLive = true; return { ...handle, paneId: 'planner-pane' } };
    const handlers = agentEffectHandlers(repo, engine, { registry, adapters: new Map([['pi', adapter]]), herdr, async paneForRun() { paneForRunCalls++; if (paneForRunCalls > 1) throw new Error('must not create a second pane'); return { paneId: 'planner-pane' } } });

    await new EffectRunner(repo, engine, handlers).drain();
    expect(adapter.launches).toBe(1); expect(paneForRunCalls).toBe(1);
    const firstRunId = started.view.runs[0]!.id; const firstName = adapter.context?.name;
    expect(firstName).toBe('plan-reuse-planner');

    const atGate = engine.dispatch(repo, { type: 'operator.repair', workflowId: started.view.workflowId, revision: engine.status(repo, 'plan-reuse').revision, targetStep: 'core.plan-approval', reason: 'operator confirmed evidence' });
    const reentered = engine.dispatch(repo, { type: 'developer.action', workflowId: started.view.workflowId, revision: atGate.view.revision, actionId: 'review-comments', input: { comments: [{ comment: 'clarify scope', file: 'proposal.md', line: 3 }] } });
    expect(reentered.view.currentStep.id).toBe('core.plan');
    const secondRun = reentered.view.runs.find(item => item.status === 'pending' || item.status === 'working');
    expect(secondRun).toBeTruthy(); expect(secondRun!.id).not.toBe(firstRunId);

    await new EffectRunner(repo, engine, handlers).drain();
    expect(adapter.launches).toBe(1); expect(paneForRunCalls).toBe(1); expect(prompts).toBe(1);
    expect(capturedNames.every(name => name === firstName)).toBe(true);
    const run = engine.getRun(repo, secondRun!.id); expect(run.handle?.paneId).toBe('planner-pane');

    // QV-001/QV-002: the reused planner process's own OS env is frozen at its
    // original `agent start` (still holding the first run's HERDR_RUN_ID/
    // GENERATION/TOKEN); only HERDR_WORKFLOW_ID/HERDR_STEP_ID/HERDR_ROLE stay
    // valid across generations. `resolveHandoffIdentity` must resolve the
    // *second* (current) run from that stable role identity, not the stale
    // run-scoped env, and the freshly minted token must actually authorize
    // handing off that run — proving the follow-up round is completable, not
    // just that a new tab was avoided.
    const saved = { ...process.env };
    try {
      process.env.HERDR_WORKFLOW_ID = started.view.workflowId; process.env.HERDR_STEP_ID = 'core.plan'; process.env.HERDR_ROLE = 'planner';
      process.env.HERDR_RUN_ID = firstRunId; process.env.HERDR_RUN_GENERATION = '1'; process.env.HERDR_RUN_TOKEN = 'stale-token';
      const identity = cliTest.resolveHandoffIdentity(engine, repo);
      expect(identity.runId).toBe(secondRun!.id); expect(identity.runId).not.toBe(firstRunId);
      const handedOff = engine.dispatch(repo, { type: 'agent.handoff', runId: identity.runId, generation: identity.generation, token: identity.token, outcome: 'blocked', message: 'refreshed role identity resolves the follow-up run' });
      expect(handedOff.view.runs.find(item => item.id === secondRun!.id)?.status).toBe('blocked');
      expect(handedOff.view.health.attention).toContain('refreshed role identity resolves the follow-up run');
    } finally { process.env = saved }
  } finally { fs.rmSync(repo, { recursive: true, force: true }) }
});

test('runName stays within herdr 32-char agent name limit and stays unique', () => {
  const run = { role: 'performance-verifier', id: '1234567890abcdef1234567890abcdef', stepId: 'core.verification' } as Parameters<typeof effectRunnerTest.runName>[1];
  const short = effectRunnerTest.runName('test-123', run);
  expect(short.length).toBeLessThanOrEqual(32); expect(short).toMatch(/^[a-z][a-z0-9_-]*$/);
  const long = effectRunnerTest.runName('this-change-id-is-way-too-long-for-any-agent-name-limit', run);
  expect(long.length).toBeLessThanOrEqual(32); expect(long).toMatch(/^[a-z][a-z0-9_-]*$/);
  expect(long.includes(run.role)).toBe(true); expect(long.endsWith(run.id.slice(0, 8))).toBe(true);
  expect(effectRunnerTest.runName('a', run).length).toBeLessThanOrEqual(32);
});

test('runName is stable across generations for persistent single-role steps', () => {
  const first = { role: 'planner', id: '1234567890abcdef1234567890abcdef', stepId: 'core.plan' } as Parameters<typeof effectRunnerTest.runName>[1];
  const second = { role: 'planner', id: 'fedcba0987654321fedcba0987654321', stepId: 'core.plan' } as Parameters<typeof effectRunnerTest.runName>[1];
  expect(effectRunnerTest.runName('change-id', first)).toBe(effectRunnerTest.runName('change-id', second));
  const worker1 = { role: 'worker', id: '1234567890abcdef1234567890abcdef', stepId: 'core.implementation' } as Parameters<typeof effectRunnerTest.runName>[1];
  const worker2 = { role: 'worker', id: 'fedcba0987654321fedcba0987654321', stepId: 'core.implementation' } as Parameters<typeof effectRunnerTest.runName>[1];
  expect(effectRunnerTest.runName('change-id', worker1)).toBe(effectRunnerTest.runName('change-id', worker2));
  const archive1 = { role: 'archive', id: '1234567890abcdef1234567890abcdef', stepId: 'core.archive' } as Parameters<typeof effectRunnerTest.runName>[1];
  const archive2 = { role: 'archive', id: 'fedcba0987654321fedcba0987654321', stepId: 'core.archive' } as Parameters<typeof effectRunnerTest.runName>[1];
  expect(effectRunnerTest.runName('change-id', archive1)).toBe(effectRunnerTest.runName('change-id', archive2));
  expect(effectRunnerTest.runName('change-id', first).length).toBeLessThanOrEqual(32);
  expect(effectRunnerTest.runName('change-id', first)).toMatch(/^[a-z][a-z0-9_-]*$/);
});

test('workspace retry recovers stable branch and workspace identity', async () => {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'workflow-workspace-recover-'));
  try {
    execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: repo }); fs.writeFileSync(path.join(repo, 'README.md'), 'x\n'); execFileSync('git', ['add', '.'], { cwd: repo }); execFileSync('git', ['-c', 'user.email=test@example.com', '-c', 'user.name=Test', 'commit', '-qm', 'base'], { cwd: repo }); const base = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repo, encoding: 'utf8' }).trim();
    const profile = { name: 'pi', runtime: 'pi' as const, executable: 'sh', tools: [], extensions: [], readOnly: false, capabilities: ['prompt', 'run-environment', 'observe'] as const, digest: 'profile' }; const routing = { defaultProfile: 'pi', routes: [{ stepId: 'core.implementation', role: 'worker', profile }, { stepId: 'core.triage', role: 'triage', profile }, { stepId: 'core.verification', profile }], diversity: [] }; const registry = registerBuiltins(); const engine = new WorkflowEngine(registry); const started = engine.start({ repo, mode: 'checkout', changeId: 'workspace-recover', definitionId: 'no-openspec', metadata: { branch: 'feature/recover', baseBranch: 'main', baseCommit: base, task: 'task' }, routing }); engine.claimEffects(repo, 1); execFileSync('git', ['switch', '-q', '-c', 'feature/recover', base], { cwd: repo }); const db = new Database(canonicalStorePath(repo)); db.query("UPDATE workflow_outbox SET lease_expires_at='2000-01-01T00:00:00Z' WHERE workflow_id=?").run(started.view.workflowId); db.close();
    let creates = 0; const herdr = { call(...args: string[]) { if (args[0] === 'tab' && args[1] === 'list') return { tabs: [{ tab_id: 'tab1', label: 'dashboard' }] }; if (args[0] === 'workspace' && args[1] === 'get') return { workspace: { workspace_id: 'recovered-workspace', status: 'open' } }; if (args[0] === 'workspace' && args[1] === 'create') { creates++; return { workspace: { workspace_id: 'new' } } }; if (args[0] === 'agent' && args[1] === 'get') throw new Error('not found'); if (args[0] === 'pane' && args[1] === 'close') return {}; throw new Error(`unexpected ${args.join(' ')}`) } }; const adapter = new Adapter(); const handlers = agentEffectHandlers(repo, engine, { registry, adapters: new Map([['pi', adapter]]), herdr, async paneForRun() { return { paneId: 'pane' } } }); await new EffectRunner(repo, engine, handlers).drain(); const view = engine.status(repo, 'workspace-recover'); expect(view.workspace).toBe('recovered-workspace'); expect(view.worktree).toBe(repo); expect(creates).toBe(0); expect(adapter.launches).toBe(1);
  } finally { fs.rmSync(repo, { recursive: true, force: true }) }
});
