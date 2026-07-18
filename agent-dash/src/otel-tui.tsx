/** @jsxImportSource @opentui/solid */
import { createCliRenderer } from '@opentui/core';
import { render } from '@opentui/solid';
import { createSignal, onCleanup, onMount } from 'solid-js';
import { readFileSync, existsSync } from 'node:fs';
import { decodeJsonl, retain, type TraceSpan } from './traces';
import { handleOtlpRequest } from './receiver';
import { TraceBrowser } from './ui/TraceBrowser';
import { applyTheme, loadThemeName } from './theme-settings';
import { uiColors } from './ui/colors';

const option = (name: string) => { const index = process.argv.indexOf(name); return index >= 0 ? process.argv[index + 1] : undefined; };
const host = option('--host') ?? '127.0.0.1';
const port = Number(option('--port') ?? 4318);
const maxSpans = Math.max(1, Math.min(100_000, Number(option('--max-spans') ?? 10_000)));
const file = option('--file');
const filter = option('--filter') ?? '';
const usage = 'usage: otel-tui [--host HOST] [--port PORT] [--max-spans N] [--file traces.jsonl] [--filter TEXT]\nOTLP HTTP JSON receiver has no authentication; keep non-loopback hosts protected.';
if (process.argv.includes('--help') || process.argv.includes('-h')) { console.log(usage); process.exit(0); }
if (!Number.isInteger(port) || port < 1 || port > 65535 || !Number.isInteger(maxSpans)) { console.error(usage); process.exit(2); }
function Viewer() {
  const [spans, setSpans] = createSignal<TraceSpan[]>(file && existsSync(file) ? retain(decodeJsonl(readFileSync(file, 'utf8')), maxSpans) : []);
  const append = (next: TraceSpan[]) => setSpans(current => retain([...current, ...next], maxSpans));
  const server = Bun.serve({ hostname: host, port, fetch: request => handleOtlpRequest(request, append) });
  onMount(() => { let imported = file && existsSync(file) ? readFileSync(file, 'utf8') : ''; const timer = file ? setInterval(() => { try { const current = readFileSync(file, 'utf8'); if (current.startsWith(imported)) append(decodeJsonl(current.slice(imported.length))); else setSpans(retain(decodeJsonl(current), maxSpans)); imported = current; } catch { /* file may not exist yet */ } }, 1000) : undefined; onCleanup(() => { if (timer) clearInterval(timer); server.stop(); }); });
  return <box width="100%" height="100%" backgroundColor={uiColors.bgBase} padding={1} flexDirection="column"><text fg={uiColors.primary}>OTEL TUI · {host}:{port} · {spans().length}/{maxSpans} spans</text><text fg={uiColors.textMuted}>POST OTLP HTTP JSON to /v1/traces · receiver has no authentication</text><TraceBrowser spans={spans()} filter={filter} /></box>;
}
applyTheme(loadThemeName()); process.env.FORCE_COLOR = '3';
const renderer = await createCliRenderer({ targetFps: 30, exitOnCtrlC: true, useKittyKeyboard: {} });
await render(() => <Viewer />, renderer);
await new Promise<void>(done => renderer.once('destroy', done));
