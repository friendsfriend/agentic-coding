import fs from "node:fs";
import path from "node:path";
import { digest } from "../../../config.ts";
import { imageMediaType } from "../../../evidence-format.ts";
import type { Runtime } from "../../../runtime.ts";
/** Read exact native-owned content bytes, never caller-supplied paths or URLs. */
export async function readEvidence(app: Runtime, taskId: number, id: string) {
	if (process.platform === "win32")
		throw new Error("Evidence descriptor fences require POSIX");
	if (!/^[a-f0-9]{64}$/.test(id)) throw new Error("Invalid evidence identity");
	await app.taskResult(taskId);
	const item = await app.attachment(id);
	if (
		!item ||
		item.taskId !== taskId ||
		item.filename !== id ||
		!["image/png", "image/jpeg", "image/webp", "image/gif"].includes(
			item.mediaType,
		)
	)
		throw new Error("Evidence owner or format unavailable");
	const root = path.join(fs.realpathSync(app.config.stateDir), "attachments"),
		beforeRoot = fs.lstatSync(root);
	if (!beforeRoot.isDirectory() || beforeRoot.isSymbolicLink())
		throw new Error("Unsafe evidence directory");
	const fd = fs.openSync(
		path.join(root, id),
		fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK,
	);
	try {
		const before = fs.fstatSync(fd);
		if (
			!before.isFile() ||
			before.nlink !== 1 ||
			before.size < 1 ||
			before.size > 384000
		)
			throw new Error("Evidence unavailable or exceeds 384000-byte TUI limit");
		const bytes = Buffer.alloc(before.size + 1);
		let used = 0;
		while (used < bytes.length) {
			const count = fs.readSync(fd, bytes, used, bytes.length - used, null);
			if (!count) break;
			used += count;
		}
		const after = fs.fstatSync(fd),
			current = fs.lstatSync(path.join(root, id)),
			afterRoot = fs.lstatSync(root);
		if (
			used !== before.size ||
			before.dev !== after.dev ||
			before.ino !== after.ino ||
			before.size !== after.size ||
			before.mtimeMs !== after.mtimeMs ||
			before.ctimeMs !== after.ctimeMs ||
			current.dev !== before.dev ||
			current.ino !== before.ino ||
			!current.isFile() ||
			current.nlink !== 1 ||
			beforeRoot.dev !== afterRoot.dev ||
			beforeRoot.ino !== afterRoot.ino ||
			!afterRoot.isDirectory() ||
			afterRoot.isSymbolicLink()
		)
			throw new Error("Evidence changed during read");
		const body = bytes.subarray(0, used);
		if (digest(body) !== id || imageMediaType(body) !== item.mediaType)
			throw new Error("Evidence digest or image signature mismatch");
		const retained = await app.attachment(id);
		if (
			retained?.taskId !== taskId ||
			retained.filename !== id ||
			retained.mediaType !== item.mediaType
		)
			throw new Error("Evidence owner changed");
		return {
			id,
			taskId,
			mediaType: item.mediaType,
			caption: item.caption,
			content: body.toString("base64"),
		};
	} finally {
		fs.closeSync(fd);
	}
}
