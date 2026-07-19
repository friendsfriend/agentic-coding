import { Database } from 'bun:sqlite';
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { parseJsonl } from './parser';
import type { SpanData } from './types';

interface TraceRow {
  id: number;
  change_id: string;
  span: string;
  ingested_at: string;
}

interface WorkspaceRow {
  id: number;
  change_id: string;
  path: string;
  file_mtime: number;
}

export class TraceDb {
  private db: Database;
  private ingestStmt: any;
  private upsertWorkspaceStmt: any;

  constructor(dbPath?: string) {
    const dir = dbPath ?? join(homedir(), '.config', 'otel-tui');
    mkdirSync(dir, { recursive: true });
    this.db = new Database(join(dir, 'traces.sqlite'));
    this.db.run(`CREATE TABLE IF NOT EXISTS traces (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      change_id TEXT NOT NULL,
      span TEXT NOT NULL,
      ingested_at TEXT NOT NULL DEFAULT (datetime('now'))
    )`);
    this.db.run(`CREATE INDEX IF NOT EXISTS idx_traces_change ON traces(change_id)`);
    this.db.run(`CREATE TABLE IF NOT EXISTS workspace_files (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      change_id TEXT UNIQUE NOT NULL,
      path TEXT NOT NULL,
      file_mtime INTEGER NOT NULL DEFAULT 0,
      parser_version INTEGER NOT NULL DEFAULT 1
    )`);
    try { this.db.run('ALTER TABLE workspace_files ADD COLUMN parser_version INTEGER NOT NULL DEFAULT 1'); } catch { /* existing database */ }
    this.ingestStmt = this.db.prepare('INSERT INTO traces (change_id, span, ingested_at) VALUES ($change_id, $span, datetime(\'now\'))');
    this.upsertWorkspaceStmt = this.db.prepare('INSERT INTO workspace_files (change_id, path, file_mtime, parser_version) VALUES ($change_id, $path, $mtime, 2) ON CONFLICT(change_id) DO UPDATE SET path=$path, file_mtime=$mtime, parser_version=2');
  }

  ingestWorkspace(herdrPath: string, changeId: string): number {
    const tracesFile = join(herdrPath, 'traces.jsonl');
    if (!existsSync(tracesFile)) return 0;
    const mtime = Math.floor(statSync(tracesFile).mtimeMs);
    const known = this.db.prepare('SELECT file_mtime, parser_version FROM workspace_files WHERE change_id=?').get(changeId) as { file_mtime: number; parser_version?: number } | undefined;
    if (known && known.file_mtime >= mtime && (known.parser_version ?? 1) >= 2) return 0;
    const text = readFileSync(tracesFile, 'utf8');
    const spans = parseJsonl(text);
    // Remove old traces for this change and re-ingest
    this.db.run('DELETE FROM traces WHERE change_id=?', [changeId]);
    const insert = this.db.transaction(() => {
      for (const span of spans) {
        this.ingestStmt.run({ $change_id: changeId, $span: JSON.stringify(span) });
      }
      this.upsertWorkspaceStmt.run({ $change_id: changeId, $path: tracesFile, $mtime: mtime });
    });
    insert();
    return spans.length;
  }

  loadSpans(changeId?: string): SpanData[] {
    const rows = changeId
      ? this.db.prepare('SELECT span FROM traces WHERE change_id=? ORDER BY id').all(changeId) as TraceRow[]
      : this.db.prepare('SELECT span FROM traces ORDER BY id').all() as TraceRow[];
    return rows.map(r => JSON.parse(r.span) as SpanData);
  }

  cleanupOlderThan(days = 30): number {
    const cutoff = (BigInt(Date.now() - days * 86_400_000) * 1_000_000n).toString();
    const result = this.db.run("DELETE FROM traces WHERE CAST(json_extract(span, '$.endTimeUnixNano') AS TEXT) < ?", [cutoff]);
    this.db.run('DELETE FROM workspace_files WHERE NOT EXISTS (SELECT 1 FROM traces WHERE traces.change_id = workspace_files.change_id)');
    return Number(result.changes ?? 0);
  }

  getWorkspaces(): Array<{ changeId: string; path: string; spanCount: number }> {
    return this.db.prepare(`
      SELECT w.change_id AS changeId, w.path, COUNT(t.id) AS spanCount
      FROM workspace_files w LEFT JOIN traces t ON w.change_id = t.change_id
      GROUP BY w.change_id ORDER BY w.change_id
    `).all() as Array<{ changeId: string; path: string; spanCount: number }>;
  }

  scanAllWorkspaces(repoRoot: string): number {
    const workflowDir = join(repoRoot, '.herdr-workflow');
    if (!existsSync(workflowDir)) return 0;
    let total = 0;
    try {
      const entries = readdirSync(workflowDir, { withFileTypes: true });
      for (const entry of entries) {
        if (!entry.isDirectory()) continue;
        const count = this.ingestWorkspace(join(workflowDir, entry.name), entry.name);
        total += count;
      }
    } catch {}
    return total;
  }

  watchWorkspaces(repoRoot: string, onNew: (changeId: string, spans: SpanData[]) => void): () => void {
    const timer = setInterval(() => {
      const workflowDir = join(repoRoot, '.herdr-workflow');
      if (!existsSync(workflowDir)) return;
      try {
        const entries = readdirSync(workflowDir, { withFileTypes: true });
        for (const entry of entries) {
          if (!entry.isDirectory()) continue;
          const tracesFile = join(workflowDir, entry.name, 'traces.jsonl');
          if (!existsSync(tracesFile)) continue;
          const mtime = Math.floor(statSync(tracesFile).mtimeMs);
          const known = this.db.prepare('SELECT file_mtime, parser_version FROM workspace_files WHERE change_id=?').get(entry.name) as { file_mtime: number; parser_version?: number } | undefined;
          if (known && known.file_mtime >= mtime && (known.parser_version ?? 1) >= 2) continue;
          const text = readFileSync(tracesFile, 'utf8');
          const spans = parseJsonl(text);
          this.db.run('DELETE FROM traces WHERE change_id=?', [entry.name]);
          const insert = this.db.transaction(() => {
            for (const span of spans) {
              this.ingestStmt.run({ $change_id: entry.name, $span: JSON.stringify(span) });
            }
            this.upsertWorkspaceStmt.run({ $change_id: entry.name, $path: tracesFile, $mtime: mtime });
          });
          insert();
          onNew(entry.name, spans);
        }
      } catch {}
    }, 2000);
    return () => clearInterval(timer);
  }

  close() { this.db.close(); }
}
