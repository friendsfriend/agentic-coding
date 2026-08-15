const fs = require('node:fs');
const path = require('node:path');
const SECRET_PATTERN = /(-----BEGIN[\s\S]*?-----END[^\n]*|sk-[A-Za-z0-9_-]{16,}|gh[pousr]_[A-Za-z0-9]{16,}|AKIA[0-9A-Z]{16}|xox[baprs]-[A-Za-z0-9-]{10,}|github_pat_[A-Za-z0-9_]{20,}|HERDR_RUN_TOKEN=[^\s]+)/g;
const redact = text => text.replace(SECRET_PATTERN, '[REDACTED]');
function emit(event, fields = {}) {
  const output = process.env.HERDR_TELEMETRY_PATH;
  const envelope = { schemaVersion: 1, at: new Date().toISOString(), layer: 'runtime', runtime: 'opencode-v2', event, workflowId: process.env.HERDR_WORKFLOW_ID, runId: process.env.HERDR_RUN_ID, stepId: process.env.HERDR_STEP_ID, role: process.env.HERDR_ROLE, profile: process.env.HERDR_PROFILE, traceparent: process.env.TRACEPARENT, ...fields };
  if (output) try { fs.mkdirSync(path.dirname(output), { recursive: true }); fs.appendFileSync(output, JSON.stringify(envelope) + '\n'); } catch {}
  const endpoint = process.env.OTEL_EXPORTER_OTLP_ENDPOINT; if (endpoint) void fetch(`${endpoint.replace(/\/$/, '')}/v1/logs`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(envelope), signal: AbortSignal.timeout(750) }).catch(() => undefined);
}
// Telemetry only: runtime lifecycle events. Handoff and checks go through the
// agent's normal tools (`agentic-coding workflow handoff`).
module.exports = async () => ({ event: async ({ event }) => emit(`runtime.${event.type}`, { sessionId: event.properties?.sessionID }) });
