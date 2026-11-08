import fs from "node:fs";
import path from "node:path";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { digest } from "./config.ts";
/** Private SDK-owned JSONL, never a caller-selected file or a durable conversation. Cooperative identity fences, not a hostile same-user filesystem sandbox. */
export class StandalonePiStore {
	constructor(private root: string) {}
	private directory(id: string) {
		if (
			process.platform === "win32" ||
			!fs.constants.O_NOFOLLOW ||
			!/^[a-f0-9-]{36}$/.test(id)
		)
			throw new Error(
				"Native Pi persistence requires descriptor-capable host and owned identity",
			);
		const base = path.join(this.root, "standalone-pi");
		fs.mkdirSync(base, { recursive: true, mode: 0o700 });
		if (
			fs.lstatSync(base).isSymbolicLink() ||
			!fs.lstatSync(base).isDirectory()
		)
			throw new Error("Native Pi private directory changed");
		return path.join(base, id);
	}
	create(id: string, repository: string) {
		const directory = this.directory(id);
		fs.mkdirSync(directory, { mode: 0o700 });
		const manager = SessionManager.create(repository, directory),
			file = manager.getSessionFile(),
			header = manager.getHeader();
		if (!file || !header || path.dirname(file) !== directory)
			throw new Error("Native SDK did not mint a private session file");
		const fd = fs.openSync(
			file,
			fs.constants.O_WRONLY |
				fs.constants.O_CREAT |
				fs.constants.O_EXCL |
				fs.constants.O_NOFOLLOW,
			0o600,
		);
		try {
			fs.writeFileSync(fd, `${JSON.stringify(header)}\n`);
			fs.fsyncSync(fd);
		} finally {
			fs.closeSync(fd);
		}
		return { file, digest: this.inspect(id, file) };
	}
	inspect(id: string, file: string) {
		const directory = this.directory(id);
		if (
			path.dirname(file) !== directory ||
			fs.lstatSync(directory).isSymbolicLink() ||
			fs.realpathSync(directory) !==
				path.join(fs.realpathSync(path.dirname(directory)), id)
		)
			throw new Error("Native Pi source is outside its owned directory");
		const fd = fs.openSync(
			file,
			fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK,
		);
		try {
			const before = fs.fstatSync(fd);
			if (
				!before.isFile() ||
				before.nlink !== 1 ||
				before.size > 2_000_000 ||
				(before.mode & 0o077) !== 0
			)
				throw new Error(
					"Native Pi retained source exceeds private regular-file bound",
				);
			const bytes = Buffer.alloc(before.size + 1);
			let used = 0;
			while (used < bytes.length) {
				const count = fs.readSync(fd, bytes, used, bytes.length - used, used);
				if (!count) break;
				used += count;
			}
			const after = fs.fstatSync(fd),
				named = fs.lstatSync(file);
			if (
				used !== before.size ||
				after.size !== before.size ||
				after.mtimeMs !== before.mtimeMs ||
				after.ctimeMs !== before.ctimeMs ||
				named.isSymbolicLink() ||
				named.dev !== before.dev ||
				named.ino !== before.ino
			)
				throw new Error("Native Pi retained source changed during observation");
			return digest(bytes.subarray(0, used));
		} finally {
			fs.closeSync(fd);
		}
	}
	open(id: string, file: string, expected: string) {
		if (this.inspect(id, file) !== expected)
			throw new Error(
				"Native Pi retained revision changed; no session adoption",
			);
		const manager = SessionManager.open(file, this.directory(id));
		if (
			this.inspect(id, file) !== expected ||
			manager.getSessionFile() !== file
		)
			throw new Error("Native Pi source changed during SDK open");
		return manager;
	}
}
