import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';
import { appendFileSync, mkdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

// Deterministic env backstop: herdr's agent spawn does not reliably inherit the
// pane shell env (first agent start often fails with "not an available shell"
// and the retry spawns in a stale tracked shell, giving the agent another run's
// environment). The engine writes .herdr-workflow/runtime-bin/by-agent/<name>
// pointing at the current run's run.env before every launch and every
// reused-prompt delivery, so recover keyed off this process's own --name
// identity — works for persistent-role and round-scoped names alike.
function recoverRunEnv(): void {
  try {
    const nameIndex = process.argv.indexOf('--name');
    const name = nameIndex >= 0 ? process.argv[nameIndex + 1] : undefined;
    if (!name || !/^[a-z][a-z0-9_-]*$/.test(name)) return;
    const pointer = join(process.cwd(), '.herdr-workflow', 'runtime-bin', 'by-agent', name);
    const relative = readFileSync(pointer, 'utf8').trim();
    if (!relative) return;
    const content = readFileSync(join(process.cwd(), relative), 'utf8');
    for (const line of content.split('\n')) {
      const match = line.match(/^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/);
      if (!match) continue;
      process.env[match[1]!] = match[2]!.replace(/^'|'$/g, '');
    }
  } catch { /* best effort */ }
}
recoverRunEnv();

const output = process.env.HERDR_TELEMETRY_PATH;
const SECRET_PATTERN = /(-----BEGIN[\s\S]*?-----END[^\n]*|sk-[A-Za-z0-9_-]{16,}|gh[pousr]_[A-Za-z0-9]{16,}|AKIA[0-9A-Z]{16}|xox[baprs]-[A-Za-z0-9-]{10,}|github_pat_[A-Za-z0-9_]{20,}|HERDR_RUN_TOKEN=[^\s]+)/g;
function redact(text: string): string { return text.replace(SECRET_PATTERN, '[REDACTED]') }
function emit(event: string, fields: Record<string, unknown> = {}) {
  const envelope = { schemaVersion: 1, at: new Date().toISOString(), layer: 'runtime', runtime: 'pi', event, workflowId: process.env.HERDR_WORKFLOW_ID, runId: process.env.HERDR_RUN_ID, stepId: process.env.HERDR_STEP_ID, role: process.env.HERDR_ROLE, profile: process.env.HERDR_PROFILE, traceparent: process.env.TRACEPARENT, ...fields };
  if (output) try { mkdirSync(dirname(output), { recursive: true }); appendFileSync(output, JSON.stringify(envelope) + '\n'); } catch { /* observational */ }
  const endpoint = process.env.OTEL_EXPORTER_OTLP_ENDPOINT; if (endpoint) void fetch(`${endpoint.replace(/\/$/, '')}/v1/logs`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(envelope), signal: AbortSignal.timeout(750) }).catch(() => undefined);
}
export default function bridge(pi: ExtensionAPI) {
  // Telemetry only: runtime lifecycle + usage events. Handoff and checks go
  // through the agent's normal tools (`agentic-coding workflow handoff`).
  // Wall-clock start of the in-flight assistant message, used to derive per-
  // message generation duration and tokens/s on message_end.
  let assistantStartedAt: number | undefined;
  pi.on('agent_start', () => { assistantStartedAt = undefined; emit('runtime.started'); });
  pi.on('agent_settled', () => emit('runtime.settled'));
  pi.on('tool_execution_end', (event: { toolName?: string; isError?: boolean }) => emit('runtime.tool', { tool: event.toolName, outcome: event.isError ? 'error' : 'ok' }));
  pi.on('message_start', (event: { message?: { role?: string } }) => {
    if (event.message?.role === 'assistant') assistantStartedAt = Date.now();
  });
  pi.on('message_end', (event: { message?: { role?: string; usage?: { input?: number; output?: number; cacheRead?: number; cacheWrite?: number; cost?: { total?: number } } } }) => {
    const usage = event.message?.usage;
    if (event.message?.role !== 'assistant' || !usage) return;
    const durationMs = assistantStartedAt !== undefined ? Math.max(0, Date.now() - assistantStartedAt) : undefined;
    assistantStartedAt = undefined;
    // Omit fields the runtime did not provide rather than emitting zeros:
    // downstream consumers treat absent fields as "not measurable".
    emit('runtime.usage', {
      inputTokens: usage.input,
      outputTokens: usage.output,
      ...(typeof usage.cacheRead === 'number' ? { cacheReadTokens: usage.cacheRead } : {}),
      ...(typeof usage.cacheWrite === 'number' ? { cacheWriteTokens: usage.cacheWrite } : {}),
      cost: usage.cost?.total,
      ...(durationMs !== undefined && durationMs > 0 ? {
        durationMs,
        ...(usage.output ? { tokensPerSecond: Math.round((usage.output / durationMs) * 10000) / 10 } : {}),
      } : {}),
    });
  });
}
