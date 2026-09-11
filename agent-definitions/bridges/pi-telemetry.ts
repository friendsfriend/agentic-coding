import type {
	AfterProviderResponseEvent,
	AgentSettledEvent,
	ExtensionAPI,
	ExtensionContext,
	MessageEndEvent,
	ModelSelectEvent,
	SessionBeforeCompactEvent,
	SessionCompactEvent,
	ToolExecutionEndEvent,
	ToolExecutionStartEvent,
	TurnEndEvent,
	TurnStartEvent,
} from '@earendil-works/pi-coding-agent';
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

/** Bounded scalar text for a telemetry attribute; never contains model text. */
function bounded(value: unknown, max = 256): string | undefined {
  if (typeof value !== 'string' || !value) return undefined;
  return redact(value).slice(0, max);
}
function integer(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && value.trim() !== '') {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : undefined;
  }
  return undefined;
}
/** Bounded error class from an explicit, caller-provided error value only.
 * Never derives a class from tool results, model text, or response bodies. */
function errorClass(value: unknown): string | undefined {
  if (value === undefined || value === null) return undefined;
  const text = typeof value === 'string'
    ? value
    : value instanceof Error
      ? value.message
      : typeof value === 'object' && typeof (value as { message?: unknown }).message === 'string'
        ? String((value as { message: string }).message)
        : undefined;
  if (text === undefined) return undefined;
  const normalized = redact(text).replace(/\s+/g, ' ').trim().slice(0, 160);
  return normalized || undefined;
}
function byteSize(value: unknown): number | undefined {
  if (value === undefined || value === null) return undefined;
  try { return Buffer.byteLength(typeof value === 'string' ? value : JSON.stringify(value)); } catch { return undefined; }
}

interface SessionTotals {
  turns: number;
  toolCalls: number;
  toolErrors: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  cost: number;
}

export default function bridge(pi: ExtensionAPI) {
  // Telemetry only: runtime lifecycle + usage events. Handoff and checks go
  // through the agent's normal tools (`agentic-coding workflow handoff`).
  let assistantStartedAt: number | undefined;
  let turnIndex = 0;
  let turnStartedAt: number | undefined;
  let turnToolCalls = 0;
  let turnToolErrors = 0;
  let providerRequestStartedAt: number | undefined;
  let compactionStartedAt: number | undefined;
  let compactionTokensBefore: number | undefined;
  const toolStarts = new Map<string, { name?: string; argumentBytes?: number; startedAt: number }>();
  const totals: SessionTotals = { turns: 0, toolCalls: 0, toolErrors: 0, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, cost: 0 };

  // A runtime's own vocabulary never collides with the workflow vocabulary
  // (D4): runtime-specific keys are `pi.*`; session identity is the shared
  // join key with the engine events. Identity comes from the handler context
  // (`ctx`), which is the only place pi exposes session/model/thinking state.
  const identity = (ctx?: ExtensionContext): Record<string, unknown> => {
    let sessionId: string | undefined;
    try { sessionId = ctx?.sessionManager?.getSessionId(); } catch { /* best effort */ }
    const model = ctx?.model;
    return {
      ...(sessionId ? { sessionId } : {}),
      ...(model?.id ? { 'pi.model': model.id } : {}),
      ...(model?.provider ? { 'pi.provider': model.provider } : {}),
      ...(ctx?.thinkingLevel ? { 'pi.thinking': ctx.thinkingLevel } : {}),
      'pi.turn.index': turnIndex,
    };
  };
  const resetTurn = () => { turnToolCalls = 0; turnToolErrors = 0; turnStartedAt = Date.now(); assistantStartedAt = undefined; };

  pi.on('agent_start', (_event, ctx) => {
    resetTurn();
    emit('runtime.started', identity(ctx));
  });
  pi.on('turn_start', (event: TurnStartEvent, ctx) => {
    turnIndex = integer(event.turnIndex) ?? turnIndex + 1;
    turnToolCalls = 0;
    turnToolErrors = 0;
    turnStartedAt = integer(event.timestamp) ?? Date.now();
    assistantStartedAt = undefined;
    emit('runtime.turn_started', identity(ctx));
  });
  pi.on('turn_end', (event: TurnEndEvent, ctx) => {
    const duration = turnStartedAt !== undefined ? Math.max(0, Date.now() - turnStartedAt) : undefined;
    totals.turns += 1;
    emit('runtime.turn', {
      ...identity(ctx),
      ...(integer(event.turnIndex) !== undefined ? { 'pi.turn.index': integer(event.turnIndex) } : {}),
      ...(duration !== undefined ? { 'pi.turn.duration_ms': duration } : {}),
      'pi.turn.tool_calls': Array.isArray(event.toolResults) ? event.toolResults.length : turnToolCalls,
      'pi.turn.tool_errors': turnToolErrors,
    });
    turnStartedAt = undefined;
  });
  // Streaming updates never produce telemetry rows (task 4.8): only the start
  // and end of a tool execution are wired.
  pi.on('tool_execution_start', (event: ToolExecutionStartEvent, _ctx) => {
    toolStarts.set(event.toolCallId, {
      ...(typeof event.toolName === 'string' ? { name: event.toolName } : {}),
      ...(byteSize(event.args) !== undefined ? { argumentBytes: byteSize(event.args) } : {}),
      startedAt: Date.now(),
    });
  });
  pi.on('tool_execution_end', (event: ToolExecutionEndEvent, ctx) => {
    const start = toolStarts.get(event.toolCallId);
    toolStarts.delete(event.toolCallId);
    const isError = event.isError === true;
    const duration = start ? Math.max(0, Date.now() - start.startedAt) : undefined;
    const resultBytes = byteSize(event.result);
    turnToolCalls += 1;
    totals.toolCalls += 1;
    if (isError) { turnToolErrors += 1; totals.toolErrors += 1; }
    emit('runtime.tool', {
      ...identity(ctx),
      outcome: isError ? 'error' : 'ok',
      ...(start?.name ?? event.toolName ? { 'pi.tool.name': start?.name ?? event.toolName } : {}),
      ...(event.toolCallId ? { 'pi.tool.call_id': event.toolCallId } : {}),
      'pi.tool.outcome': isError ? 'error' : 'ok',
      ...(duration !== undefined ? { 'pi.tool.duration_ms': duration } : {}),
      ...(start?.argumentBytes !== undefined ? { 'pi.tool.argument_bytes': start.argumentBytes } : {}),
      ...(resultBytes !== undefined ? { 'pi.tool.result_bytes': resultBytes } : {}),
      // The tool result is content; classify only that the tool failed. Never
      // fall back to result/tool output text (SEC-001).
      ...(isError ? { 'pi.error.class': 'tool_error' } : {}),
    });
  });
  pi.on('before_provider_request', (_event, _ctx) => { providerRequestStartedAt = Date.now(); });
  pi.on('after_provider_response', (event: AfterProviderResponseEvent, ctx) => {
    const latency = providerRequestStartedAt !== undefined ? Math.max(0, Date.now() - providerRequestStartedAt) : undefined;
    providerRequestStartedAt = undefined;
    const status = integer(event.status);
    const failed = status !== undefined && (status < 200 || status >= 300);
    emit('runtime.provider_response', {
      ...identity(ctx),
      ...(status !== undefined ? { 'pi.provider.status': status } : {}),
      ...(latency !== undefined ? { 'pi.provider.latency_ms': latency } : {}),
      ...(failed ? { outcome: 'error', 'pi.error.class': `http_${status}` } : {}),
    });
  });
  pi.on('session_before_compact', (event: SessionBeforeCompactEvent, _ctx) => {
    compactionStartedAt = Date.now();
    compactionTokensBefore = integer(event.preparation?.tokensBefore);
  });
  pi.on('session_compact', (event: SessionCompactEvent, ctx) => {
    const duration = compactionStartedAt !== undefined ? Math.max(0, Date.now() - compactionStartedAt) : undefined;
    compactionStartedAt = undefined;
    let tokensAfter: number | undefined;
    try { tokensAfter = integer(ctx?.getContextUsage()?.tokens); } catch { tokensAfter = undefined; }
    const tokensBefore = integer(event.compactionEntry?.tokensBefore) ?? compactionTokensBefore;
    compactionTokensBefore = undefined;
    emit('runtime.compaction', {
      ...identity(ctx),
      ...(tokensBefore !== undefined ? { 'pi.compaction.tokens_before': tokensBefore } : {}),
      ...(tokensAfter !== undefined ? { 'pi.compaction.tokens_after': tokensAfter } : {}),
      ...(duration !== undefined ? { 'pi.compaction.duration_ms': duration } : {}),
      'pi.compaction.automatic': event.reason !== 'manual',
    });
  });
  pi.on('model_select', (event: ModelSelectEvent, ctx) => {
    emit('runtime.model_selected', {
      ...identity(ctx),
      ...(event.model?.id ? { 'pi.model': event.model.id } : {}),
      ...(event.previousModel?.id ? { 'pi.model.previous': event.previousModel.id } : {}),
      ...(bounded(event.source, 64) ? { 'pi.model.source': bounded(event.source, 64) } : {}),
    });
  });
  pi.on('agent_settled', (_event: AgentSettledEvent, ctx) => {
    let contextPercent: number | undefined;
    let contextTokens: number | undefined;
    try {
      const usage = ctx?.getContextUsage();
      contextPercent = integer(usage?.percent);
      contextTokens = integer(usage?.tokens);
    } catch { /* context usage is best-effort */ }
    emit('runtime.settled', {
      ...identity(ctx),
      ...(contextPercent !== undefined ? { 'pi.context.percent': contextPercent } : {}),
      ...(contextTokens !== undefined ? { 'pi.context.tokens': contextTokens } : {}),
      'pi.session.turns': totals.turns,
      'pi.session.tool_calls': totals.toolCalls,
      'pi.session.tool_errors': totals.toolErrors,
      'pi.session.input_tokens': totals.inputTokens,
      'pi.session.output_tokens': totals.outputTokens,
      'pi.session.cache_read_tokens': totals.cacheReadTokens,
      'pi.session.cache_write_tokens': totals.cacheWriteTokens,
      'pi.session.cost': totals.cost,
    });
  });
  pi.on('message_start', (event, _ctx) => {
    if (event.message?.role === 'assistant') assistantStartedAt = Date.now();
  });
  pi.on('message_end', (event: MessageEndEvent, ctx) => {
    const message = event.message;
    if (message?.role !== 'assistant') return;
    const usage = message.usage;
    if (!usage) return;
    const durationMs = assistantStartedAt !== undefined ? Math.max(0, Date.now() - assistantStartedAt) : undefined;
    assistantStartedAt = undefined;
    if (typeof usage.input === 'number') totals.inputTokens += usage.input;
    if (typeof usage.output === 'number') totals.outputTokens += usage.output;
    if (typeof usage.cacheRead === 'number') totals.cacheReadTokens += usage.cacheRead;
    if (typeof usage.cacheWrite === 'number') totals.cacheWriteTokens += usage.cacheWrite;
    if (typeof usage.cost?.total === 'number') totals.cost += usage.cost.total;
    // Omit fields the runtime did not provide rather than emitting zeros:
    // downstream consumers treat absent fields as "not measurable".
    emit('runtime.usage', {
      ...identity(ctx),
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
