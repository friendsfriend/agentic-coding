import { dlopen, FFIType } from "bun:ffi";
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

const libc = dlopen(
	process.platform === "darwin" ? "/usr/lib/libSystem.B.dylib" : "libc.so.6",
	{
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

function errnoMessage(operation: string, name: string): Error {
	return new Error(`${operation} failed for secure path component: ${name}`);
}

function openAt(directory: number, name: string, flags: number): number {
	const fd = libc.symbols.openat(directory, name, flags);
	if (fd < 0) throw errnoMessage("openat", name);
	return fd;
}

function openChild(parent: number, name: string): number {
	let fd = libc.symbols.openat(parent, name, O_RDONLY | O_NOFOLLOW);
	if (fd < 0) {
		libc.symbols.mkdirat(parent, name, 0o700);
		fd = libc.symbols.openat(parent, name, O_RDONLY | O_NOFOLLOW);
	}
	if (fd < 0) throw errnoMessage("openat", name);
	const stat = fs.fstatSync(fd);
	if (!stat.isDirectory()) {
		fs.closeSync(fd);
		throw new Error(`secure path component is not a directory: ${name}`);
	}
	return fd;
}

/** Open directory chain with descriptor-relative no-follow operations. */
export function openSecureDirectory(directory: string, root: string): number {
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
			const next = openChild(current, component);
			fs.closeSync(current);
			current = next;
		}
		for (const component of relative.split(path.sep)) {
			if (!component) continue;
			const next = openChild(current, component);
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
