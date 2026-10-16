// Materializes the committed fixture snapshot into a throwaway directory.
//
// The JSONL fixtures are copied as they are; the SQLite fixtures are committed
// as SQL (readable, diffable, and free of binary blobs) and executed here into
// the exact paths the real snapshot uses.

import { Database } from "bun:sqlite";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const FIXTURES = path.join(import.meta.dir, "..", "fixtures", "efficiency");

export interface FixtureEvidence {
	root: string;
	cleanup(): void;
}

function copyTree(from: string, to: string, skip: ReadonlySet<string>): void {
	for (const entry of fs.readdirSync(from, { withFileTypes: true })) {
		if (skip.has(entry.name)) continue;
		const source = path.join(from, entry.name);
		const target = path.join(to, entry.name);
		if (entry.isDirectory()) {
			fs.mkdirSync(target, { recursive: true });
			copyTree(source, target, skip);
		} else {
			fs.copyFileSync(source, target);
		}
	}
}

function sqliteFromSql(sqlPath: string, target: string): void {
	fs.mkdirSync(path.dirname(target), { recursive: true });
	fs.rmSync(target, { force: true });
	const db = new Database(target, { create: true });
	try {
		db.exec(fs.readFileSync(sqlPath, "utf8"));
	} finally {
		db.close();
	}
}

/** Build the fixture evidence directory; the caller must `cleanup()`. */
export function makeFixtureEvidence(): FixtureEvidence {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "efficiency-fixture-"));
	copyTree(FIXTURES, root, new Set(["sql"]));
	const sql = (name: string) => path.join(FIXTURES, "sql", name);
	sqliteFromSql(
		sql("traces.sql"),
		path.join(root, "otel-tui", "traces.sqlite"),
	);
	sqliteFromSql(
		sql("orchestrator-harness.sql"),
		path.join(root, "orchestrator", "harness.sqlite"),
	);
	sqliteFromSql(
		sql("span-wf-harness.sql"),
		path.join(root, "worktrees", "span-wf", "harness.sqlite"),
	);
	sqliteFromSql(sql("herdr.sql"), path.join(root, "main-store", "herdr.db"));
	return {
		root,
		cleanup: () => fs.rmSync(root, { recursive: true, force: true }),
	};
}

/** An empty directory for a dataset output, removed by `cleanup`. */
export function makeTempDir(prefix: string): { path: string; cleanup(): void } {
	const created = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
	return {
		path: created,
		cleanup: () => fs.rmSync(created, { recursive: true, force: true }),
	};
}
