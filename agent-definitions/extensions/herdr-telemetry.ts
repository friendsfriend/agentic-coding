import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';
import { appendFileSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { randomBytes, createHash } from 'node:crypto';

type Context = { traceId: string; spanId: string; flags?: string };
type Span = { traceId: string; spanId: string; parentSpanId?: string; name: string; startTimeUnixNano: string; endTimeUnixNano?: string; status?: 'OK' | 'ERROR'; attributes: Record<string, string | number | boolean> };
const hex = (bytes: number) => randomBytes(bytes).toString('hex');
const now = () => (BigInt(Date.now()) * 1_000_000n).toString();
const parseTraceparent = (value?: string): Context | undefined => {
  const match = value?.match(/^00-([0-9a-f]{32})-([0-9a-f]{16})-([0-9a-f]{2})$/i);
  return match && !/^0+$/.test(match[1]!) && !/^0+$/.test(match[2]!) ? { traceId: match[1]!, spanId: match[2]!, flags: match[3]! } : undefined;
};
const traceparent = (context: Context) => `00-${context.traceId}-${context.spanId}-${context.flags ?? '01'}`;
const endpoint = () => process.env.OTEL_EXPORTER_OTLP_TRACES_ENDPOINT || (process.env.OTEL_EXPORTER_OTLP_ENDPOINT ? `${process.env.OTEL_EXPORTER_OTLP_ENDPOINT.replace(/\/$/, '')}/v1/traces` : 'http://127.0.0.1:4318/v1/traces');

export default function (pi: ExtensionAPI) {
  const change = process.env.HERDR_CHANGE_ID;
  const role = process.env.HERDR_ROLE;
  const root = change ? join(process.cwd(), '.herdr-workflow', change) : undefined;
  const telemetryPath = root && join(root, 'telemetry.jsonl');
  const tracesPath = root && join(root, 'traces.jsonl');
  const healthPath = join(process.env.HOME ?? '', '.pi', 'agent', 'herdr-provider-health.json');
  const restricted = !!role && !['manager', 'planner', 'worker'].includes(role);
  const oneShot = role === 'recovery' || role === 'archive' || role?.endsWith('-verifier');
  const commandStart = String.raw`(?:^|[\n;&|()'"])\s*`;
  const agentExecutable = new RegExp(`${commandStart}(?:(?:command|exec|nohup)\\s+)?(?:env(?:\\s+[A-Za-z_][A-Za-z0-9_]*=\\S+)*\\s+)?(?:\\S*\\/)?(?:pi|opencode|claude|codex)(?=\\s|$)`, 'i');
  const agentRunner = new RegExp(`${commandStart}(?:npx|bunx|uvx)\\s+(?:pi|opencode|claude|codex)(?=\\s|$)`, 'i');
  const herdrSpawner = new RegExp(`${commandStart}(?:\\S*\\/)?herdr\\s+(?:agent\\s+(?:start|prompt)|pane\\s+run)\\b`, 'i');
  let model = 'unknown';
  let operation: Span | undefined;
  const tools = new Map<string, Span>();
  const turns = new Map<number, Span>();
  const attributes = (extra: Record<string, string | number | boolean> = {}) => ({ 'service.name': 'herdr-agent', ...(change ? { 'herdr.change.id': change } : {}), ...(role ? { 'herdr.role': role } : {}), ...extra });
  const write = (event: string, fields: Record<string, unknown> = {}) => { if (!telemetryPath) return; try { mkdirSync(root!, { recursive: true }); appendFileSync(telemetryPath, JSON.stringify({ at: new Date().toISOString(), event, role, ...fields }) + '\n'); } catch { /* telemetry must not affect agent */ } };
  const exportSpan = (span: Span) => {
    if (!span.endTimeUnixNano) return;
    if (tracesPath) try { mkdirSync(root!, { recursive: true }); appendFileSync(tracesPath, JSON.stringify(span) + '\n'); } catch { /* local fallback is best effort */ }
    const attributes = Object.entries(span.attributes).map(([key, attribute]) => ({
      key,
      value: typeof attribute === 'string' ? { stringValue: attribute } : typeof attribute === 'boolean' ? { boolValue: attribute } : { intValue: String(attribute) },
    }));
    const body = { resourceSpans: [{ resource: { attributes: [{ key: 'service.name', value: { stringValue: 'herdr-agent' } }] }, scopeSpans: [{ scope: { name: 'herdr-telemetry' }, spans: [{ traceId: span.traceId, spanId: span.spanId, parentSpanId: span.parentSpanId, name: span.name, startTimeUnixNano: span.startTimeUnixNano, endTimeUnixNano: span.endTimeUnixNano, attributes, status: span.status === 'ERROR' ? { code: 2 } : { code: 1 } }] }] }] };
    void fetch(endpoint(), { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body), signal: AbortSignal.timeout(750) }).catch(() => undefined);
  };
  const start = (name: string, parent?: Context, extra: Record<string, string | number | boolean> = {}): Span => ({ traceId: parent?.traceId ?? hex(16), spanId: hex(8), parentSpanId: parent?.spanId, name, startTimeUnixNano: now(), attributes: attributes(extra) });
  const end = (span: Span | undefined, status: 'OK' | 'ERROR' = 'OK') => { if (!span || span.endTimeUnixNano) return; span.endTimeUnixNano = now(); span.status = status; exportSpan(span); };
  const consumeHandoff = () => {
    if (!root || !role) return undefined;
    const path = join(root, 'trace-context', `${role}.json`);
    try { const value = JSON.parse(readFileSync(path, 'utf8')); unlinkSync(path); return Number(value.expiresAt) > Date.now() ? { context: parseTraceparent(value.traceparent), messageId: typeof value.messageId === 'string' ? value.messageId : undefined, attributes: value.attributes as Record<string, string | number | boolean> } : undefined; } catch { return undefined; }
  };
  const recordProviderFailure = (status: number) => { if (status !== 429 && status < 500) return; try { const health = JSON.parse(readFileSync(healthPath, 'utf8')) as Record<string, { failures: number; lastFailure: string }>; const provider = model.split('/')[0] ?? 'unknown'; const previous = health[provider]; const recent = previous && Date.now() - Date.parse(previous.lastFailure) < 120_000; health[provider] = { failures: recent ? previous.failures + 1 : 1, lastFailure: new Date().toISOString() }; writeFileSync(healthPath, JSON.stringify(health)); } catch { /* advisory */ } };
  pi.on('before_agent_start', (event: any, ctx: any) => { const handoff = consumeHandoff(); const session = ctx.sessionManager?.getSessionId?.() ?? 'unknown'; const leaf = handoff?.messageId ?? ctx.sessionManager?.getLeafEntry?.()?.id ?? hex(8); const prompt = String(event.prompt ?? ''); const preview = process.env.HERDR_TELEMETRY_MESSAGE_PREVIEW ? prompt.slice(0, Math.min(500, Number(process.env.HERDR_TELEMETRY_MESSAGE_PREVIEW) || 500)) : undefined; operation = start('agent.operation', handoff?.context, { ...handoff?.attributes, 'herdr.message.id': String(leaf), 'herdr.message.hash': createHash('sha256').update(prompt).digest('hex'), 'herdr.message.bytes': Buffer.byteLength(prompt), ...(preview ? { 'herdr.message.preview': preview } : {}), 'pi.session.id': String(session), 'gen_ai.operation.name': 'invoke_agent' }); });
  pi.on('model_select', (event: any) => { model = `${event.model.provider}/${event.model.id}`; write('model_selected', { model }); });
  pi.on('agent_start', () => write('pi_agent_start', { model }));
  pi.on('agent_end', () => write('pi_agent_end'));
  pi.on('agent_settled', (_event, ctx) => { end(operation); operation = undefined; write('pi_agent_settled'); if (oneShot) ctx.shutdown(); });
  pi.on('turn_start', (event: any) => { if (operation) turns.set(event.turnIndex, start('gen_ai.chat', operation, { 'gen_ai.provider.name': model.split('/')[0] ?? 'unknown', 'gen_ai.request.model': model })); });
  pi.on('turn_end', (event: any) => end(turns.get(event.turnIndex)));
  pi.on('tool_execution_start', (event: any) => { if (operation) tools.set(event.toolCallId, start(`tool.${event.toolName}`, operation, { 'tool.name': event.toolName, 'tool.call.id': event.toolCallId })); });
  pi.on('tool_call', (event: any) => { const command = String(event.input?.command ?? ''); if (restricted && event.toolName === 'bash' && (agentExecutable.test(command) || agentRunner.test(command) || herdrSpawner.test(command))) { write('nested_agent_blocked', { command: command.slice(0, 500) }); return { block: true, reason: 'Restricted workflow roles must complete work themselves; nested agent spawning is blocked.' }; } if (event.toolName === 'bash') { const span = tools.get(event.toolCallId); if (span && event.input?.command) event.input.command = `TRACEPARENT=${JSON.stringify(traceparent(span))} ${event.input.command}`; } });
  pi.on('tool_execution_end', (event: any) => { end(tools.get(event.toolCallId), event.isError ? 'ERROR' : 'OK'); tools.delete(event.toolCallId); if (event.isError) write('tool_error', { tool: event.toolName }); });
  pi.on('after_provider_response', (event: any) => { write('provider_response', { status: event.status, retryAfter: event.headers?.['retry-after'], model }); recordProviderFailure(event.status); });
  pi.on('message_end', (event: any) => { if (event.message?.role !== 'assistant') return; const usage = event.message.usage; if (usage) write('model_usage', { inputTokens: usage.inputTokens, outputTokens: usage.outputTokens, cacheReadTokens: usage.cacheReadTokens, cacheWriteTokens: usage.cacheWriteTokens, cost: usage.cost?.total }); });
}

export const telemetryTest = { parseTraceparent, traceparent };
