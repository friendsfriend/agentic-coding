import fs from "node:fs";
import path from "node:path";
import type { Context } from "@earendil-works/chord/context";
import type { ToolExecutionApi } from "@earendil-works/pi-durable";
import { type Config, digest, text } from "./config.ts";
import { evidenceMediaType } from "./evidence-format.ts";
import { contained } from "./git.ts";
import { type Attachment, Catalog, decode, type TaskInfo } from "./state.ts";
/** Capture a bounded regular task-workspace artifact; never execute or unpack it. */
export async function captureAttachment(
	config: Config,
	owner: TaskInfo,
	args: { path: string; caption: string; kind: string },
	api: ToolExecutionApi,
	context: Context,
) {
	if (process.platform === "win32")
		throw new Error("Evidence descriptor fences require POSIX");
	const file = contained(owner.workspace, args.path);
	const fd = fs.openSync(
		file,
		fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK,
	);
	let bytes: Buffer;
	try {
		const before = fs.fstatSync(fd);
		if (
			!before.isFile() ||
			before.nlink !== 1 ||
			before.size < 1 ||
			before.size > 10_000_000
		)
			throw new Error(
				"Evidence must be a regular non-hard-linked file at most 10 MB",
			);
		const buffer = Buffer.alloc(before.size + 1);
		let used = 0;
		while (used < buffer.length) {
			const count = fs.readSync(fd, buffer, used, buffer.length - used, null);
			if (!count) break;
			used += count;
		}
		const after = fs.fstatSync(fd),
			current = fs.lstatSync(file);
		if (
			used !== before.size ||
			after.size !== before.size ||
			after.mtimeMs !== before.mtimeMs ||
			after.ctimeMs !== before.ctimeMs ||
			current.dev !== before.dev ||
			current.ino !== before.ino ||
			!current.isFile() ||
			current.nlink !== 1 ||
			contained(owner.workspace, args.path) !== file ||
			fs.realpathSync(file) !== file
		)
			throw new Error("Evidence source changed during capture");
		bytes = buffer.subarray(0, used);
	} finally {
		fs.closeSync(fd);
	}
	const mediaType = evidenceMediaType(bytes, args.kind),
		id = digest(bytes),
		caption = text(args.caption, "evidence caption", 1024);
	const dir = path.join(fs.realpathSync(config.stateDir), "attachments");
	fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
	const beforeRoot = fs.lstatSync(dir);
	if (!beforeRoot.isDirectory() || beforeRoot.isSymbolicLink())
		throw new Error("Unsafe retained evidence directory");
	const destination = path.join(dir, id);
	try {
		const output = fs.openSync(destination, "wx", 0o600);
		try {
			fs.writeFileSync(output, bytes);
			fs.fsyncSync(output);
		} finally {
			fs.closeSync(output);
		}
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
		const existing = fs.openSync(
			destination,
			fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK,
		);
		try {
			const stat = fs.fstatSync(existing);
			if (!stat.isFile() || stat.nlink !== 1 || stat.size !== bytes.length)
				throw new Error("Retained evidence identity collision");
			const found = Buffer.alloc(bytes.length + 1);
			let used = 0;
			while (used < found.length) {
				const count = fs.readSync(
					existing,
					found,
					used,
					found.length - used,
					null,
				);
				if (!count) break;
				used += count;
			}
			const after = fs.fstatSync(existing);
			if (
				used !== bytes.length ||
				!found.subarray(0, used).equals(bytes) ||
				after.size !== stat.size ||
				after.ctimeMs !== stat.ctimeMs ||
				after.mtimeMs !== stat.mtimeMs
			)
				throw new Error(
					"Retained evidence changed during collision inspection",
				);
		} finally {
			fs.closeSync(existing);
		}
	}
	const afterRoot = fs.lstatSync(dir);
	if (
		!afterRoot.isDirectory() ||
		afterRoot.isSymbolicLink() ||
		beforeRoot.dev !== afterRoot.dev ||
		beforeRoot.ino !== afterRoot.ino
	)
		throw new Error("Evidence destination changed");
	const directory = fs.openSync(
		dir,
		fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW,
	);
	try {
		fs.fsyncSync(directory);
	} finally {
		fs.closeSync(directory);
	}
	const attachment: Attachment = {
		id,
		taskId: owner.id,
		mediaType,
		caption,
		filename: id,
	};
	await api.commit(async (tx) => {
		const catalog = await tx.doc(Catalog),
			old = catalog.attachments[id];
		if (old && decode<Attachment>(old).taskId !== owner.id)
			throw new Error(
				"Identical retained bytes belong to another native task; owner cannot be replaced",
			);
		catalog.attachments[id] = JSON.stringify(attachment);
	}, context);
	return `${mediaType.startsWith("image/") ? "!" : ""}[${caption.replace(/[[\]\\\r\n]/g, " ")}](/attachments/${id})`;
}
