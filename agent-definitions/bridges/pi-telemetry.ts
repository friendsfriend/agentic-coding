import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';
import { appendFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

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
  pi.on('agent_start', () => emit('runtime.started'));
  pi.on('agent_settled', () => emit('runtime.settled'));
  pi.on('tool_execution_end', (event: { toolName?: string; isError?: boolean }) => emit('runtime.tool', { tool: event.toolName, outcome: event.isError ? 'error' : 'ok' }));
  pi.on('message_end', (event: { message?: { usage?: { input?: number; output?: number; cost?: { total?: number } } } }) => { const usage = event.message?.usage; if (usage) emit('runtime.usage', { inputTokens: usage.input, outputTokens: usage.output, cost: usage.cost?.total }); });
}
