// Workflow state store: one SQLite row per change in <repo>/.herdr-workflow/herdr.db
// (bun:sqlite, zero deps). State stays exposed through the CLI (`status`) exactly
// as before. Legacy state.json files are migrated to the DB on first load; the
// review artifacts (request.md, reviews/, traces) remain plain files.
import fs from 'node:fs';
import path from 'node:path';
import { Database } from 'bun:sqlite';

export type WorkflowState = Record<string, any>;

// ponytail: layout fields never leave this module — kept in-memory during a single
// process run (e.g. sequential launch_role calls in cmd_dispatch_verifiers) but
// stripped before every disk write, so persisted state never carries terminal
// geometry. Legacy files that still contain them simply load as extra ignored keys.
const LAYOUT_FIELDS = ['verificationSecondRowPane', 'verificationSecondRowRole', 'verificationPaneOrder'];

/** Legacy state.json path, kept for migration reads only. */
export function statePath(repo: string, change: string): string {
  return path.join(repo, '.herdr-workflow', change, 'state.json');
}

export function dbPath(repo: string): string {
  return path.join(repo, '.herdr-workflow', 'herdr.db');
}

function openDb(repo: string): Database {
  const dir = path.join(repo, '.herdr-workflow');
  fs.mkdirSync(dir, { recursive: true });
  const db = new Database(dbPath(repo), { create: true });
  // Multi-process writers (concurrent verifier reports) wait for the lock
  // instead of failing with SQLITE_BUSY. WAL keeps readers (dashboard polls)
  // from blocking writers and vice versa.
  db.exec('PRAGMA busy_timeout = 10000');
  db.exec('PRAGMA journal_mode = WAL');
  db.exec('CREATE TABLE IF NOT EXISTS workflows (change_id TEXT PRIMARY KEY, state TEXT NOT NULL)');
  return db;
}

function upsert(db: Database, change: string, state: WorkflowState): void {
  db.query('INSERT OR REPLACE INTO workflows (change_id, state) VALUES (?, ?)').run(change, JSON.stringify(state));
}

export function loadState(repo: string, change: string): WorkflowState {
  const db = openDb(repo);
  try {
    const row = db.query('SELECT state FROM workflows WHERE change_id = ?').get(change) as { state: string } | null;
    if (row) return JSON.parse(row.state);
  } finally {
    db.close();
  }
  // Legacy migration: state.json written by pre-sqlite versions.
  const p = statePath(repo, change);
  if (fs.existsSync(p)) {
    const state = JSON.parse(fs.readFileSync(p, 'utf8')) as WorkflowState;
    const migrate = openDb(repo);
    try {
      upsert(migrate, change, state);
    } finally {
      migrate.close();
    }
    return state;
  }
  throw new Error(`workflow not found: ${p}`);
}

export function setPhase(state: WorkflowState, phase: string): void {
  state.phase = phase;
  state.phaseStartedAt = new Date().toISOString();
}

function persistedState(state: WorkflowState): WorkflowState {
  const persisted = { ...state };
  for (const field of LAYOUT_FIELDS) delete persisted[field];
  return persisted;
}

function writeMirror(state: WorkflowState, persisted: WorkflowState, skip?: string): void {
  for (const repo of new Set([state.worktree, state.repository])) {
    if (repo === skip) continue;
    const db = openDb(repo);
    try {
      upsert(db, state.changeId, persisted);
    } finally {
      db.close();
    }
  }
}

/** Persist the state object. Written to the worktree DB and, in worktree mode,
 * the repository DB — same dual-path semantics the old state.json had. */
export function saveState(state: WorkflowState): string {
  writeMirror(state, persistedState(state));
  return dbPath(state.worktree);
}

/**
 * Atomic read-modify-write: load, mutate, and save under one BEGIN IMMEDIATE
 * transaction, so concurrent writers (verifier agents reporting at the same
 * moment) serialize instead of clobbering each other's results. The other DB
 * (worktree <-> repository) is mirrored after commit. Callers pass a sync fn;
 * the state argument is the committed row.
 */
export function updateState(repo: string, change: string, fn: (s: WorkflowState) => void): WorkflowState {
  const db = openDb(repo);
  try {
    db.exec('BEGIN IMMEDIATE');
    const row = db.query('SELECT state FROM workflows WHERE change_id = ?').get(change) as { state: string } | null;
    if (!row) throw new Error(`workflow not found: ${change}`);
    const state = JSON.parse(row.state) as WorkflowState;
    fn(state);
    upsert(db, change, persistedState(state));
    db.exec('COMMIT');
    writeMirror(state, persistedState(state), repo);
    return state;
  } catch (error) {
    try {
      db.exec('ROLLBACK');
    } catch {
      /* no active transaction */
    }
    throw error;
  } finally {
    db.close();
  }
}

/** All workflows recorded for one repository, newest first. */
export function listWorkflows(repo: string): Array<{ changeId: string; state: WorkflowState }> {
  if (!fs.existsSync(dbPath(repo))) return [];
  const db = openDb(repo);
  try {
    const rows = db.query('SELECT change_id, state FROM workflows ORDER BY change_id DESC').all() as Array<{ change_id: string; state: string }>;
    return rows.map(row => ({ changeId: row.change_id, state: JSON.parse(row.state) }));
  } finally {
    db.close();
  }
}

export function workflowDir(state: WorkflowState): string {
  return path.join(state.worktree, '.herdr-workflow', state.changeId);
}
