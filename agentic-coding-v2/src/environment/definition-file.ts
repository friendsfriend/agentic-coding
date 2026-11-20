import fs from "node:fs";
import path from "node:path";
import { definitionByteLimit } from "./definition-limits.ts";

/** A bounded data read, not config/profile loading or a native host connection. */
export function readEnvironmentDefinitions(configDir: string): unknown {
	const file = path.join(configDir, "environments.json");
	let fd: number;
	try {
		fd = fs.openSync(
			file,
			fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK,
		);
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT")
			return { version: 1, projects: [] };
		throw error;
	}
	try {
		const before = fs.fstatSync(fd);
		if (!before.isFile() || before.size > definitionByteLimit)
			throw new Error("Invalid definition file");
		const bytes = Buffer.alloc(definitionByteLimit + 1);
		let length = 0;
		while (length < bytes.length) {
			const count = fs.readSync(fd, bytes, length, bytes.length - length, null);
			if (!count) break;
			length += count;
		}
		const after = fs.fstatSync(fd);
		if (
			length > definitionByteLimit ||
			before.size !== after.size ||
			before.mtimeMs !== after.mtimeMs ||
			before.ctimeMs !== after.ctimeMs
		)
			throw new Error("Definition file changed");
		return JSON.parse(bytes.subarray(0, length).toString("utf8"));
	} finally {
		fs.closeSync(fd);
	}
}
