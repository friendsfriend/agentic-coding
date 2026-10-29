// Filesystem boundary: SQLite only receives capabilities, never the canonical
// scheduler pathname. Reuse the repository VFS for main/journal/WAL operations.
import type { Database } from "bun:sqlite";
import fs from "node:fs";
import path from "node:path";
import { SchedulingError } from "../../contracts/scheduling.ts";
import { openSecureDatabase } from "../../workflow/native/database.ts";
import {
	closeSecureDirectory,
	openSecureDirectory,
	openSecureFile,
} from "../../workflow/secure-fs.ts";

const BASENAME = "scheduling.sqlite";
export function openSchedulingDatabase(directory: string): {
	db: Database;
	existing: boolean;
} {
	// Fresh config roots may not exist yet. Establish every missing component
	// through the nearest existing canonical ancestor, never recursive pathname IO.
	let ancestor = path.dirname(path.resolve(directory));
	while (!fs.existsSync(ancestor)) {
		const parent = path.dirname(ancestor);
		if (parent === ancestor)
			throw new SchedulingError(
				"unavailable",
				"Scheduling data root is unavailable.",
			);
		ancestor = parent;
	}
	const capability = openSecureDirectory(directory, ancestor, true);
	let main: number | undefined;
	let db: Database | undefined;
	try {
		const owner = process.getuid?.(),
			dirStat = fs.fstatSync(capability);
		if (
			owner === undefined ||
			dirStat.uid !== owner ||
			(dirStat.mode & 0o077) !== 0
		)
			throw new SchedulingError(
				"unavailable",
				"Scheduling directory must be privately owned.",
			);
		let existing = true;
		try {
			main = openSecureFile(capability, BASENAME, fs.constants.O_RDWR);
		} catch {
			main = openSecureFile(
				capability,
				BASENAME,
				fs.constants.O_RDWR | fs.constants.O_CREAT | fs.constants.O_EXCL,
				0o600,
			);
			existing = false;
		}
		const stat = fs.fstatSync(main);
		if (
			!stat.isFile() ||
			stat.uid !== owner ||
			stat.nlink !== 1 ||
			(stat.mode & 0o077) !== 0
		)
			throw new SchedulingError(
				"unavailable",
				"Scheduling database must be a private owned single-link file.",
			);
		const header = Buffer.alloc(100);
		if (existing) {
			if (
				fs.readSync(main, header, 0, 100, 0) !== 100 ||
				!header.subarray(0, 16).equals(Buffer.from("SQLite format 3\0"))
			)
				throw new SchedulingError(
					"unavailable",
					"Scheduling store failed its integrity/header check; preserve the store.",
				);
			if (header.readUInt32BE(60) !== 1)
				throw new SchedulingError(
					"unavailable",
					"Unsupported scheduling store version; preserve the store and use the matching application version.",
				);
		}
		db = openSecureDatabase(capability, main, false, BASENAME);
		db.exec("PRAGMA busy_timeout=5000; PRAGMA foreign_keys=ON");
		const wal = existing && header[18] === 2 && header[19] === 2;
		// Heap WAL index, solely for converting an existing supported draft store.
		// Verify authoritative version/integrity after ordinary SQLite recovery and
		// before changing its journal mode. Newer headers are refused even earlier.
		if (wal) db.exec("PRAGMA locking_mode=EXCLUSIVE");
		if (existing) {
			if (
				db.query<{ user_version: number }, []>("PRAGMA user_version").get()
					?.user_version !== 1
			)
				throw new SchedulingError(
					"unavailable",
					"Unsupported scheduling store version; preserve the store.",
				);
			if (
				db
					.query<{ integrity_check: string }, []>("PRAGMA integrity_check")
					.get()?.integrity_check !== "ok"
			)
				throw new SchedulingError(
					"unavailable",
					"Scheduling store failed its integrity check.",
				);
		}
		db.exec("PRAGMA journal_mode=TRUNCATE; PRAGMA synchronous=FULL");
		if (wal) db.exec("PRAGMA locking_mode=NORMAL");
		const canonicalDir = fs.lstatSync(directory),
			canonicalMain = fs.lstatSync(path.join(directory, BASENAME));
		if (
			!canonicalDir.isDirectory() ||
			canonicalDir.dev !== dirStat.dev ||
			canonicalDir.ino !== dirStat.ino ||
			!canonicalMain.isFile() ||
			canonicalMain.dev !== stat.dev ||
			canonicalMain.ino !== stat.ino
		)
			throw new SchedulingError(
				"unavailable",
				"Scheduling store changed while opening.",
			);
		return { db, existing };
	} catch (error) {
		db?.close();
		throw error;
	} finally {
		if (main !== undefined) fs.closeSync(main);
		closeSecureDirectory(capability);
	}
}
