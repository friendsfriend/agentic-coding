import { randomBytes } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

export interface TraceContext { traceId: string; spanId: string; flags: string }
export interface TelemetryEnvelope {
  schemaVersion: 1; at: string; layer: 'engine' | 'adapter' | 'runtime'; event: string; outcome?: 'ok' | 'error'; durationMs?: number;
  workflowId: string; runId?: string; stepId?: string; role?: string; profile?: string; runtime?: string; messageId?: string; effectId?: string;
  traceparent?: string; attributes?: Record<string, string | number | boolean>;
}
export function parseTraceparent(value?: string): TraceContext | undefined { const match = value?.match(/^00-([0-9a-f]{32})-([0-9a-f]{16})-([0-9a-f]{2})$/i); return match && !/^0+$/.test(match[1]!) && !/^0+$/.test(match[2]!) ? { traceId: match[1]!, spanId: match[2]!, flags: match[3]! } : undefined }
export function childTrace(parent?: TraceContext): TraceContext { return { traceId: parent?.traceId ?? randomBytes(16).toString('hex'), spanId: randomBytes(8).toString('hex'), flags: parent?.flags ?? '01' } }
export function traceparent(context: TraceContext): string { return `00-${context.traceId}-${context.spanId}-${context.flags}` }
export class TelemetrySink {
  constructor(private readonly directory: string, private readonly exportUrl?: string) {}
  emit(envelope: TelemetryEnvelope): void {
    try { fs.mkdirSync(this.directory, { recursive: true }); fs.appendFileSync(path.join(this.directory, 'telemetry.jsonl'), `${JSON.stringify(envelope)}\n`) } catch { /* observational */ }
    if (this.exportUrl) void fetch(this.exportUrl, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(envelope), signal: AbortSignal.timeout(750) }).catch(() => undefined);
  }
}
export function boundedRuntimeAttributes(value: Record<string, unknown>, captureContent = false): Record<string, string | number | boolean> {
  const result: Record<string, string | number | boolean> = {};
  for (const [key, item] of Object.entries(value)) {
    if (!captureContent && key.toLowerCase().includes('content')) continue;
    if (typeof item === 'string') result[key] = item.slice(0, 8192); else if (typeof item === 'number' || typeof item === 'boolean') result[key] = item;
  }
  return result;
}
