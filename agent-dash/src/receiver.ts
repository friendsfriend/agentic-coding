import { decodeOtlp, type TraceSpan } from './traces';

async function body(request: Request) {
  const reader = request.body?.getReader();
  if (!reader) return '';
  let size = 0;
  const chunks: ArrayBuffer[] = [];
  for (;;) {
    const next = await reader.read();
    if (next.done) return new Blob(chunks).text();
    size += next.value.byteLength;
    if (size > 1_000_000) throw new RangeError('payload too large');
    chunks.push(next.value.buffer.slice(next.value.byteOffset, next.value.byteOffset + next.value.byteLength) as ArrayBuffer);
  }
}

export async function handleOtlpRequest(request: Request, accept: (spans: TraceSpan[]) => void): Promise<Response> {
  if (request.method !== 'POST' || new URL(request.url).pathname !== '/v1/traces') return new Response('not found', { status: 404 });
  if (!request.headers.get('content-type')?.toLowerCase().includes('application/json')) return new Response('OTLP HTTP JSON required', { status: 415 });
  if (Number(request.headers.get('content-length') ?? 0) > 1_000_000) return new Response('payload too large', { status: 413 });
  try {
    const spans = decodeOtlp(JSON.parse(await body(request)));
    if (!spans.length) return Response.json({ partialSuccess: { rejectedSpans: 1, errorMessage: 'no valid spans' } }, { status: 400 });
    accept(spans);
    return Response.json({ partialSuccess: {} });
  } catch (error) {
    return new Response(error instanceof RangeError ? error.message : 'invalid JSON', { status: error instanceof RangeError ? 413 : 400 });
  }
}
