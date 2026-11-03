import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

/** A single local host owns native storage. Stale locks require explicit operator inspection. */
export function acquireLock(stateDir: string): () => void {
	fs.mkdirSync(stateDir, { recursive: true, mode: 0o700 });
	const file = path.join(stateDir, "host.lock");
	const token = randomUUID();
	let descriptor: number;
	try {
		descriptor = fs.openSync(file, "wx", 0o600);
	} catch {
		throw new Error(
			`State directory is already locked: ${file}. If the previous host crashed, verify that it has stopped before removing this lock.`,
		);
	}
	try {
		fs.writeFileSync(descriptor, JSON.stringify({ pid: process.pid, token }));
		fs.fsyncSync(descriptor);
	} finally {
		fs.closeSync(descriptor);
	}
	return () => {
		if (JSON.parse(fs.readFileSync(file, "utf8")).token !== token)
			throw new Error("Host lock ownership changed");
		fs.unlinkSync(file);
	};
}
