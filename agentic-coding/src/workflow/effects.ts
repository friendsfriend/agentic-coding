// Seams: the only place that touches git, subprocess, time, network, and config I/O.
// Herdr access itself lives in ../herdr-client.ts (the single shared `.result` parser).
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Herdr } from '../herdr-client.ts';
import * as paths from './paths.ts';

export { Herdr };

export function run(args: string[], cwd?: string): string {
  const result = Bun.spawnSync(args, { cwd, stdout: 'pipe', stderr: 'pipe' });
  const stdout = result.stdout.toString();
  const stderr = result.stderr.toString();
  if (result.exitCode !== 0) {
    const detail = (stderr || stdout || 'command failed').trim();
    throw new Error(`${args.join(' ')}: ${detail}`);
  }
  return stdout.trim();
}

export class Git {
  /** Wraps git subprocess calls scoped to a working directory. */
  run(args: string[], cwd: string): string {
    return run(['git', ...args], cwd);
  }
}

export class Clock {
  now(): Date {
    return new Date();
  }

  monotonic(): number {
    return Bun.nanoseconds() / 1e9;
  }

  time(): number {
    return Date.now() / 1000;
  }

  timeNs(): bigint {
    return BigInt(Date.now()) * 1_000_000n;
  }

  async sleep(seconds: number): Promise<void> {
    await Bun.sleep(seconds * 1000);
  }
}

function traceEndpoint(): string {
  const tracesEndpoint = process.env.OTEL_EXPORTER_OTLP_TRACES_ENDPOINT;
  if (tracesEndpoint) return tracesEndpoint;
  const endpoint = process.env.OTEL_EXPORTER_OTLP_ENDPOINT;
  return endpoint ? `${endpoint.replace(/\/$/, '')}/v1/traces` : 'http://127.0.0.1:4318/v1/traces';
}

export interface SpanRecordLike {
  traceId: string;
  spanId: string;
  parentSpanId?: string | null;
  name: string;
  startTimeUnixNano: string | number;
  endTimeUnixNano: string | number;
  attributes: Record<string, unknown>;
  status?: string;
}

export interface Exporter {
  export(record: SpanRecordLike): void;
}

export class TraceExporter implements Exporter {
  /** Best-effort OTLP HTTP exporter; fire-and-forget, never raises. */
  export(record: SpanRecordLike): void {
    void this.send(record).catch(() => {});
  }

  private async send(record: SpanRecordLike): Promise<void> {
    const attributes = Object.entries(record.attributes).map(([key, value]) => ({ key, value: { stringValue: String(value) } }));
    const payload = {
      resourceSpans: [
        {
          resource: { attributes: [{ key: 'service.name', value: { stringValue: 'herdr-workflow' } }] },
          scopeSpans: [
            {
              scope: { name: 'herdr-workflow' },
              spans: [
                {
                  traceId: record.traceId,
                  spanId: record.spanId,
                  parentSpanId: record.parentSpanId,
                  name: record.name,
                  startTimeUnixNano: record.startTimeUnixNano,
                  endTimeUnixNano: record.endTimeUnixNano,
                  attributes,
                  status: { code: record.status === 'ERROR' ? 2 : 1 },
                },
              ],
            },
          ],
        },
      ],
    };
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 750);
    try {
      await fetch(traceEndpoint(), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
        signal: controller.signal,
      });
    } finally {
      clearTimeout(timeout);
    }
  }
}

function deepMerge<T extends object>(base: T, overlay: unknown): T {
  const merged = structuredClone(base) as Record<string, unknown>;
  if (!overlay || typeof overlay !== 'object' || Array.isArray(overlay)) return merged as T;
  for (const [key, value] of Object.entries(overlay)) {
    if (merged[key] && typeof merged[key] === 'object' && !Array.isArray(merged[key]) && typeof value === 'object' && value !== null && !Array.isArray(value)) {
      merged[key] = deepMerge(merged[key] as Record<string, unknown>, value);
    } else merged[key] = value;
  }
  return merged as T;
}

export interface WorkflowConfig {
  /** Legacy-only input migrated by profile parser. */
  models?: Record<string, string>;
  thinking?: Record<string, string>;
  agents?: unknown;
  workflow: { max_verification_rounds: number; remote: string; branch_prefix: string; base_branch: string; pr_tool?: string };
  projects: { root: string; max_depth: number };
  telemetry: { capture_content: boolean };
  ui: { theme: string; selection_height: number };
}

/** Built-in fallback (mirror of pi/herdr-workflow.toml) — used only when no
 * config file exists anywhere. Models are intentionally NOT defaulted: an
 * unconfigured step lets pi pick its own default model. */
export const DEFAULT_CONFIG: WorkflowConfig = {
  workflow: {
    max_verification_rounds: 6,
    remote: 'origin',
    branch_prefix: 'feature/',
    base_branch: 'origin/HEAD',
  },
  projects: { root: '~/development', max_depth: 3 },
  telemetry: { capture_content: true },
  ui: { theme: 'catppuccin', selection_height: 10 },
};

export function loadConfig(): WorkflowConfig {
  // Canonical location: ~/.config/agentic-coding/config.toml. Legacy
  // ~/.pi/agent/herdr-workflow.toml (stow-based installs) still consulted as a
  // fallback; HERDR_WORKFLOW_CONFIG always wins.
  const candidates = [
    process.env.HERDR_WORKFLOW_CONFIG,
    path.join(os.homedir(), '.config', 'agentic-coding', 'config.toml'),
    path.join(os.homedir(), '.pi', 'agent', 'herdr-workflow.toml'),
  ].filter(Boolean) as string[];
  const file = candidates.find(candidate => fs.existsSync(candidate));
  const parsed = file ? (Bun.TOML.parse(fs.readFileSync(file, 'utf8')) as WorkflowConfig) : {};
  let cfg = deepMerge(structuredClone(DEFAULT_CONFIG), parsed);
  const projectConfig = path.join(process.cwd(), '.pi', 'herdr-workflow.toml');
  if (fs.existsSync(projectConfig)) {
    cfg = deepMerge(cfg, Bun.TOML.parse(fs.readFileSync(projectConfig, 'utf8')));
  }
  return cfg;
}

export interface Context {
  config: WorkflowConfig;
  herdr: Herdr;
  git: Git;
  clock: Clock;
  exporter: Exporter;
}
