// Composition adapter for the repository-owned, public-API SQLite VFS.
import { dlopen, FFIType } from "bun:ffi";
import { Database } from "bun:sqlite";
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
	closeSecureDirectory,
	openSecureDirectory,
	openSecureFile,
} from "../secure-fs.ts";
import { secureSqliteExtension } from "./extension.generated.ts";

function loadLibrary(file: string) {
	return dlopen(file, {
		herdr_pin_library: { args: [FFIType.cstring], returns: FFIType.i32 },
		herdr_vfs_name: { args: [], returns: FFIType.cstring },
		herdr_bind_library: {
			args: [FFIType.cstring, FFIType.pointer],
			returns: FFIType.i32,
		},
		herdr_register_root: {
			args: [
				FFIType.cstring,
				FFIType.i32,
				FFIType.i32,
				FFIType.i32,
				FFIType.cstring,
			],
			returns: FFIType.i32,
		},
		herdr_unregister_root: { args: [FFIType.cstring], returns: FFIType.i32 },
	});
}
let native: ReturnType<typeof loadLibrary> | undefined;
// SQLite owns global VFS callbacks. Retain the module and extension connection
// for the process lifetime, not just for one database's lifetime.
let bootstrap: Database | undefined;
function extension(): ReturnType<typeof loadLibrary> {
	if (native) return native;
	if (
		secureSqliteExtension.platform !== process.platform ||
		secureSqliteExtension.arch !== process.arch
	)
		throw new Error(
			"Secure SQLite artifact does not match this platform; run the native build before using a source checkout.",
		);
	const directory = fs.mkdtempSync(
		path.join(fs.realpathSync(os.tmpdir()), "herdr-sqlite-"),
	);
	const capability = openSecureDirectory(
		directory,
		path.dirname(directory),
		false,
	);
	let fd: number | undefined;
	const db = new Database(":memory:");
	try {
		fd = openSecureFile(
			capability,
			"extension",
			fs.constants.O_RDWR | fs.constants.O_CREAT | fs.constants.O_EXCL,
			0o500,
		);
		fs.writeFileSync(fd, Buffer.from(secureSqliteExtension.base64, "base64"));
		fs.fsyncSync(fd);
		fs.fsyncSync(capability);
		const file = `${process.platform === "darwin" ? "/dev/fd" : "/proc/self/fd"}/${fd}`;
		const library = loadLibrary(file);
		if (library.symbols.herdr_pin_library(Buffer.from(`${file}\0`)) !== 0)
			throw new Error("Cannot retain process-owned SQLite VFS module.");
		if (process.platform === "darwin") {
			const pointer = new BigUint64Array(1);
			if (
				db.fileControl(27, pointer) !== 0 ||
				pointer[0] === 0n ||
				pointer[0] > BigInt(Number.MAX_SAFE_INTEGER)
			)
				throw new Error("Cannot verify Bun's SQLite VFS identity.");
			const code = library.symbols.herdr_bind_library(
				Buffer.from("/usr/lib/libsqlite3.dylib\0"),
				pointer[0],
			);
			if (code !== 0)
				throw new Error(
					`Secure VFS refused a different/unsupported SQLite instance (${code}).`,
				);
		} else {
			db.loadExtension(file);
		}
		bootstrap = db;
		native = library;
		return library;
	} catch (error) {
		db.close();
		throw error;
	} finally {
		if (fd !== undefined) fs.closeSync(fd);
		closeSecureDirectory(capability);
	}
}
/** Caller retains its main-file guard. The extension independently duplicates
 * both capabilities and retains them until all native files/statements close. */
export function openSecureDatabase(
	directory: number,
	main: number,
	readonly: boolean,
	basename: "herdr.db" | "scheduling.sqlite" = "herdr.db",
): Database {
	if (basename !== "herdr.db" && basename !== "scheduling.sqlite")
		throw new Error("Unsupported secure SQLite basename.");
	const control = extension(),
		token = randomUUID(),
		encoded = Buffer.from(`${token}\0`),
		encodedBasename = Buffer.from(`${basename}\0`);
	if (!bootstrap) throw new Error("Secure SQLite bootstrap unavailable.");
	if (
		control.symbols.herdr_register_root(
			encoded,
			directory,
			main,
			readonly ? 1 : 0,
			encodedBasename,
		) !== 0
	)
		throw new Error("Secure SQLite directory/file capability mismatch.");
	let db: Database;
	try {
		// Public sqlite3_open_v2 flags: URI, READONLY or READWRITE. No CREATE: the
		// main file has already been opened/created through the secure directory.
		db = new Database(
			`file:/herdr-secure/${token}/${basename}?vfs=${String(control.symbols.herdr_vfs_name())}`,
			0x40 | (readonly ? 0x1 : 0x2),
		);
	} catch (error) {
		control.symbols.herdr_unregister_root(encoded);
		throw error;
	}
	const close = db.close.bind(db);
	let closed = false;
	Object.defineProperty(db, "close", {
		configurable: true,
		value: (throwOnError?: boolean) => {
			if (closed) return;
			close(throwOnError);
			closed = true;
			control.symbols.herdr_unregister_root(encoded);
		},
	});
	return db;
}
