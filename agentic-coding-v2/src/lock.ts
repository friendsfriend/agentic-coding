import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

/** One local host owns native storage. A lock left by a crashed host records a pid
 * that is provably gone, so the next start reclaims it under a short-lived claim
 * file; a lock whose recorded pid is alive — or unreadable — fails closed. */
type LockRecord = { pid: number; token: string };
const alive = (pid: number) => {
	if (!Number.isSafeInteger(pid) || pid <= 0) return false;
	try {
		process.kill(pid, 0);
		return true;
	} catch (error) {
		// EPERM and anything other than "no such process" stay fail-closed.
		return (error as NodeJS.ErrnoException).code !== "ESRCH";
	}
};
const read = (file: string): LockRecord | null => {
	try {
		const value: unknown = JSON.parse(fs.readFileSync(file, "utf8"));
		if (!value || typeof value !== "object") return null;
		const { pid, token } = value as { pid?: unknown; token?: unknown };
		return Number.isSafeInteger(pid) && typeof token === "string"
			? { pid: pid as number, token }
			: null;
	} catch {
		return null;
	}
};
const locked = (file: string) =>
	new Error(
		`State directory is already locked: ${file}. If the previous host crashed, verify that it has stopped before removing this lock.`,
	);
const create = (file: string, record: LockRecord) => {
	const descriptor = fs.openSync(file, "wx", 0o600);
	try {
		fs.writeFileSync(descriptor, JSON.stringify(record));
		fs.fsyncSync(descriptor);
	} finally {
		fs.closeSync(descriptor);
	}
};

export function acquireLock(stateDir: string): () => void {
	fs.mkdirSync(stateDir, { recursive: true, mode: 0o700 });
	const file = path.join(stateDir, "host.lock");
	const claimFile = `${file}.claim`;
	const token = randomUUID();
	// Every acquisition passes through the claim file, so a reclaimed stale lock can
	// never race a lock another process is creating at the same moment.
	let claim: string | null = null;
	for (let attempt = 0; claim === null; attempt++) {
		const candidate = randomUUID();
		try {
			create(claimFile, { pid: process.pid, token: candidate });
			claim = candidate;
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
			const holder = read(claimFile);
			// A live holder is either starting right now or wedged; either way the
			// state directory is not ours. A dead one is a crash between these steps.
			if (!holder || alive(holder.pid) || attempt >= 1) throw locked(file);
			fs.rmSync(claimFile, { force: true });
		}
	}
	try {
		if (fs.existsSync(file)) {
			const held = read(file);
			// Unreadable ownership is never treated as stale.
			if (!held || alive(held.pid)) throw locked(file);
			fs.rmSync(file, { force: true });
			process.stderr.write(
				`Recovered a stale host lock left by process ${held.pid}.\n`,
			);
		}
		create(file, { pid: process.pid, token });
	} finally {
		if (read(claimFile)?.token === claim) fs.rmSync(claimFile, { force: true });
	}
	return () => {
		if (JSON.parse(fs.readFileSync(file, "utf8")).token !== token)
			throw new Error("Host lock ownership changed");
		fs.unlinkSync(file);
	};
}
