import { expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { acquireLock } from "../src/lock.ts";

test("only one host may write a state directory; lock cleanup cannot steal another owner's lock", () => {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "v2-owner-"));
	try {
		const release = acquireLock(root);
		expect(() => acquireLock(root)).toThrow("already locked");
		release();
		const again = acquireLock(root);
		fs.writeFileSync(path.join(root, "host.lock"), '{"token":"another"}');
		expect(again).toThrow("ownership changed");
		expect(fs.existsSync(path.join(root, "host.lock"))).toBe(true);
	} finally {
		fs.rmSync(root, { recursive: true, force: true });
	}
});

const deadPid = () => {
	// A pid no live process holds: spawn and reap one.
	const child = Bun.spawnSync(["/bin/echo", "x"]);
	return child.pid ?? 99_999;
};

test("a lock left by a crashed host is recovered, but a live or unreadable one is not", () => {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "v2-stale-"));
	const file = path.join(root, "host.lock");
	const claim = `${file}.claim`;
	try {
		fs.writeFileSync(file, JSON.stringify({ pid: deadPid(), token: "gone" }));
		const release = acquireLock(root);
		expect(JSON.parse(fs.readFileSync(file, "utf8")).pid).toBe(process.pid);
		release();
		expect(fs.existsSync(file)).toBe(false);
		expect(fs.existsSync(claim)).toBe(false);

		// A live owner is never stolen.
		fs.writeFileSync(file, JSON.stringify({ pid: process.pid, token: "live" }));
		expect(() => acquireLock(root)).toThrow("already locked");
		expect(JSON.parse(fs.readFileSync(file, "utf8")).token).toBe("live");

		// Unreadable ownership fails closed rather than being reclaimed.
		for (const body of ['{"token":"only"}', "not json", "{}"])
			fs.writeFileSync(file, body);
		expect(() => acquireLock(root)).toThrow("already locked");
		expect(fs.readFileSync(file, "utf8")).toBe("{}");

		// A claim file left by a crashed start is recovered too.
		fs.rmSync(file, { force: true });
		fs.writeFileSync(claim, JSON.stringify({ pid: deadPid(), token: "gone" }));
		const again = acquireLock(root);
		again();
		expect(fs.existsSync(file)).toBe(false);
		expect(fs.existsSync(claim)).toBe(false);

		// A live claim holder blocks a second start instead of sharing the directory.
		fs.writeFileSync(
			claim,
			JSON.stringify({ pid: process.pid, token: "live" }),
		);
		expect(() => acquireLock(root)).toThrow("already locked");
	} finally {
		fs.rmSync(root, { recursive: true, force: true });
	}
});
