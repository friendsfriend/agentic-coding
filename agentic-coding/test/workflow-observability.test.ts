import { expect, test } from 'bun:test';
import { boundedRuntimeAttributes, childTrace, parseTraceparent, traceparent } from '../src/workflow/observability.ts';

test('W3C trace context propagates with new child identity', () => { const parent = parseTraceparent('00-0123456789abcdef0123456789abcdef-0123456789abcdef-01')!; const child = childTrace(parent); expect(child.traceId).toBe(parent.traceId); expect(child.spanId).not.toBe(parent.spanId); expect(parseTraceparent(traceparent(child))).toEqual(child); expect(parseTraceparent('broken')).toBeUndefined() });
test('runtime fields are bounded and content is local opt-in', () => { expect(boundedRuntimeAttributes({ content: 'secret', model: 'x', tokens: 2 })).toEqual({ model: 'x', tokens: 2 }); expect(boundedRuntimeAttributes({ content: 'x'.repeat(9000) }, true).content).toHaveLength(8192) });
