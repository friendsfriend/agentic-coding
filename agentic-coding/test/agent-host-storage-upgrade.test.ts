import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
	backupHostStore,
	hostStoreBackupPath,
} from "../src/agent-host/storage-upgrade.ts";

test("the full private rollback snapshot includes committed WAL data and never overwrites an existing backup", () => {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "host-store-upgrade-"));
	const file = path.join(root, "harness.sqlite");
	const db = new Database(file);
	try {
		db.exec(
			"PRAGMA journal_mode=WAL; PRAGMA wal_autocheckpoint=0; CREATE TABLE conversations(id INTEGER PRIMARY KEY, transcript TEXT); CREATE TABLE documents(kind TEXT, value TEXT); INSERT INTO conversations VALUES (1, 'complete transcript'); INSERT INTO documents VALUES ('agentic.runs', 'legacy evidence')",
		);
		// WAL is deliberately still live: copying only harness.sqlite loses it.
		expect(fs.statSync(`${file}-wal`).size).toBeGreaterThan(0);
		backupHostStore(file);
		const backup = hostStoreBackupPath(file);
		expect(fs.statSync(backup).mode & 0o777).toBe(0o600);
		const restored = new Database(backup, { readonly: true });
		try {
			expect(
				restored.query("SELECT transcript FROM conversations").get(),
			).toEqual({ transcript: "complete transcript" });
			expect(restored.query("SELECT value FROM documents").get()).toEqual({
				value: "legacy evidence",
			});
			expect(restored.query("PRAGMA integrity_check").get()).toEqual({
				integrity_check: "ok",
			});
		} finally {
			restored.close();
		}
		const original = fs.readFileSync(backup);
		db.exec("INSERT INTO conversations VALUES (2, 'after upgrade')");
		expect(() => backupHostStore(file)).toThrow(/backup already exists/);
		expect(fs.readFileSync(backup)).toEqual(original);
		expect(fs.readdirSync(root).some((name) => name.endsWith(".tmp"))).toBe(
			false,
		);
	} finally {
		db.close();
		fs.rmSync(root, { recursive: true, force: true });
	}
});

test("failed snapshots do not publish a partial backup or leave staging files", () => {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "host-store-upgrade-"));
	const file = path.join(root, "harness.sqlite");
	try {
		fs.writeFileSync(file, "invalid sqlite database");
		expect(() => backupHostStore(file)).toThrow();
		expect(fs.readdirSync(root)).toEqual(["harness.sqlite"]);
		expect(fs.readFileSync(file, "utf8")).toBe("invalid sqlite database");
	} finally {
		fs.rmSync(root, { recursive: true, force: true });
	}
});
