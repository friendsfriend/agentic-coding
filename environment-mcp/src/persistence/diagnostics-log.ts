import fs from "node:fs";
import path from "node:path";

const eventNames = new Set(["startup", "capability", "shutdown", "error"]);
const safeCode = /^[a-z][a-z0-9_-]{0,63}$/;
const uuid = /^[a-f0-9-]{36}$/;

export type DiagnosticEvent = {
	at: number;
	event: "startup" | "capability" | "shutdown" | "error";
	action?: string;
	code?: string;
	scope?: string;
	operation?: string;
	count?: number;
};

function sanitize(raw: {
	event: DiagnosticEvent["event"];
	action?: string;
	code?: string;
	scope?: string;
	operation?: string;
	count?: number;
}): DiagnosticEvent {
	return {
		at: Date.now(),
		event: eventNames.has(raw.event) ? raw.event : "error",
		...(raw.action && safeCode.test(raw.action) ? { action: raw.action } : {}),
		...(raw.code && safeCode.test(raw.code) ? { code: raw.code } : {}),
		...(raw.scope && uuid.test(raw.scope) ? { scope: raw.scope } : {}),
		...(raw.operation && uuid.test(raw.operation)
			? { operation: raw.operation }
			: {}),
		...(Number.isSafeInteger(raw.count) && (raw.count ?? -1) >= 0
			? { count: raw.count }
			: {}),
	};
}

/** Private append-only controller diagnostics. This is intentionally separate
 * from operation plans/results and must never carry credentials or free text. */
export function openDiagnosticsLog(
	directory: string,
	options: { maxBytes?: number } = {},
) {
	const file = path.join(directory, "diagnostics.jsonl");
	const maxBytes = options.maxBytes ?? 1024 * 1024;
	if (!Number.isSafeInteger(maxBytes) || maxBytes < 1024)
		throw new Error("Invalid diagnostics bound");
	let fd: number | undefined = open(file);
	let size = fs.fstatSync(fd).size;
	const close = () => {
		if (fd === undefined) return;
		fs.closeSync(fd);
		fd = undefined;
	};
	const rotate = () => {
		close();
		try {
			fs.unlinkSync(`${file}.1`);
		} catch {
			/* No previous segment. */
		}
		fs.renameSync(file, `${file}.1`);
		fd = open(file);
		size = 0;
	};
	if (size > maxBytes) rotate();
	return {
		append(raw: {
			event: DiagnosticEvent["event"];
			action?: string;
			code?: string;
			scope?: string;
			operation?: string;
			count?: number;
		}) {
			try {
				const line = `${JSON.stringify(sanitize(raw))}\n`;
				if (size + Buffer.byteLength(line) > maxBytes) rotate();
				if (fd === undefined) return;
				fs.writeSync(fd, line);
				size += Buffer.byteLength(line);
			} catch {
				// Diagnostics never make a request fail.
			}
		},
		tail(limit = 50) {
			if (!Number.isSafeInteger(limit) || limit < 1 || limit > 200)
				throw new Error("Invalid diagnostics tail");
			let text: string;
			try {
				text = fs.readFileSync(file, "utf8");
			} catch {
				return [];
			}
			return text
				.split("\n")
				.filter(Boolean)
				.slice(-limit)
				.flatMap((line) => {
					try {
						const value = JSON.parse(line) as DiagnosticEvent;
						return typeof value === "object" && value !== null ? [value] : [];
					} catch {
						return [];
					}
				});
		},
		close,
	};
}

function open(file: string) {
	const fd = fs.openSync(
		file,
		fs.constants.O_APPEND |
			fs.constants.O_CREAT |
			fs.constants.O_WRONLY |
			fs.constants.O_NOFOLLOW,
		0o600,
	);
	try {
		const stat = fs.fstatSync(fd);
		if (!stat.isFile() || stat.nlink !== 1 || (stat.mode & 0o077) !== 0)
			throw new Error("Diagnostics log is not private");
		return fd;
	} catch (error) {
		fs.closeSync(fd);
		throw error;
	}
}
