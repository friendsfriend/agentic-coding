// Tracing/telemetry emission — the workflow's telemetry-concern module. Pure math
// lives in tracing.ts; this module owns the file I/O and OTLP export side effects.
import fs from 'node:fs';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import type { Context } from './effects.ts';
import * as stateMod from './state.ts';
import type { WorkflowState } from './state.ts';
import * as tracing from './tracing.ts';
import type { TraceContext } from './tracing.ts';

function appendTrace(root: string, record: tracing.SpanRecord): void {
  fs.appendFileSync(path.join(root, 'traces.jsonl'), JSON.stringify(record) + '\n');
}

export function workspaceContext(ctx: Context, state: WorkflowState): TraceContext {
  const existing = state.otelTraceRoot as TraceContext | undefined;
  if (existing && tracing.parseTraceparent(tracing.traceparent(existing))) return existing;
  const context = tracing.childContext(tracing.parseTraceparent(process.env.TRACEPARENT));
  state.otelTraceRoot = context;
  state.otelTraceRootStartedUnixNano = String(ctx.clock.timeNs());
  return context;
}

export function finalizeWorkspaceTrace(ctx: Context, state: WorkflowState): void {
  if (state.otelTraceRootFinalized) return;
  const context = workspaceContext(ctx, state);
  const root = stateMod.workflowDir(state);
  const end = String(ctx.clock.timeNs());
  const record = tracing.spanRecord(context, 'workflow.workspace', state.otelTraceRootStartedUnixNano ?? end, end, {
    'service.name': 'herdr-workflow',
    'herdr.change.id': state.changeId,
    'herdr.phase': state.phase ?? 'completed',
  });
  appendTrace(root, record);
  ctx.exporter.export(record);
  state.otelTraceRootFinalized = true;
  stateMod.saveState(state);
}

export function telemetry(ctx: Context, state: WorkflowState, event: string, options: { spanStatus?: string; [field: string]: unknown } = {}): TraceContext | undefined {
  const { spanStatus = 'OK', ...fields } = options;
  const root = stateMod.workflowDir(state);
  fs.mkdirSync(root, { recursive: true });
  const at = ctx.clock.now();
  fs.appendFileSync(path.join(root, 'telemetry.jsonl'), JSON.stringify({ at: at.toISOString(), event, change: state.changeId, ...fields }) + '\n');
  const parent = tracing.parseTraceparent(process.env.TRACEPARENT) ?? workspaceContext(ctx, state);
  const context = tracing.childContext(parent);
  const nanos = String(Math.trunc(at.getTime() * 1_000_000));
  const attributes: Record<string, unknown> = {
    'service.name': 'herdr-workflow',
    'herdr.change.id': state.changeId,
    'herdr.phase': state.phase ?? 'unknown',
    'herdr.verification.round': state.verificationRound ?? 0,
    'herdr.span_status': spanStatus,
  };
  for (const [key, value] of Object.entries(fields)) {
    if (['string', 'number', 'boolean'].includes(typeof value)) attributes[`herdr.${key}`] = value;
  }
  const record = tracing.spanRecord(context, `workflow.${event}`, nanos, nanos, attributes, parent ? parent.spanId : null, spanStatus);
  appendTrace(root, record);
  ctx.exporter.export(record);
  return context;
}

export function changePhase(ctx: Context, state: WorkflowState, target: string, fields: Record<string, unknown> = {}): void {
  const source = state.phase;
  // Commit under one write transaction (re-reading the row) so a phase change
  // never clobbers a concurrently committed verifier result. The caller's
  // in-memory object is updated with the same phase fields — accumulate-then-
  // save callers (cmdVerify) keep their pending mutations on the object.
  stateMod.setPhase(state, target);
  stateMod.updateState(state.worktree, state.changeId, s => stateMod.setPhase(s, target));
  telemetry(ctx, state, 'phase_changed', { source, target, ...fields });
}

export function traceItems(ctx: Context, state: WorkflowState, event: string, field: string, values: unknown[], fields: Record<string, unknown> = {}): void {
  values.forEach((value, index) => telemetry(ctx, state, event, { item_index: index + 1, [field]: value, ...fields }));
}

export function traceFindings(ctx: Context, state: WorkflowState, event: string, findingsList: Array<Record<string, any>>, status?: string): void {
  for (const finding of findingsList) {
    telemetry(ctx, state, event, {
      finding_id: finding.id,
      role: finding.role,
      severity: finding.severity,
      status: status ?? finding.status,
      finding_path: finding.path,
      finding_line: finding.line,
      description: finding.detail,
      evidence: finding.evidence,
      resolution: finding.fix,
    });
  }
}

export function writeTraceHandoff(ctx: Context, state: WorkflowState, role: string): void {
  const root = path.join(stateMod.workflowDir(state), 'trace-context');
  fs.mkdirSync(root, { recursive: true });
  const parent = tracing.parseTraceparent(process.env.TRACEPARENT) ?? workspaceContext(ctx, state);
  const action = tracing.childContext(parent);
  const nanos = String(Math.trunc(ctx.clock.now().getTime() * 1_000_000));
  const attributes = {
    'service.name': 'herdr-workflow',
    'herdr.change.id': state.changeId,
    'herdr.role': role,
    'herdr.phase': state.phase ?? 'unknown',
    'herdr.verification.round': state.verificationRound ?? 0,
  };
  const record = tracing.spanRecord(action, `workflow.prompt.${role}`, nanos, nanos, attributes, parent ? parent.spanId : null);
  appendTrace(stateMod.workflowDir(state), record);
  ctx.exporter.export(record);
  const payload = {
    traceparent: tracing.traceparent(action),
    expiresAt: Math.trunc(ctx.clock.time() * 1000) + 120_000,
    messageId: randomUUID().replace(/-/g, ''),
    operation: `workflow.prompt.${role}`,
    attributes,
  };
  const p = path.join(root, `${role}.json`);
  const tmp = `${p}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(payload));
  fs.renameSync(tmp, p);
}
