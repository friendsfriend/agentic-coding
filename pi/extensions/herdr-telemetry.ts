import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';
import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

export default function (pi: ExtensionAPI) {
  const change = process.env.HERDR_CHANGE_ID;
  const role = process.env.HERDR_ROLE;
  const path = change ? join(process.cwd(), '.herdr-workflow', change, 'telemetry.jsonl') : undefined;
  const healthPath = join(process.env.HOME ?? '', '.pi', 'agent', 'herdr-provider-health.json');
  const restricted = !!role && !['manager', 'planner', 'worker'].includes(role);
  const oneShot = role === 'recovery' || role === 'archive' || role?.endsWith('-verifier');
  const commandStart = String.raw`(?:^|[\n;&|()'"])\s*`;
  const agentExecutable = new RegExp(`${commandStart}(?:(?:command|exec|nohup)\\s+)?(?:env(?:\\s+[A-Za-z_][A-Za-z0-9_]*=\\S+)*\\s+)?(?:\\S*\\/)?(?:pi|opencode|claude|codex)(?=\\s|$)`, 'i');
  const agentRunner = new RegExp(`${commandStart}(?:npx|bunx|uvx)\\s+(?:pi|opencode|claude|codex)(?=\\s|$)`, 'i');
  const herdrSpawner = new RegExp(`${commandStart}(?:\\S*\\/)?herdr\\s+(?:agent\\s+(?:start|prompt)|pane\\s+run)\\b`, 'i');
  let model = 'unknown';
  const write = (event: string, fields: Record<string, unknown> = {}) => {
    if (!path) return;
    try {
      mkdirSync(join(process.cwd(), '.herdr-workflow', change!), { recursive: true });
      appendFileSync(path, JSON.stringify({ at: new Date().toISOString(), event, role, ...fields }) + '\n');
    } catch { /* telemetry must never affect an agent */ }
  };
  const recordProviderFailure = (status: number) => {
    if (status !== 429 && status < 500) return;
    try {
      const health = JSON.parse(readFileSync(healthPath, 'utf8')) as Record<string, { failures: number; lastFailure: string }>;
      const provider = model.split('/')[0] ?? 'unknown';
      const previous = health[provider];
      const recent = previous && Date.now() - Date.parse(previous.lastFailure) < 120_000;
      health[provider] = { failures: recent ? previous.failures + 1 : 1, lastFailure: new Date().toISOString() };
      writeFileSync(healthPath, JSON.stringify(health));
    } catch { /* health is advisory */ }
  };
  pi.on('model_select', (event: any) => { model = `${event.model.provider}/${event.model.id}`; write('model_selected', { model }); });
  pi.on('agent_start', () => write('pi_agent_start', { model }));
  pi.on('agent_end', () => write('pi_agent_end'));
  pi.on('agent_settled', (_event, ctx) => { write('pi_agent_settled'); if (oneShot) ctx.shutdown(); });
  pi.on('tool_call', (event: any) => {
    if (!restricted || event.toolName !== 'bash') return;
    const command = String(event.input?.command ?? '');
    if (agentExecutable.test(command) || agentRunner.test(command) || herdrSpawner.test(command)) {
      write('nested_agent_blocked', { command: command.slice(0, 500) });
      return { block: true, reason: 'Restricted workflow roles must complete work themselves; nested agent spawning is blocked.' };
    }
  });
  pi.on('after_provider_response', (event: any) => { write('provider_response', { status: event.status, retryAfter: event.headers?.['retry-after'], model }); recordProviderFailure(event.status); });
  pi.on('message_end', (event: any) => {
    if (event.message?.role !== 'assistant') return;
    const usage = event.message.usage;
    if (usage) write('model_usage', { inputTokens: usage.inputTokens, outputTokens: usage.outputTokens, cacheReadTokens: usage.cacheReadTokens, cacheWriteTokens: usage.cacheWriteTokens, cost: usage.cost?.total });
  });
  pi.on('tool_execution_end', (event: any) => { if (event.isError) write('tool_error', { tool: event.toolName }); });
}
