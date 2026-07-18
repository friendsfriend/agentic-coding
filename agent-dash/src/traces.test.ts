import { expect, test } from 'bun:test';
import { decodeJsonl, decodeOtlp, retain, traces, tree } from './traces';
import { handleOtlpRequest } from './receiver';

const span = (id: string, parentSpanId?: string) => ({ traceId: 'a'.repeat(32), spanId: id.repeat(16), ...(parentSpanId ? { parentSpanId: parentSpanId.repeat(16) } : {}), name: id, startTimeUnixNano: '1000000', endTimeUnixNano: '2000000', attributes: { 'service.name': 'test' } });
test('decodes OTLP, ignores malformed spans, and retains hierarchy', () => {
  const decoded = decodeOtlp({ resourceSpans: [{ resource: { attributes: [{ key: 'service.name', value: { stringValue: 'test' } }] }, scopeSpans: [{ spans: [{ ...span('1'), attributes: [] }, { ...span('2', '1'), attributes: [] }, { name: 'bad' }] }] }] });
  expect(decoded).toHaveLength(2);
  expect(tree(decoded).map(row => row.depth)).toEqual([0, 1]);
  expect(traces(decoded, 'test')).toHaveLength(1);
  expect(retain([...decoded, { ...decoded[0]!, spanId: '3'.repeat(16), startTimeUnixNano: '3000000' }], 2)).toHaveLength(2);
});
test('skips malformed JSONL', () => expect(decodeJsonl(`${JSON.stringify(span('1'))}\nnope\n`)).toHaveLength(1));
test('receiver validates requests and accepts OTLP JSON', async () => {
  const accepted: unknown[] = [];
  expect((await handleOtlpRequest(new Request('http://localhost/nope'), spans => accepted.push(...spans))).status).toBe(404);
  expect((await handleOtlpRequest(new Request('http://localhost/v1/traces', { method: 'POST', body: '{}', headers: { 'content-type': 'application/json' } }), spans => accepted.push(...spans))).status).toBe(400);
  const payload = { resourceSpans: [{ scopeSpans: [{ spans: [{ ...span('1'), attributes: [] }] }] }] };
  expect((await handleOtlpRequest(new Request('http://localhost/v1/traces', { method: 'POST', body: JSON.stringify(payload), headers: { 'content-type': 'application/json' } }), spans => accepted.push(...spans))).status).toBe(200);
  expect(accepted).toHaveLength(1);
});
