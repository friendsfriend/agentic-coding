import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';
import { appendFileSync, existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
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
const telemetryConfig = () => {
  const paths = [join(homedir(), '.config', 'agentic-coding', 'config.toml'), join(homedir(), '.pi', 'agent', 'herdr-workflow.toml'), join(process.cwd(), '.pi', 'herdr-workflow.toml')];
  let captureContent = false;
  let verifierFallback: string | undefined;
  for (const path of paths) try {
    if (!existsSync(path)) continue;
    let sectionName = '';
    for (const line of readFileSync(path, 'utf8').split(/\r?\n/)) {
      const section = line.match(/^\s*\[([^\]]+)\]\s*$/);
      if (section) { sectionName = section[1] ?? ''; continue; }
      const capture = sectionName === 'telemetry' && line.match(/^\s*capture_content\s*=\s*(true|false)\s*(?:#.*)?$/)?.[1];
      if (capture) captureContent = capture === 'true';
      const fallback = sectionName === 'models' && line.match(/^\s*verifier_fallback\s*=\s*"([^"]+)"\s*(?:#.*)?$/)?.[1];
      if (fallback) verifierFallback = fallback;
    }
  } catch { /* telemetry config is optional */ }
  return { captureContent, verifierFallback };
};
const json = (value: unknown) => { try { return JSON.stringify(value); } catch { return String(value); } };
const assistantText = (message: any) => Array.isArray(message?.content) ? message.content.filter((part: any) => part?.type === 'text').map((part: any) => String(part.text ?? '')).join('') : '';
const modelName = (value: any) => value?.provider && value?.id ? `${value.provider}/${value.id}` : undefined;
const tokenUsage = (usage: any) => ({ inputTokens: Number(usage?.input ?? 0), outputTokens: Number(usage?.output ?? 0), cacheReadTokens: Number(usage?.cacheRead ?? 0), cacheWriteTokens: Number(usage?.cacheWrite ?? 0), totalTokens: Number(usage?.totalTokens ?? 0) });
const COMPACT_THRESHOLD_TOKENS = 250_000;
const COMPACTION_RESUME_PROMPT = 'Continue current worker task from compacted context. Complete remaining implementation and required focused validation.';
const EMPTY_SETTLE_NUDGE_PROMPT = 'Your previous turn ended without recording a verification result. Finish the review now and call herdr-workflow verification-result before stopping.';
const shouldCompact = (role: string | undefined, previous: number | undefined, current: number, pending: boolean) => role === 'worker' && !pending && current > COMPACT_THRESHOLD_TOKENS && (previous === undefined || previous <= COMPACT_THRESHOLD_TOKENS);
const resumeAfterCompaction = (role: string | undefined, send: (prompt: string) => void) => { if (role !== 'worker') return false; send(COMPACTION_RESUME_PROMPT); return true; };
const SEARCH_COMMAND_START = String.raw`(?:^|[\n;&|()])\s*`;
const isGlobalSearch = (command: string, cwd: string) => {
  if (new RegExp(`${SEARCH_COMMAND_START}(?:(?:command|exec|sudo)\\s+)?(?:\\S*\\/)?locate\\b`, 'i').test(command)) return true;
  const mdfind = new RegExp(`${SEARCH_COMMAND_START}(?:(?:command|exec|sudo)\\s+)?(?:\\S*\\/)?mdfind\\b([^\n;&|]*)`, 'i').exec(command);
  if (mdfind && !/\s-onlyin(?:\s|=)/.test(mdfind[1] ?? '')) return true;
  const finds = command.matchAll(new RegExp(`${SEARCH_COMMAND_START}(?:(?:command|exec|sudo)\\s+)?(?:\\S*\\/)?find\\s+(?:(?:-[HLP]|--)\\s+)*(?:"([^"]+)"|'([^']+)'|(\\S+))`, 'gi'));
  for (const match of finds) {
    let root = match[1] ?? match[2] ?? match[3] ?? '';
    root = root.replace(/^~(?=\/|$)/, homedir()).replace(/^\$(?:HOME|\{HOME\})(?=\/|$)/, homedir()).replace(/^\$(?:PWD|\{PWD\})(?=\/|$)/, cwd);
    const resolved = resolve(cwd, root);
    if (resolved === resolve('/') || resolved === resolve(homedir())) return true;
  }
  return false;
};
const isWorkflowStateAccess = (toolName: string, input: any) => {
  const value = toolName === 'bash' ? input?.command : ['read', 'edit', 'write'].includes(toolName) ? input?.path : '';
  return /(?:^|[\\/])\.herdr-workflow[\\/][^\\/]+[\\/]state\.json\b/i.test(String(value ?? ''));
};
const isWorkerVerifyCommand = (command: string) => /(?:^|[\n;&|()])\s*(?:\S*\/)?herdr-workflow\s+verify(?:\s|$)/i.test(command);
const verificationHandoffSucceeded = (isError: boolean, result: unknown) => !isError && /(?:triage started:|verification already running:)/i.test(json(result));
const shouldRuntimeFallback = (role: string | undefined, resultRecorded: boolean, attempted: boolean, currentModel: string, fallbackModel?: string) => !!role?.endsWith('-verifier') && !resultRecorded && !attempted && !!fallbackModel && fallbackModel !== currentModel;
const shouldNudgeEmptySettle = (role: string | undefined, resultRecorded: boolean, nudged: boolean) => !!role?.endsWith('-verifier') && !resultRecorded && !nudged;
const isOneShot = (role?: string) => role === 'archive';

export default function (pi: ExtensionAPI) {
  const change = process.env.HERDR_CHANGE_ID;
  const role = process.env.HERDR_ROLE;
  const root = change ? join(process.cwd(), '.herdr-workflow', change) : undefined;
  const telemetryPath = root && join(root, 'telemetry.jsonl');
  const tracesPath = root && join(root, 'traces.jsonl');
  const healthPath = join(process.env.HOME ?? '', '.pi', 'agent', 'herdr-provider-health.json');
  const captureContent = () => telemetryConfig().captureContent;
  const managedRole = !!role && role !== 'manager';
  const restricted = !!role && !['manager', 'planner', 'worker'].includes(role);
  const oneShot = isOneShot(role);
  const commandStart = String.raw`(?:^|[\n;&|()'"])\s*`;
  const agentExecutable = new RegExp(`${commandStart}(?:(?:command|exec|nohup)\\s+)?(?:env(?:\\s+[A-Za-z_][A-Za-z0-9_]*=\\S+)*\\s+)?(?:\\S*\\/)?(?:pi|opencode|claude|codex)(?=\\s|$)`, 'i');
  const agentRunner = new RegExp(`${commandStart}(?:npx|bunx|uvx)\\s+(?:pi|opencode|claude|codex)(?=\\s|$)`, 'i');
  const herdrSpawner = new RegExp(`${commandStart}(?:\\S*\\/)?herdr\\s+(?:agent\\s+(?:start|prompt)|pane\\s+run)\\b`, 'i');
  let model = 'unknown';
  let operation: Span | undefined;
  let currentPrompt = '';
  let operationToolCalls = 0;
  let fallbackAttempted = false;
  let fallbackRetryPending = false;
  let emptySettleNudged = false;
  let emptySettleRetryPending = false;
  let previousContextTokens: number | undefined;
  let compactionPending = false;
  let workerHandoffComplete = false;
  const workerVerifyCalls = new Set<string>();
  const tools = new Map<string, Span>();
  const turns = new Map<number, Span>();
  const attributes = (extra: Record<string, string | number | boolean> = {}) => ({ 'service.name': 'herdr-agent', ...(change ? { 'herdr.change.id': change } : {}), ...(role ? { 'herdr.role': role } : {}), ...extra });
  const write = (event: string, fields: Record<string, unknown> = {}) => { if (!telemetryPath) return; try { mkdirSync(root!, { recursive: true }); appendFileSync(telemetryPath, JSON.stringify({ at: new Date().toISOString(), event, role, ...fields }) + '\n'); } catch { /* telemetry must not affect agent */ } };
  const exportSpan = (span: Span) => {
    if (!span.endTimeUnixNano) return;
    if (tracesPath) try { mkdirSync(root!, { recursive: true }); appendFileSync(tracesPath, JSON.stringify(span) + '\n'); } catch { /* local fallback is best effort */ }
    const attributes = Object.entries(span.attributes).filter(([key]) => !key.startsWith('herdr.content.')).map(([key, attribute]) => ({
      key,
      value: typeof attribute === 'string' ? { stringValue: attribute } : typeof attribute === 'boolean' ? { boolValue: attribute } : { intValue: String(attribute) },
    }));
    const body = { resourceSpans: [{ resource: { attributes: [{ key: 'service.name', value: { stringValue: 'herdr-agent' } }] }, scopeSpans: [{ scope: { name: 'herdr-telemetry' }, spans: [{ traceId: span.traceId, spanId: span.spanId, parentSpanId: span.parentSpanId, name: span.name, startTimeUnixNano: span.startTimeUnixNano, endTimeUnixNano: span.endTimeUnixNano, attributes, status: span.status === 'ERROR' ? { code: 2 } : { code: 1 } }] }] }] };
    void fetch(endpoint(), { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body), signal: AbortSignal.timeout(750) }).catch(() => undefined);
  };
  const start = (name: string, parent?: Context, extra: Record<string, string | number | boolean> = {}): Span => ({ traceId: parent?.traceId ?? hex(16), spanId: hex(8), parentSpanId: parent?.spanId, name, startTimeUnixNano: now(), attributes: attributes(extra) });
  const end = (span: Span | undefined, status: 'OK' | 'ERROR' = 'OK') => { if (!span || span.endTimeUnixNano) return; span.endTimeUnixNano = now(); span.status = status; exportSpan(span); };
  const traceEvent = (event: string, extra: Record<string, string | number | boolean> = {}, status: 'OK' | 'ERROR' = 'OK') => end(start(`agent.${event}`, operation ? { traceId: operation.traceId, spanId: operation.spanId } : undefined, extra), status);
  const consumeHandoff = () => {
    if (!root || !role) return undefined;
    const path = join(root, 'trace-context', `${role}.json`);
    try { const value = JSON.parse(readFileSync(path, 'utf8')); unlinkSync(path); return Number(value.expiresAt) > Date.now() ? { context: parseTraceparent(value.traceparent), messageId: typeof value.messageId === 'string' ? value.messageId : undefined, attributes: value.attributes as Record<string, string | number | boolean> } : undefined; } catch { return undefined; }
  };
  const verifierResultRecorded = () => {
    if (!root || !role?.endsWith('-verifier')) return false;
    try { return Boolean(JSON.parse(readFileSync(join(root, 'state.json'), 'utf8')).verificationResults?.[role]); } catch { return false; }
  };
  const recordProviderFailure = (status: number) => { if (status !== 429 && status < 500) return undefined; try { const health = JSON.parse(readFileSync(healthPath, 'utf8')) as Record<string, { failures: number; lastFailure: string }>; const provider = model.split('/')[0] ?? 'unknown'; const previous = health[provider]; const recent = previous && Date.now() - Date.parse(previous.lastFailure) < 120_000; health[provider] = { failures: recent ? previous.failures + 1 : 1, lastFailure: new Date().toISOString() }; writeFileSync(healthPath, JSON.stringify(health)); return health[provider].failures; } catch { return undefined; } };
  pi.on('before_agent_start', (event: any, ctx: any) => { model = modelName(ctx.model) ?? model; const handoff = consumeHandoff(); const session = ctx.sessionManager?.getSessionId?.() ?? 'unknown'; const leaf = handoff?.messageId ?? ctx.sessionManager?.getLeafEntry?.()?.id ?? hex(8); const prompt = String(event.prompt ?? ''); if (fallbackRetryPending) fallbackRetryPending = false; else fallbackAttempted = false; if (emptySettleRetryPending) emptySettleRetryPending = false; else emptySettleNudged = false; currentPrompt = prompt; operationToolCalls = 0; workerHandoffComplete = false; workerVerifyCalls.clear(); operation = start('agent.operation', handoff?.context, { ...handoff?.attributes, 'herdr.message.id': String(leaf), 'herdr.message.hash': createHash('sha256').update(prompt).digest('hex'), 'herdr.message.bytes': Buffer.byteLength(prompt), ...(captureContent() ? { 'herdr.content.input': prompt } : {}), 'pi.session.id': String(session), 'gen_ai.operation.name': 'invoke_agent' }); if (managedRole) return { systemPrompt: `${event.systemPrompt}\n\nNever run filesystem-global searches. Scope find, rg, grep, and mdfind to an explicit directory; do not search / or the entire home directory. Outside-repository directories are allowed when relevant.` }; });
  pi.on('model_select', (event: any) => { model = modelName(event.model) ?? 'unknown'; write('model_selected', { model }); traceEvent('model_selected', { 'gen_ai.request.model': model }); });
  pi.on('agent_start', () => { write('pi_agent_start', { model }); traceEvent('started', { 'gen_ai.request.model': model }); });
  pi.on('agent_end', () => { write('pi_agent_end'); traceEvent('ended'); });
  pi.on('agent_settled', async (_event: any, ctx: any) => {
    const resultRecorded = verifierResultRecorded();
    const fallback = telemetryConfig().verifierFallback;
    const fromModel = model;
    let retryPrompt: string | undefined;
    traceEvent('settled');
    if (role?.endsWith('-verifier') && !resultRecorded) {
      write('verifier_empty_settle', { model, toolCalls: operationToolCalls });
      traceEvent('verifier_empty_settle', { 'gen_ai.request.model': model, 'herdr.tool.call_count': operationToolCalls }, 'ERROR');
      if (shouldRuntimeFallback(role, resultRecorded, fallbackAttempted, model, fallback)) {
        fallbackAttempted = true;
        const slash = fallback!.indexOf('/');
        const fallbackModel = slash > 0 ? ctx.modelRegistry.find(fallback!.slice(0, slash), fallback!.slice(slash + 1)) : undefined;
        if (fallbackModel && await pi.setModel(fallbackModel)) {
          write('verifier_runtime_fallback', { fromModel, fallback });
          traceEvent('verifier_runtime_fallback', { 'gen_ai.request.model': fromModel, 'herdr.fallback.model': fallback! });
          fallbackRetryPending = true;
          retryPrompt = currentPrompt;
        } else {
          write('verifier_runtime_fallback_error', { fromModel, fallback });
          traceEvent('verifier_runtime_fallback_error', { 'gen_ai.request.model': fromModel, 'herdr.fallback.model': fallback! }, 'ERROR');
        }
      }
      // No fallback configured (or it was already spent this round): nudge the
      // same model once to finish and report, rather than leaving the round
      // stuck forever waiting on a result that will never arrive.
      if (!retryPrompt && shouldNudgeEmptySettle(role, resultRecorded, emptySettleNudged)) {
        emptySettleNudged = true;
        emptySettleRetryPending = true;
        write('verifier_empty_settle_nudged');
        traceEvent('verifier_empty_settle_nudged');
        retryPrompt = EMPTY_SETTLE_NUDGE_PROMPT;
      }
    }
    end(operation);
    operation = undefined;
    write('pi_agent_settled');
    if (retryPrompt) {
      try { pi.sendUserMessage(retryPrompt); return; }
      catch (error) { fallbackRetryPending = false; emptySettleRetryPending = false; write('verifier_runtime_fallback_error', { fromModel, fallback, error: String(error) }); }
    }
    if (oneShot) ctx.shutdown();
  });
  pi.on('session_compact', (event: any) => { compactionPending = false; previousContextTokens = undefined; const tokensBefore = Number(event.compactionEntry?.tokensBefore ?? 0); write('compaction_completed', { reason: event.reason, tokensBefore }); traceEvent('compaction_completed', { 'herdr.compaction.reason': String(event.reason), 'gen_ai.usage.context_tokens_before': tokensBefore }); });
  pi.on('turn_start', (event: any, ctx: any) => { model = modelName(ctx.model) ?? model; if (operation) turns.set(event.turnIndex, start('gen_ai.chat', operation, { 'gen_ai.provider.name': model.split('/')[0] ?? 'unknown', 'gen_ai.request.model': model })); });
  pi.on('turn_end', (event: any, ctx: any) => {
    const span = turns.get(event.turnIndex);
    if (span) {
      const usage = event.message?.usage;
      const tokens = usage && tokenUsage(usage);
      Object.assign(span.attributes, { ...(captureContent() && assistantText(event.message) ? { 'herdr.content.output': assistantText(event.message) } : {}), ...(tokens ? { 'gen_ai.usage.input_tokens': tokens.inputTokens, 'gen_ai.usage.output_tokens': tokens.outputTokens, 'gen_ai.usage.cache_read_tokens': tokens.cacheReadTokens, 'gen_ai.usage.cache_write_tokens': tokens.cacheWriteTokens, 'gen_ai.usage.total_tokens': tokens.totalTokens, 'gen_ai.usage.cost': Number(usage.cost?.total ?? 0) } : {}) });
    }
    end(span);
    const contextTokens = ctx.getContextUsage()?.tokens;
    if (typeof contextTokens !== 'number') return;
    if (!workerHandoffComplete && shouldCompact(role, previousContextTokens, contextTokens, compactionPending)) {
      const resume = () => {
        try {
          if (resumeAfterCompaction(role, (prompt) => pi.sendUserMessage(prompt))) {
            write('compaction_resumed');
            traceEvent('compaction_resumed');
          }
        } catch (error) {
          write('compaction_resume_error', { error: String(error) });
          traceEvent('compaction_resume_error', { 'error.message': String(error) }, 'ERROR');
        }
      };
      compactionPending = true;
      write('compaction_requested', { contextTokens });
      traceEvent('compaction_requested', { 'gen_ai.usage.context_tokens': contextTokens });
      ctx.compact({
        onComplete: resume,
        onError: (error: Error) => {
          compactionPending = false;
          previousContextTokens = undefined;
          write('compaction_error', { error: error.message });
          traceEvent('compaction_error', { 'error.message': error.message }, 'ERROR');
          resume();
        },
      });
    }
    previousContextTokens = contextTokens;
  });
  pi.on('tool_execution_start', (event: any) => { operationToolCalls++; if (operation) tools.set(event.toolCallId, start(`tool.${event.toolName}`, operation, { 'tool.name': event.toolName, 'tool.call.id': event.toolCallId, ...(captureContent() ? { 'herdr.content.tool_input': json(event.args) } : {}) })); });
  pi.on('tool_call', (event: any, ctx: any) => { const command = String(event.input?.command ?? ''); if (role === 'worker' && workerHandoffComplete) return { block: true, reason: 'Verification handoff already succeeded. Stop immediately without more tool calls.' }; if (role === 'worker' && event.toolName === 'bash' && isWorkerVerifyCommand(command)) workerVerifyCalls.add(event.toolCallId); if (role === 'worker' && isWorkflowStateAccess(event.toolName, event.input)) { write('workflow_state_access_blocked', { tool: event.toolName }); traceEvent('workflow_state_access_blocked', { 'tool.name': event.toolName }, 'ERROR'); return { block: true, reason: 'Workflow state is owned by the orchestrator. Use documented herdr-workflow commands; report a phase/base/state blocker and stop instead of reading or changing state.json.' }; } if (managedRole && event.toolName === 'bash' && isGlobalSearch(command, ctx.cwd ?? process.cwd())) { write('global_search_blocked', { command: command.slice(0, 500) }); traceEvent('global_search_blocked', { 'tool.name': event.toolName }, 'ERROR'); return { block: true, reason: 'Filesystem-global search blocked. Specify a directory narrower than / or the entire home directory.' }; } if (restricted && event.toolName === 'bash' && (agentExecutable.test(command) || agentRunner.test(command) || herdrSpawner.test(command))) { write('nested_agent_blocked', { command: command.slice(0, 500) }); traceEvent('nested_agent_blocked', { 'tool.name': event.toolName }, 'ERROR'); return { block: true, reason: 'Restricted workflow roles must complete work themselves; nested agent spawning is blocked.' }; } if (event.toolName === 'bash') { const span = tools.get(event.toolCallId); if (span && event.input?.command) event.input.command = `TRACEPARENT=${JSON.stringify(traceparent(span))} ${event.input.command}`; } });
  pi.on('tool_execution_end', (event: any, ctx: any) => {
    const span = tools.get(event.toolCallId);
    const workerVerify = workerVerifyCalls.delete(event.toolCallId);
    if (span && captureContent()) span.attributes['herdr.content.tool_output'] = json(event.result);
    end(span, event.isError ? 'ERROR' : 'OK');
    tools.delete(event.toolCallId);
    if (event.isError) {
      write('tool_error', { tool: event.toolName });
      traceEvent('tool_error', { 'tool.name': event.toolName }, 'ERROR');
    }
    if (workerVerify && verificationHandoffSucceeded(event.isError, event.result)) {
      workerHandoffComplete = true;
      write('worker_verification_handoff_complete');
      traceEvent('worker_verification_handoff_complete');
      ctx.abort();
    }
  });
  pi.on('after_provider_response', (event: any) => { const retryAfter = event.headers?.['retry-after']; const failures = recordProviderFailure(event.status); write('provider_response', { status: event.status, retryAfter, model, failures }); traceEvent('provider_response', { 'http.response.status_code': Number(event.status), 'gen_ai.request.model': model, ...(retryAfter ? { 'http.response.header.retry_after': String(retryAfter) } : {}), ...(failures ? { 'herdr.provider.failures': failures } : {}) }, event.status >= 400 ? 'ERROR' : 'OK'); });
  pi.on('message_end', (event: any) => { if (event.message?.role !== 'assistant') return; const usage = event.message.usage; if (usage) write('model_usage', { ...tokenUsage(usage), cost: usage.cost?.total }); });
}

export const telemetryTest = { parseTraceparent, traceparent, tokenUsage, shouldCompact, resumeAfterCompaction, isGlobalSearch, isWorkflowStateAccess, isWorkerVerifyCommand, verificationHandoffSucceeded, shouldRuntimeFallback, shouldNudgeEmptySettle, isOneShot };
