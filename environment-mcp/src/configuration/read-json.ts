import fs from "node:fs";

export const configByteLimit = 256 * 1024;

/** Adapted from v2 environment/definition-file.ts; no config/profile loader. */
export function readConfigurationJson(file: string): unknown {
	const fd = fs.openSync(
		file,
		fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK,
	);
	try {
		const before = fs.fstatSync(fd);
		if (!before.isFile() || before.size > configByteLimit)
			throw new Error("Invalid configuration");
		const bytes = Buffer.alloc(configByteLimit + 1);
		let length = 0;
		while (length < bytes.length) {
			const size = fs.readSync(fd, bytes, length, bytes.length - length, null);
			if (!size) break;
			length += size;
		}
		const after = fs.fstatSync(fd);
		if (
			length > configByteLimit ||
			before.size !== after.size ||
			before.mtimeMs !== after.mtimeMs ||
			before.ctimeMs !== after.ctimeMs
		)
			throw new Error("Configuration changed");
		return JSON.parse(bytes.subarray(0, length).toString("utf8"));
	} finally {
		fs.closeSync(fd);
	}
}
