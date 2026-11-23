import { Database } from "bun:sqlite";
import fs from "node:fs";
import path from "node:path";
import * as z from "zod/v4";
import {
	OperationRefusal,
	operationRecordSchema,
	scopeRecordSchema,
} from "../domain/operation.ts";
import { ownedResourceSchema } from "../domain/owned-resource.ts";
import { sharedServiceSchema } from "../domain/shared-service.ts";

const documentSchema = z.strictObject({
	scopes: z.record(z.string(), scopeRecordSchema),
	operations: z.record(z.string(), operationRecordSchema),
	scopeRequests: z.record(
		z.string(),
		z.strictObject({ identity: z.string(), scope: z.uuid() }),
	),
	operationRequests: z.record(z.string(), z.uuid()),
	decisions: z.record(
		z.string(),
		z.strictObject({ identity: z.string(), operation: operationRecordSchema }),
	),
	acknowledgements: z
		.record(
			z.string(),
			z.strictObject({
				identity: z.string(),
				operation: operationRecordSchema,
			}),
		)
		.default({}),
	owned: z.record(z.string(), ownedResourceSchema),
	sharedServices: z.record(z.string(), sharedServiceSchema).default({}),
});
export type JournalDocument = z.output<typeof documentSchema>;
const initial = (): JournalDocument => ({
	scopes: {},
	operations: {},
	scopeRequests: {},
	operationRequests: {},
	decisions: {},
	acknowledgements: {},
	owned: {},
	sharedServices: {},
});
const applicationId = 0x454d4350;
const unavailable = () => new OperationRefusal("journal-unavailable");

/** Adapted from v2's private SQLite boundary, with environment-native records,
 * synchronous transactions and no harness/document service dependencies. */
export function openJournalStore(
	directory: string,
	repositories: readonly string[],
) {
	let db: Database | undefined;
	let release: (() => void) | undefined;
	try {
		const root = fs.lstatSync(directory);
		if (
			process.platform === "win32" ||
			!path.isAbsolute(directory) ||
			fs.realpathSync(directory) !== directory ||
			!root.isDirectory() ||
			(root.mode & 0o077) !== 0 ||
			root.uid !== process.getuid?.()
		)
			throw unavailable();
		if (!repositories.length || repositories.length > 64) throw unavailable();
		for (const repository of repositories) {
			const relative = path.relative(fs.realpathSync(repository), directory);
			if (
				relative === "" ||
				(!relative.startsWith(`..${path.sep}`) &&
					relative !== ".." &&
					!path.isAbsolute(relative))
			)
				throw unavailable();
		}
		const lock = path.join(directory, "controller.lock");
		fs.mkdirSync(lock, { mode: 0o700 });
		const held = fs.lstatSync(lock);
		release = () => {
			const current = fs.lstatSync(lock);
			if (
				!current.isDirectory() ||
				current.dev !== held.dev ||
				current.ino !== held.ino
			)
				throw unavailable();
			fs.rmdirSync(lock);
		};
		const file = path.join(directory, "environment.sqlite");
		let created = false;
		try {
			fs.closeSync(fs.openSync(file, "wx", 0o600));
			created = true;
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
		}
		const before = fs.lstatSync(file);
		if (
			!before.isFile() ||
			before.nlink !== 1 ||
			(before.mode & 0o077) !== 0 ||
			before.uid !== root.uid
		)
			throw unavailable();
		db = new Database(file, { create: false, strict: true });
		const after = fs.lstatSync(file);
		if (before.dev !== after.dev || before.ino !== after.ino)
			throw unavailable();
		db.exec(
			"PRAGMA synchronous = FULL; PRAGMA busy_timeout = 0; BEGIN IMMEDIATE;",
		);
		try {
			if (created) {
				db.exec(
					`CREATE TABLE journal (id INTEGER PRIMARY KEY CHECK (id = 1), value TEXT NOT NULL); PRAGMA application_id = ${applicationId}; PRAGMA user_version = 1;`,
				);
				db.query("INSERT INTO journal (id, value) VALUES (1, ?)").run(
					JSON.stringify(initial()),
				);
			} else if (
				db.query<{ application_id: number }, []>("PRAGMA application_id").get()
					?.application_id !== applicationId ||
				db.query<{ user_version: number }, []>("PRAGMA user_version").get()
					?.user_version !== 1
			)
				throw unavailable();
			db.exec("COMMIT");
		} catch (error) {
			db.exec("ROLLBACK");
			throw error;
		}
		const database = db;
		const releaseLock = release;
		let closed = false;
		const assertCurrent = () => {
			if (closed) throw unavailable();
			const current = fs.lstatSync(directory),
				currentFile = fs.lstatSync(file),
				currentLock = fs.lstatSync(lock);
			if (
				fs.realpathSync(directory) !== directory ||
				current.dev !== root.dev ||
				current.ino !== root.ino ||
				(current.mode & 0o077) !== 0 ||
				current.uid !== root.uid ||
				!currentFile.isFile() ||
				currentFile.nlink !== 1 ||
				currentFile.dev !== before.dev ||
				currentFile.ino !== before.ino ||
				(currentFile.mode & 0o077) !== 0 ||
				currentFile.uid !== root.uid ||
				!currentLock.isDirectory() ||
				currentLock.dev !== held.dev ||
				currentLock.ino !== held.ino
			)
				throw unavailable();
		};
		const read = () => {
			assertCurrent();
			const row = database
				.query<{ value: string }, []>("SELECT value FROM journal WHERE id = 1")
				.get();
			if (!row) throw unavailable();
			return documentSchema.parse(JSON.parse(row.value));
		};
		read();
		return {
			read,
			transaction<T>(action: (document: JournalDocument) => T): T {
				assertCurrent();
				database.exec("BEGIN IMMEDIATE");
				try {
					const document = read();
					const result = action(document);
					if (result && typeof result === "object" && "then" in result)
						throw unavailable();
					assertCurrent();
					database
						.query("UPDATE journal SET value = ? WHERE id = 1")
						.run(JSON.stringify(documentSchema.parse(document)));
					database.exec("COMMIT");
					return result;
				} catch (error) {
					database.exec("ROLLBACK");
					throw error;
				}
			},
			close() {
				if (closed) return;
				closed = true;
				database.close(true);
				releaseLock();
			},
		};
	} catch {
		let settled = true;
		try {
			db?.close(true);
		} catch {
			settled = false;
		}
		try {
			if (settled) release?.();
		} catch {
			/* Retain uncertain or replaced lock for inspection. */
		}
		throw unavailable();
	}
}

export type JournalStore = ReturnType<typeof openJournalStore>;
