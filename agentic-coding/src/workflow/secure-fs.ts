import { dlopen, FFIType, toArrayBuffer } from "bun:ffi";
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

const libc = dlopen(
	process.platform === "darwin" ? "/usr/lib/libSystem.B.dylib" : "libc.so.6",
	{
		dup: {
			args: [FFIType.i32],
			returns: FFIType.i32,
		},
		fdopendir: {
			args: [FFIType.i32],
			returns: FFIType.pointer,
		},
		readdir: {
			args: [FFIType.pointer],
			returns: FFIType.pointer,
		},
		closedir: {
			args: [FFIType.pointer],
			returns: FFIType.i32,
		},
		openat: {
			args: [FFIType.i32, FFIType.cstring, FFIType.i32],
			returns: FFIType.i32,
		},
		mkdirat: {
			args: [FFIType.i32, FFIType.cstring, FFIType.i32],
			returns: FFIType.i32,
		},
		renameat: {
			args: [FFIType.i32, FFIType.cstring, FFIType.i32, FFIType.cstring],
			returns: FFIType.i32,
		},
		unlinkat: {
			args: [FFIType.i32, FFIType.cstring, FFIType.i32],
			returns: FFIType.i32,
		},
	},
);

const AT_FDCWD = -100;
const O_RDONLY = 0;
const O_WRONLY = 1;
const O_CREAT = process.platform === "darwin" ? 0x200 : 0x40;
const O_EXCL = process.platform === "darwin" ? 0x800 : 0x80;
const O_NOFOLLOW = process.platform === "darwin" ? 0x100 : 0x20000;
const O_DIRECTORY = process.platform === "darwin" ? 0x100000 : 0x10000;

function errnoMessage(operation: string, name: string): Error {
	return new Error(`${operation} failed for secure path component: ${name}`);
}

function openAt(directory: number, name: string, flags: number): number {
	const fd = libc.symbols.openat(directory, name, flags);
	if (fd < 0) throw errnoMessage("openat", name);
	return fd;
}

function openChild(parent: number, name: string, create: boolean): number {
	let fd = libc.symbols.openat(
		parent,
		name,
		O_RDONLY | O_NOFOLLOW | O_DIRECTORY,
	);
	if (fd < 0 && create) {
		libc.symbols.mkdirat(parent, name, 0o700);
		fd = libc.symbols.openat(parent, name, O_RDONLY | O_NOFOLLOW | O_DIRECTORY);
	}
	if (fd < 0) throw errnoMessage("openat", name);
	const stat = fs.fstatSync(fd);
	if (!stat.isDirectory()) {
		fs.closeSync(fd);
		throw new Error(`secure path component is not a directory: ${name}`);
	}
	return fd;
}

/** Open an already-canonical directory chain without following any component. */
export function openCanonicalDirectory(
	directory: string,
	root: string,
): number {
	const lexicalRoot = path.resolve(root);
	const target = path.resolve(directory);
	const relative = path.relative(lexicalRoot, target);
	if (relative.startsWith("..") || path.isAbsolute(relative))
		throw new Error("runtime directory escapes its data root");
	let current = openAt(
		AT_FDCWD,
		path.parse(lexicalRoot).root,
		O_RDONLY | O_NOFOLLOW,
	);
	try {
		for (const component of path
			.relative(path.parse(lexicalRoot).root, lexicalRoot)
			.split(path.sep)) {
			if (!component) continue;
			const next = openChild(current, component, false);
			fs.closeSync(current);
			current = next;
		}
		for (const component of relative.split(path.sep)) {
			if (!component) continue;
			const next = openChild(current, component, false);
			fs.closeSync(current);
			current = next;
		}
		return current;
	} catch (error) {
		fs.closeSync(current);
		throw error;
	}
}

/** Open directory chain with descriptor-relative no-follow operations. */
export function openSecureDirectory(
	directory: string,
	root: string,
	create = true,
): number {
	const lexicalRoot = path.resolve(root);
	const base = fs.realpathSync(lexicalRoot);
	const target = path.resolve(directory);
	const relative = path.relative(lexicalRoot, target);
	if (relative.startsWith("..") || path.isAbsolute(relative))
		throw new Error("runtime directory escapes its data root");

	let current = openAt(AT_FDCWD, path.parse(base).root, O_RDONLY | O_NOFOLLOW);
	try {
		for (const component of path
			.relative(path.parse(base).root, base)
			.split(path.sep)) {
			if (!component) continue;
			const next = openChild(current, component, create);
			fs.closeSync(current);
			current = next;
		}
		for (const component of relative.split(path.sep)) {
			if (!component) continue;
			const next = openChild(current, component, create);
			fs.closeSync(current);
			current = next;
		}
		return current;
	} catch (error) {
		fs.closeSync(current);
		throw error;
	}
}

/** Enumerate names through an already-open directory descriptor. */
export function secureDirectoryNames(
	directory: number,
	limit: number,
): string[] {
	const duplicate = libc.symbols.dup(directory);
	if (duplicate < 0) throw errnoMessage("dup", String(directory));
	const stream = libc.symbols.fdopendir(duplicate);
	if (!stream) {
		fs.closeSync(duplicate);
		throw errnoMessage("fdopendir", String(directory));
	}
	const names: string[] = [];
	try {
		for (;;) {
			const entry = libc.symbols.readdir(stream);
			if (!entry) break;
			const header = new DataView(toArrayBuffer(entry, 0, 24));
			const length = header.getUint16(16, true);
			if (length < 20) throw errnoMessage("readdir", String(directory));
			const bytes = new Uint8Array(toArrayBuffer(entry, 0, length));
			const nameOffset = process.platform === "darwin" ? 21 : 19;
			const nameLength =
				process.platform === "darwin"
					? header.getUint16(18, true)
					: bytes.subarray(nameOffset).indexOf(0);
			if (nameLength < 0 || nameOffset + nameLength > bytes.length)
				throw errnoMessage("readdir", String(directory));
			const name = new TextDecoder().decode(
				bytes.subarray(nameOffset, nameOffset + nameLength),
			);
			if (name !== "." && name !== "..") names.push(name);
			if (names.length >= limit) break;
		}
		return names;
	} finally {
		libc.symbols.closedir(stream);
	}
}

/** Open a descendant without reopening any pathname ancestor. */
export function openSecureDirectoryRelative(
	parent: number,
	relative: string,
	create = false,
): number {
	let current = libc.symbols.dup(parent);
	if (current < 0) throw errnoMessage("dup", String(parent));
	try {
		for (const component of relative.split(path.sep)) {
			if (!component || component === ".") continue;
			if (component === "..")
				throw new Error("secure relative directory escapes its root");
			const next = openChild(current, component, create);
			fs.closeSync(current);
			current = next;
		}
		return current;
	} catch (error) {
		fs.closeSync(current);
		throw error;
	}
}

export function openSecureFile(
	directory: number,
	name: string,
	flags = O_RDONLY,
	mode = 0,
): number {
	if (!name || name === "." || name === ".." || name.includes(path.sep))
		throw new Error("secure file name must be a single path component");
	let fd: number | undefined;
	for (let attempt = 0; attempt < 20; attempt++) {
		try {
			fd = openAt(directory, name, flags | O_NOFOLLOW);
			break;
		} catch (error) {
			if ((flags & O_CREAT) === 0 || attempt === 19) throw error;
			Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 5);
		}
	}
	if (fd === undefined) throw errnoMessage("openat", name);
	if ((flags & O_CREAT) !== 0) fs.fchmodSync(fd, mode);
	return fd;
}

export function writeAtomicPrivateFile(
	directory: number,
	name: string,
	content: string,
	mode: number,
): void {
	const temporary = `${name}.${randomUUID()}.tmp`;
	const fd = openSecureFile(
		directory,
		temporary,
		O_WRONLY | O_CREAT | O_EXCL,
		mode,
	);
	try {
		fs.writeFileSync(fd, content);
		fs.fchmodSync(fd, mode);
	} finally {
		fs.closeSync(fd);
	}
	if (libc.symbols.renameat(directory, temporary, directory, name) < 0) {
		libc.symbols.unlinkat(directory, temporary, 0);
		throw errnoMessage("renameat", name);
	}
}

export function closeSecureDirectory(directory: number): void {
	fs.closeSync(directory);
}
