// Host-store upgrades are deliberately one-way. Snapshot the complete SQLite
// database (including committed WAL contents), not only association maps, before
// installing the durable document version gate. Never overwrite a rollback copy.
import { Database } from "bun:sqlite";
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
	const staging = fs.mkdtempSync(`${backup}.tmp-`);
	const temporary = path.join(staging, "snapshot.sqlite");
	try {
		const source = new Database(storagePath, { readonly: true });
		try {
			// VACUUM INTO needs a new destination on supported Bun/SQLite builds.
			// The private staging directory protects the snapshot until chmod.
			source.query("VACUUM INTO ?").run(temporary);
		} finally {
			source.close();
		}
		fs.chmodSync(temporary, 0o600);
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
		fs.rmSync(staging, { recursive: true, force: true });
	}
}
