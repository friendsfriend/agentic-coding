// Host-store upgrades are deliberately one-way. Snapshot the complete SQLite
// database (including committed WAL contents), not only association maps, before
// installing the durable document version gate. Never overwrite a rollback copy.
import { Database } from "bun:sqlite";
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

export function hostStoreBackupPath(storagePath: string): string {
	return `${storagePath}.pre-keyed-v2`;
}

export function backupHostStore(storagePath: string): void {
	const backup = hostStoreBackupPath(storagePath);
	if (fs.existsSync(backup))
		throw new Error(
			`Host-store rollback backup already exists: ${backup}. Preserve it and follow the host-store rollback procedure before retrying the upgrade.`,
		);
	const temporary = `${backup}.${randomUUID()}.tmp`;
	const fd = fs.openSync(temporary, "wx", 0o600);
	fs.closeSync(fd);
	try {
		const source = new Database(storagePath, { readonly: true });
		try {
			// SQLite permits an existing empty destination. VACUUM INTO takes a
			// consistent full-database snapshot even when the source has a WAL.
			source.query("VACUUM INTO ?").run(temporary);
		} finally {
			source.close();
		}
		const snapshot = fs.openSync(temporary, "r");
		try {
			fs.fsyncSync(snapshot);
		} finally {
			fs.closeSync(snapshot);
		}
		// Publish without replacement. A conflicting upgrade must fail closed,
		// not replace the only pre-upgrade copy with a later snapshot.
		fs.linkSync(temporary, backup);
		const directory = fs.openSync(path.dirname(backup), "r");
		try {
			fs.fsyncSync(directory);
		} finally {
			fs.closeSync(directory);
		}
	} finally {
		fs.rmSync(temporary, { force: true });
	}
}
