import { Database } from "bun:sqlite";
import { AsyncLocalStorage } from "node:async_hooks";
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type {
	DocumentData,
	EnvironmentDocument,
	EnvironmentPersistence,
	EnvironmentTransaction,
} from "../persistence.ts";
import {
	ControllerRefusal,
	type ControllerScope,
	ScopeState,
} from "./state.ts";
import { workspaceMatches } from "./workspace.ts";

type Row = { version: number; value: string };
const applicationId = 0x454e5631;

/** Private controller data only: never opens a native-host database or adopts resource handles. */
export class ControllerPersistence implements EnvironmentPersistence {
	readonly host = randomUUID();
	private tail: Promise<unknown> = Promise.resolve();
	private transaction = new AsyncLocalStorage<boolean>();
	private closing: Promise<void> | null = null;
	private constructor(
		private db: Database,
		private release: () => void,
		readonly directory: string,
	) {}
	static open(directory: string): ControllerPersistence {
		let release: (() => void) | undefined;
		let db: Database | undefined;
		try {
			const root = fs.lstatSync(directory);
			if (
				process.platform === "win32" ||
				!root.isDirectory() ||
				fs.realpathSync(directory) !== directory ||
				(root.mode & 0o077) !== 0 ||
				root.uid !== process.getuid?.()
			)
				throw new ControllerRefusal("controller-store-unavailable");
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
					throw new ControllerRefusal("controller-store-unavailable");
				fs.rmdirSync(lock);
			};
			const file = path.join(directory, "controller.sqlite");
			try {
				fs.closeSync(fs.openSync(file, "wx", 0o600));
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
				throw new ControllerRefusal("controller-store-unavailable");
			db = new Database(file, { create: false, strict: true });
			const after = fs.lstatSync(file);
			if (before.dev !== after.dev || before.ino !== after.ino)
				throw new ControllerRefusal("controller-store-unavailable");
			db.exec("PRAGMA synchronous = FULL; PRAGMA busy_timeout = 0;");
			db.exec("BEGIN IMMEDIATE");
			try {
				const version = db
					.query<{ user_version: number }, []>("PRAGMA user_version")
					.get()?.user_version;
				const app = db
					.query<{ application_id: number }, []>("PRAGMA application_id")
					.get()?.application_id;
				const tables = db
					.query<{ count: number }, []>(
						"SELECT count(*) AS count FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'",
					)
					.get()?.count;
				if (version === 0 && app === 0 && tables === 0) {
					db.exec(
						"CREATE TABLE environment_documents (kind TEXT PRIMARY KEY, version INTEGER NOT NULL, value TEXT NOT NULL)",
					);
					db.exec(
						`PRAGMA application_id = ${applicationId}; PRAGMA user_version = 1;`,
					);
				} else if (version !== 1 || app !== applicationId) {
					throw new ControllerRefusal("controller-store-unavailable");
				}
				db.exec("COMMIT");
			} catch (error) {
				db.exec("ROLLBACK");
				throw error;
			}
			return new ControllerPersistence(db, release, directory);
		} catch {
			let settled = true;
			try {
				db?.close();
			} catch {
				settled = false;
			}
			try {
				if (settled) release?.();
			} catch {
				/* An uncertain/replaced lock is retained for operator inspection. */
			}
			throw new ControllerRefusal("controller-store-unavailable");
		}
	}
	private schedule<T>(operation: () => Promise<T>): Promise<T> {
		if (this.closing || this.transaction.getStore())
			return Promise.reject(
				new ControllerRefusal("controller-store-unavailable"),
			);
		const result = this.tail.then(() => this.transaction.run(true, operation));
		this.tail = result.then(
			() => undefined,
			() => undefined,
		);
		return result;
	}
	private read<T extends DocumentData>(
		document: EnvironmentDocument<T>,
	): T | undefined {
		const row = this.db
			.query<Row, [string]>(
				"SELECT version, value FROM environment_documents WHERE kind = ?",
			)
			.get(document.definition.kind);
		if (!row) return undefined;
		if (row.version !== document.definition.version)
			throw new ControllerRefusal("controller-store-unavailable");
		try {
			const value: unknown = JSON.parse(row.value);
			if (!value || typeof value !== "object" || Array.isArray(value))
				throw new ControllerRefusal("controller-store-unavailable");
			return value as T;
		} catch {
			throw new ControllerRefusal("controller-store-unavailable");
		}
	}
	snapshot<T extends DocumentData>(
		document: EnvironmentDocument<T>,
	): Promise<Readonly<T> | undefined> {
		return this.schedule(async () => this.read(document));
	}
	commit<T>(operation: (tx: EnvironmentTransaction) => Promise<T>): Promise<T> {
		return this.schedule(async () => {
			this.db.exec("BEGIN IMMEDIATE");
			const drafts = new Map<
				string,
				{ version: number; value: DocumentData; before?: string }
			>();
			let active = true;
			const doc = async <D extends DocumentData>(
				document: EnvironmentDocument<D>,
			): Promise<D> => {
				if (!active)
					throw new ControllerRefusal("controller-store-unavailable");
				const previous = drafts.get(document.definition.kind);
				if (previous) {
					if (previous.version !== document.definition.version)
						throw new ControllerRefusal("controller-store-unavailable");
					return previous.value as D;
				}
				const saved = this.read(document);
				const value = saved ?? structuredClone(document.definition.initial());
				drafts.set(document.definition.kind, {
					version: document.definition.version,
					value,
					before: saved ? JSON.stringify(saved) : undefined,
				});
				return value;
			};
			const owner = async (id: number) => {
				const raw = (await doc(ScopeState)).scopes[String(id)];
				return raw ? (JSON.parse(raw) as ControllerScope) : undefined;
			};
			try {
				const result = await operation({
					doc,
					ownerActive: async (id) => {
						const scope = await owner(id);
						return Boolean(
							scope &&
								scope.state === "active" &&
								scope.host === this.host &&
								workspaceMatches(scope.workspace),
						);
					},
					ownerInfo: async (id) => {
						const scope = await owner(id);
						return scope
							? {
									id: scope.owner,
									repository: scope.workspace.repository,
									workspace: scope.workspace.directory,
									...(scope.mode === "operator"
										? { kind: "operator-environment" as const }
										: {}),
								}
							: undefined;
					},
				});
				active = false;
				for (const [kind, entry] of drafts) {
					const value = JSON.stringify(entry.value);
					if (value === entry.before) continue;
					if (Buffer.byteLength(value) > 4 * 1024 * 1024)
						throw new ControllerRefusal("controller-store-unavailable");
					this.db
						.query(
							"INSERT INTO environment_documents (kind, version, value) VALUES (?, ?, ?) ON CONFLICT(kind) DO UPDATE SET version = excluded.version, value = excluded.value",
						)
						.run(kind, entry.version, value);
				}
				this.db.exec("COMMIT");
				return result;
			} catch (error) {
				this.db.exec("ROLLBACK");
				throw error;
			} finally {
				active = false;
			}
		});
	}
	close(): Promise<void> {
		if (this.transaction.getStore())
			return Promise.reject(
				new ControllerRefusal("controller-store-unavailable"),
			);
		this.closing ??= this.tail.then(() => {
			try {
				this.db.close();
				this.release();
			} catch {
				// Do not release a lock after an uncertain database close.
				throw new ControllerRefusal("controller-store-unavailable");
			}
		});
		return this.closing;
	}
}
