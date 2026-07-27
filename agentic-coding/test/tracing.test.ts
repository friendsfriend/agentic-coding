import { describe, expect, test } from 'bun:test';
import * as tracing from '../src/workflow/tracing.ts';

describe('traceparent', () => {
  test('round trip', () => {
    const value = '00-1234567890abcdef1234567890abcdef-1234567890abcdef-01';
    const context = tracing.parseTraceparent(value)!;
    expect(context.traceId).toBe('1234567890abcdef1234567890abcdef');
    expect(context.spanId).toBe('1234567890abcdef');
    expect(tracing.traceparent(context)).toBe(value);
  });

  test('all zero trace id rejected', () => {
    const value = '00-00000000000000000000000000000000-1234567890abcdef-01';
    expect(tracing.parseTraceparent(value)).toBeNull();
  });

  test('all zero span id rejected', () => {
    const value = '00-1234567890abcdef1234567890abcdef-0000000000000000-01';
    expect(tracing.parseTraceparent(value)).toBeNull();
  });

  test('malformed rejected', () => {
    expect(tracing.parseTraceparent('not-a-traceparent')).toBeNull();
  });

  test('none input rejected', () => {
    expect(tracing.parseTraceparent(null)).toBeNull();
  });

  test('uppercase accepted and lowercased', () => {
    const value = '00-1234567890ABCDEF1234567890ABCDEF-1234567890ABCDEF-01';
    const context = tracing.parseTraceparent(value)!;
    expect(context.traceId).toBe('1234567890abcdef1234567890abcdef');
  });
});

describe('childContext', () => {
  test('root context generates new trace id', () => {
    const context = tracing.childContext(null);
    expect(context.traceId.length).toBe(32);
    expect(context.spanId.length).toBe(16);
    expect(context.flags).toBe('01');
  });

  test('child inherits trace id and flags', () => {
    const parent = { traceId: 'a'.repeat(32), spanId: 'b'.repeat(16), flags: '01' };
    const child = tracing.childContext(parent);
    expect(child.traceId).toBe(parent.traceId);
    expect(child.spanId).not.toBe(parent.spanId);
    expect(child.flags).toBe('01');
  });
});

describe('spanRecord', () => {
  test('span record shape', () => {
    const context = { traceId: 'a'.repeat(32), spanId: 'b'.repeat(16), flags: '01' };
    const record = tracing.spanRecord(context, 'workflow.test', '1', '2', { k: 'v' }, 'parent');
    expect(record.traceId).toBe(context.traceId);
    expect(record.name).toBe('workflow.test');
    expect(record.parentSpanId).toBe('parent');
    expect(record.status).toBe('OK');
  });
});

describe('TraceExporter', () => {
  test('exports error status', async () => {
    const payloads: any[] = [];
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async (_url: string, init: any) => {
      payloads.push(JSON.parse(init.body));
      return new Response('{}');
    }) as typeof fetch;
    try {
      const { TraceExporter } = await import('../src/workflow/effects.ts');
      new TraceExporter().export({ traceId: 'a'.repeat(32), spanId: 'b'.repeat(16), name: 'test', startTimeUnixNano: '1', endTimeUnixNano: '2', attributes: {}, status: 'ERROR' });
      await new Promise(resolve => setTimeout(resolve, 10));
    } finally {
      globalThis.fetch = originalFetch;
    }
    expect(payloads[0].resourceSpans[0].scopeSpans[0].spans[0].status.code).toBe(2);
  });
});
